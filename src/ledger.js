// Builds receipts from a Lightmeter database (read-only). Every row of the
// usage ledger becomes one receipt; a bundle's receipts are chained in ledger
// order, so the same rows always give the same receipt ids.
//
// Receipts need the ledger columns and payment bindings that Lightmeter adds
// when its store implements meterd.UsageLedger. A bundle with a row written
// before that has no receipts: its history cannot be fully explained.

import { DatabaseSync } from "node:sqlite";
import { GENESIS, RECEIPT_VERSION, receiptId, signReceipt } from "./receipt.js";

/** @typedef {import("./receipt.js").Receipt} Receipt */
/** @typedef {import("./receipt.js").ReceiptBody} ReceiptBody */

/**
 * @typedef {object} LedgerRow
 * @property {number} id
 * @property {string} token_id
 * @property {string} model
 * @property {number} tokens
 * @property {number} created_at
 * @property {number | null} remaining_tokens
 * @property {string | null} source
 * @property {number | null} prompt_tokens
 * @property {number | null} cached_tokens
 * @property {number | null} completion_tokens
 * @property {number | null} total_tokens
 * @property {number | null} input_msat_per_ktok
 * @property {number | null} output_msat_per_ktok
 * @property {number | null} cached_input_permille
 * @property {number} price_sats
 * @property {string | null} payment_hash
 */

const COLUMNS = `e.id, e.token_id, e.model, e.tokens, e.created_at, e.remaining_tokens, e.source,
	e.prompt_tokens, e.cached_tokens, e.completion_tokens, e.total_tokens,
	e.input_msat_per_ktok, e.output_msat_per_ktok, e.cached_input_permille,
	b.price_sats, p.payment_hash`;
const FROM = `FROM usage_events e JOIN bundles b ON b.token_id = e.token_id
	LEFT JOIN token_payments p ON p.token_id = e.token_id`;

/**
 * The receipt body for one ledger row.
 * @param {LedgerRow} row
 * @param {number} seq
 * @param {string} prev
 * @param {string} issuer
 * @returns {ReceiptBody}
 */
export function rowToBody(row, seq, prev, issuer) {
	/** @type {import("./receipt.js").Source} */
	let source = "plain";
	/** @type {import("./receipt.js").Usage | null} */
	let usage = null;
	/** @type {import("./receipt.js").Rates | null} */
	let rates = null;
	if (row.source === "split") {
		source = "split";
		usage = { prompt: row.prompt_tokens ?? 0, cached: row.cached_tokens ?? 0, completion: row.completion_tokens ?? 0 };
		if (row.input_msat_per_ktok != null && row.output_msat_per_ktok != null) {
			rates = {
				input_msat_per_ktok: row.input_msat_per_ktok,
				output_msat_per_ktok: row.output_msat_per_ktok,
				cached_input_permille: row.cached_input_permille ?? 1000,
			};
		}
	} else if (row.source === "total") {
		source = "total";
		usage = { total: row.total_tokens ?? 0 };
	} else if (row.source === "estimate") {
		source = "estimate";
	}
	return {
		v: RECEIPT_VERSION,
		issuer,
		token: row.token_id,
		payment_hash: /** @type {string} */ (row.payment_hash),
		seq,
		event: row.id,
		time: row.created_at,
		model: row.model,
		price_sats: row.price_sats,
		source,
		usage,
		rates,
		debit: row.tokens,
		remaining: /** @type {number} */ (row.remaining_tokens),
		prev,
	};
}

export class Ledger {
	/**
	 * @param {string} path Lightmeter's sqlite database
	 * @param {{ issuer: string, secretKey: Uint8Array }} key
	 */
	constructor(path, key) {
		this.db = new DatabaseSync(path, { readOnly: true });
		this.db.exec("PRAGMA busy_timeout = 5000");
		this.issuer = key.issuer;
		this.secretKey = key.secretKey;
		this.byToken = this.db.prepare(`SELECT ${COLUMNS} ${FROM} WHERE e.token_id = ? ORDER BY e.id`);
		this.tokensOnDay = this.db.prepare(
			`SELECT DISTINCT e.token_id FROM usage_events e WHERE e.created_at >= ? AND e.created_at < ?`,
		);
		this.payment = this.db.prepare(`SELECT payment_hash FROM token_payments WHERE token_id = ?`);
		this.firstDay = this.db.prepare(`SELECT MIN(e.created_at) AS t FROM usage_events e WHERE e.remaining_tokens IS NOT NULL`);
	}

	close() {
		this.db.close();
	}

	/** @param {string} token */
	paymentHash(token) {
		const row = /** @type {{ payment_hash: string } | undefined} */ (this.payment.get(token));
		return row ? row.payment_hash : null;
	}

	/**
	 * The unsigned receipt bodies of a bundle, oldest first, or null when the
	 * bundle's history predates receipts or has no payment binding.
	 * @param {string} token
	 * @returns {ReceiptBody[] | null}
	 */
	bodies(token) {
		const rows = /** @type {LedgerRow[]} */ (/** @type {unknown} */ (this.byToken.all(token)));
		if (rows.length === 0) return [];
		if (rows.some((r) => r.remaining_tokens == null || r.payment_hash == null)) return null;
		/** @type {ReceiptBody[]} */
		const out = [];
		let prev = GENESIS;
		for (const [i, row] of rows.entries()) {
			const body = rowToBody(row, i + 1, prev, this.issuer);
			prev = receiptId(body);
			out.push(body);
		}
		return out;
	}

	/**
	 * The signed receipts of a bundle, oldest first; null as for bodies.
	 * @param {string} token
	 * @returns {Receipt[] | null}
	 */
	receipts(token) {
		const bodies = this.bodies(token);
		if (bodies === null) return null;
		return bodies.map((b) => signReceipt(b, this.secretKey));
	}

	/**
	 * The ids of every receipt with a time in [from, to), ordered by ledger
	 * event: the leaves of that period's anchor.
	 * @param {number} from unix seconds
	 * @param {number} to unix seconds
	 * @returns {{ id: string, event: number, token: string, seq: number }[]}
	 */
	idsBetween(from, to) {
		const tokens = /** @type {{ token_id: string }[]} */ (/** @type {unknown} */ (this.tokensOnDay.all(from, to)));
		/** @type {{ id: string, event: number, token: string, seq: number }[]} */
		const out = [];
		for (const { token_id } of tokens) {
			const list = this.bodies(token_id);
			if (!list) continue;
			for (const b of list) if (b.time >= from && b.time < to) out.push({ id: receiptId(b), event: b.event, token: b.token, seq: b.seq });
		}
		return out.sort((a, b) => a.event - b.event);
	}

	/** Unix time of the first receipt, or null. */
	firstReceiptTime() {
		const row = /** @type {{ t: number | null } | undefined} */ (this.firstDay.get());
		return row?.t ?? null;
	}
}
