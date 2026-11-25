// Buyer-side verification of a bundle's receipts.
//
// checkChain needs nothing but the receipts and the issuer key: it checks
// every signature, that the receipts form one unbroken history of the bundle
// the credential paid for, that each balance follows from the one before,
// and that each debit is what its usage costs at its rates. verifyBundle
// fetches the receipts from the seller and also checks the audit paths into
// the daily anchors, and optionally that each anchor was published on Nostr.

import { checkAnchor } from "./anchor.js";
import { parseCredential } from "./credential.js";
import { verifyInclusion } from "./merkle.js";
import { checkSignature, expectedDebit, GENESIS } from "./receipt.js";

/** @typedef {import("./receipt.js").Receipt} Receipt */
/** @typedef {import("./anchor.js").Anchor} Anchor */

/**
 * @typedef {object} ChainReport
 * @property {boolean} ok
 * @property {string[]} problems
 * @property {number} receipts
 * @property {number} recomputed debits recomputed exactly from usage and rates
 * @property {number} estimated debits settled at an estimate (no usage reported)
 * @property {number} debited bundle tokens debited in total
 * @property {number | null} initialTokens the bundle's size, from the first receipt
 * @property {number | null} remaining the balance after the last receipt
 * @property {{ prompt: number, cached: number, completion: number }} usage
 */

/**
 * @param {Receipt[]} receipts
 * @param {object} o
 * @param {string} o.issuer
 * @param {{ token: string, paymentHash: string }} [o.credential]
 * @param {Receipt} [o.previous] the last receipt already verified, to continue from
 * @returns {ChainReport}
 */
export function checkChain(receipts, { issuer, credential, previous }) {
	/** @type {string[]} */
	const problems = [];
	const list = [...receipts].sort((a, b) => a.seq - b.seq);
	const report = {
		ok: false,
		problems,
		receipts: list.length,
		recomputed: 0,
		estimated: 0,
		debited: 0,
		initialTokens: /** @type {number | null} */ (null),
		remaining: previous ? previous.remaining : /** @type {number | null} */ (null),
		usage: { prompt: 0, cached: 0, completion: 0 },
	};

	let prev = previous ?? null;
	for (const r of list) {
		const at = `receipt ${r.seq}`;
		for (const p of checkSignature(r, issuer)) problems.push(`${at}: ${p}`);
		if (credential && (r.token !== credential.token || r.payment_hash !== credential.paymentHash)) {
			problems.push(`${at}: belongs to another bundle`);
		}
		if (prev) {
			if (r.token !== prev.token || r.payment_hash !== prev.payment_hash) problems.push(`${at}: changes bundle mid-history`);
			if (r.seq !== prev.seq + 1) problems.push(`${at}: follows receipt ${prev.seq}, a receipt is missing`);
			if (r.prev !== prev.id) problems.push(`${at}: does not chain to receipt ${prev.seq}`);
			if (r.event <= prev.event) problems.push(`${at}: out of ledger order`);
			const want = Math.max(0, prev.remaining - r.debit);
			if (r.remaining !== want) problems.push(`${at}: balance ${r.remaining}, expected ${prev.remaining} - ${r.debit} = ${want}`);
		} else {
			if (r.seq !== 1) problems.push(`${at}: the history does not start at receipt 1`);
			if (r.prev !== GENESIS) problems.push(`${at}: the first receipt must not chain to another`);
			if (r.remaining > 0) report.initialTokens = r.remaining + r.debit;
		}
		if (!Number.isSafeInteger(r.debit) || r.debit < 0) problems.push(`${at}: invalid debit`);

		const want = expectedDebit(r);
		if (want === null) {
			if (r.source === "estimate") report.estimated += 1;
		} else if (want === r.debit) {
			report.recomputed += 1;
		} else {
			problems.push(`${at}: debited ${r.debit} tokens, its usage at its rates costs ${want}`);
		}
		if (r.source === "split" && r.usage) {
			report.usage.prompt += r.usage.prompt ?? 0;
			report.usage.cached += r.usage.cached ?? 0;
			report.usage.completion += r.usage.completion ?? 0;
		}
		report.debited += r.debit;
		report.remaining = r.remaining;
		prev = r;
	}
	report.ok = problems.length === 0;
	return report;
}

/**
 * @typedef {object} BundleReport
 * @property {boolean} ok
 * @property {string} seller
 * @property {string} issuer
 * @property {ChainReport} chain
 * @property {number} anchored receipts proven to be in a daily anchor
 * @property {number} onNostr anchors found on Nostr relays
 * @property {string[]} problems
 * @property {Receipt[]} receipts
 */

/**
 * Looks an anchor note up on relays.
 * @param {string} issuer
 * @param {string} anchorId
 * @param {string[]} relays
 */
async function findAnchorNote(issuer, anchorId, relays) {
	const { SimplePool } = await import("nostr-tools/pool");
	const { verifyEvent } = await import("nostr-tools/pure");
	const pool = new SimplePool();
	try {
		const events = await pool.querySync(relays, { authors: [issuer], kinds: [1], "#x": [anchorId] }, { maxWait: 5000 });
		return events.some((e) => verifyEvent(e) && e.pubkey === issuer && e.tags.some((t) => t[0] === "x" && t[1] === anchorId));
	} finally {
		pool.close(relays);
	}
}

/**
 * Fetches and verifies the receipts of the bundle a credential paid for.
 * @param {object} o
 * @param {string} o.seller the seller's origin, e.g. https://lampo.run
 * @param {string} o.credential the Authorization header value used to pay
 * @param {string} [o.issuer] the issuer key to require; defaults to the seller's published one
 * @param {boolean} [o.checkNostr]
 * @param {Receipt[]} [o.known] receipts saved earlier, which must not have changed
 * @param {typeof fetch} [o.fetch]
 * @returns {Promise<BundleReport>}
 */
export async function verifyBundle(o) {
	const fetchImpl = o.fetch ?? fetch;
	const origin = new URL(o.seller).origin;
	const cred = parseCredential(o.credential);
	/** @param {string} url @param {RequestInit} [init] */
	const getJson = async (url, init) => {
		const res = await fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(20000) });
		const body = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(`${url}: ${body.error || `HTTP ${res.status}`}`);
		return body;
	};

	const wk = await getJson(`${origin}/.well-known/l402-receipts.json`);
	const issuer = o.issuer ?? wk.issuer;
	/** @type {string[]} */
	const problems = [];
	if (wk.issuer !== issuer) problems.push(`the seller now publishes issuer ${wk.issuer}, expected ${issuer}`);
	const receiptsUrl = new URL(wk.receipts);
	if (receiptsUrl.origin !== origin) throw new Error(`receipts are served from another origin: ${receiptsUrl.origin}`);

	const body = await getJson(receiptsUrl.href, { headers: { Authorization: o.credential } });
	/** @type {Receipt[]} */
	const receipts = body.receipts ?? [];
	const chain = checkChain(receipts, { issuer, credential: cred });
	problems.push(...chain.problems);

	for (const k of o.known ?? []) {
		const now = receipts.find((r) => r.seq === k.seq);
		if (!now) problems.push(`receipt ${k.seq}: you saved it earlier, the seller no longer serves it`);
		else if (now.id !== k.id) problems.push(`receipt ${k.seq}: changed since you saved it`);
	}

	/** @type {Set<string>} */
	let anchoredDays = new Set();
	try {
		const index = await getJson(`${origin}/receipts/anchors/`);
		anchoredDays = new Set((index.anchors ?? []).filter(Boolean).map((/** @type {{ day: string }} */ x) => x.day));
	} catch (e) {
		problems.push(`anchor index: ${/** @type {Error} */ (e).message}`);
	}

	/** @type {Map<string, Anchor | null>} */
	const anchors = new Map();
	let anchored = 0;
	let onNostr = 0;
	for (const r of receipts) {
		const proof = body.proofs?.[r.seq];
		if (!proof) {
			const day = new Date(r.time * 1000).toISOString().slice(0, 10);
			if (anchoredDays.has(day)) problems.push(`receipt ${r.seq}: its day ${day} is anchored, but the seller gives no proof that it is included`);
			continue;
		}
		if (!anchors.has(proof.day)) {
			try {
				const a = await getJson(`${origin}/receipts/anchors/${proof.day}.json`);
				const issues = checkAnchor(a, issuer);
				if (issues.length) problems.push(...issues.map((p) => `anchor ${proof.day}: ${p}`));
				anchors.set(proof.day, issues.length ? null : a);
				if (!issues.length && o.checkNostr && Array.isArray(wk.relays) && wk.relays.length) {
					if (await findAnchorNote(issuer, a.id, wk.relays).catch(() => false)) onNostr += 1;
					else problems.push(`anchor ${proof.day}: not found on the seller's Nostr relays`);
				}
			} catch (e) {
				problems.push(`anchor ${proof.day}: ${/** @type {Error} */ (e).message}`);
				anchors.set(proof.day, null);
			}
		}
		const a = anchors.get(proof.day);
		if (!a) continue;
		if (proof.anchor !== a.id || proof.size !== a.count || !verifyInclusion(r.id, proof.index, proof.size, proof.path, a.root)) {
			problems.push(`receipt ${r.seq}: not included in the anchor of ${proof.day}`);
		} else {
			anchored += 1;
		}
	}

	return { ok: problems.length === 0, seller: origin, issuer, chain, anchored, onNostr, problems, receipts };
}
