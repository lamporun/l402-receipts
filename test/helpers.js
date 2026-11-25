import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";

/** A temp dir removed at exit. */
export function tempDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l402-receipts-"));
	process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** A fixed issuer key for tests. */
export function testKey(seed = 1) {
	const secretKey = sha256(Uint8Array.of(seed));
	return { secretKey, issuer: bytesToHex(schnorr.getPublicKey(secretKey)) };
}

/**
 * An L402 credential like the ones Aperture mints: a v2 macaroon whose
 * identifier is version 0, the payment hash and the token id.
 * @param {number} seed
 */
export function l402Credential(seed) {
	const preimage = sha256(Uint8Array.of(seed, 0xaa));
	const paymentHash = sha256(preimage);
	const token = sha256(Uint8Array.of(seed, 0xbb));
	const id = concatBytes(Uint8Array.of(0, 0), paymentHash, token);
	const loc = new TextEncoder().encode("aperture");
	const mac = concatBytes(
		Uint8Array.of(2, 1, loc.length),
		loc,
		Uint8Array.of(2, id.length),
		id,
		Uint8Array.of(0, 0, 6, 32),
		sha256(Uint8Array.of(seed, 0xcc)),
	);
	return {
		header: `L402 ${Buffer.from(mac).toString("base64")}:${bytesToHex(preimage)}`,
		token: bytesToHex(token),
		paymentHash: bytesToHex(paymentHash),
		preimage: bytesToHex(preimage),
	};
}

/** The Lightmeter schema, with the usage ledger columns and payment bindings. */
export const LIGHTMETER_SCHEMA = `
CREATE TABLE bundles (
	token_id TEXT PRIMARY KEY, model TEXT NOT NULL, price_sats INTEGER NOT NULL,
	remaining_tokens INTEGER NOT NULL, created_at INTEGER NOT NULL, authorized INTEGER NOT NULL DEFAULT 0);
CREATE TABLE usage_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT, token_id TEXT NOT NULL, model TEXT NOT NULL,
	tokens INTEGER NOT NULL, created_at INTEGER NOT NULL,
	source TEXT, prompt_tokens INTEGER, cached_tokens INTEGER, completion_tokens INTEGER, total_tokens INTEGER,
	input_msat_per_ktok INTEGER, output_msat_per_ktok INTEGER, cached_input_permille INTEGER, remaining_tokens INTEGER);
CREATE TABLE token_payments (token_id TEXT PRIMARY KEY, payment_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
`;

/**
 * A fake Lightmeter database.
 * @param {string} file
 */
export function fakeLightmeter(file) {
	const db = new DatabaseSync(file);
	db.exec(LIGHTMETER_SCHEMA);
	const remaining = new Map();
	return {
		db,
		/** @param {string} token @param {string} paymentHash @param {number} tokens @param {number} priceSats */
		book(token, paymentHash, tokens, priceSats, model = "deepseek-ai/DeepSeek-V4-Flash-0731") {
			db.prepare("INSERT INTO bundles VALUES (?, ?, ?, ?, ?, 1)").run(token, model, priceSats, tokens, 1795600000);
			db.prepare("INSERT INTO token_payments VALUES (?, ?, ?)").run(token, paymentHash, 1795600000);
			remaining.set(token, { tokens, model });
		},
		/**
		 * Appends a ledger row the way Lightmeter's DebitUsage does.
		 * @param {string} token
		 * @param {{ time: number, debit: number, source?: string | null, prompt?: number, cached?: number, completion?: number, total?: number, rates?: [number, number, number] | null }} e
		 */
		debit(token, e) {
			const b = remaining.get(token);
			b.tokens = Math.max(0, b.tokens - e.debit);
			db.prepare("UPDATE bundles SET remaining_tokens = ? WHERE token_id = ?").run(b.tokens, token);
			db.prepare(
				`INSERT INTO usage_events (token_id, model, tokens, created_at, source, prompt_tokens, cached_tokens,
				completion_tokens, total_tokens, input_msat_per_ktok, output_msat_per_ktok, cached_input_permille, remaining_tokens)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				token,
				b.model,
				e.debit,
				e.time,
				e.source === undefined ? "split" : e.source,
				e.prompt ?? null,
				e.cached ?? null,
				e.completion ?? null,
				e.total ?? null,
				e.rates ? e.rates[0] : null,
				e.rates ? e.rates[1] : null,
				e.rates ? e.rates[2] : null,
				b.tokens,
			);
		},
	};
}

export { bytesToHex, hexToBytes };
