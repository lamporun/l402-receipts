// Receipts: one signed statement per debit of a prepaid L402 bundle.
//
// A receipt says which bundle was debited (token id and the payment hash
// that funded it), its position in the bundle's history (seq, and prev, the
// id of the receipt before it), the usage the upstream reported, the rates
// the debit was weighted with, the debit itself and the balance left. The
// id is the SHA-256 of the canonical JSON of every other field, and sig is a
// BIP-340 Schnorr signature of the id by the issuer key, as in Nostr.

import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { canonicalHash } from "./canonical.js";

export const RECEIPT_VERSION = 1;
export const GENESIS = "0".repeat(64);

/** @typedef {"split" | "total" | "estimate" | "plain"} Source */

/**
 * @typedef {object} Usage
 * @property {number} [prompt]
 * @property {number} [cached]
 * @property {number} [completion]
 * @property {number} [total]
 */

/**
 * @typedef {object} Rates
 * @property {number} input_msat_per_ktok
 * @property {number} output_msat_per_ktok
 * @property {number} cached_input_permille
 */

/**
 * @typedef {object} ReceiptBody
 * @property {number} v
 * @property {string} issuer
 * @property {string} token
 * @property {string} payment_hash
 * @property {number} seq
 * @property {number} event
 * @property {number} time
 * @property {string} model
 * @property {number} price_sats
 * @property {Source} source
 * @property {Usage | null} usage
 * @property {Rates | null} rates
 * @property {number} debit
 * @property {number} remaining
 * @property {string} prev
 */

/** @typedef {ReceiptBody & { id: string, sig: string }} Receipt */

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The fields of a receipt that its id covers.
 * @param {ReceiptBody | Receipt} r
 * @returns {ReceiptBody}
 */
export function receiptBody(r) {
	return {
		v: r.v,
		issuer: r.issuer,
		token: r.token,
		payment_hash: r.payment_hash,
		seq: r.seq,
		event: r.event,
		time: r.time,
		model: r.model,
		price_sats: r.price_sats,
		source: r.source,
		usage: r.usage,
		rates: r.rates,
		debit: r.debit,
		remaining: r.remaining,
		prev: r.prev,
	};
}

/** @param {ReceiptBody | Receipt} r */
export function receiptId(r) {
	return canonicalHash(receiptBody(r));
}

/**
 * @param {ReceiptBody} body
 * @param {Uint8Array} secretKey
 * @returns {Receipt}
 */
export function signReceipt(body, secretKey) {
	const id = receiptId(body);
	const sig = bytesToHex(schnorr.sign(hexToBytes(id), secretKey));
	return { ...receiptBody(body), id, sig };
}

/**
 * Checks a receipt's id and signature, and that it was issued by the given
 * key. Returns the problems found, an empty list for a valid receipt.
 * @param {Receipt} r
 * @param {string} issuer x-only public key, hex
 * @returns {string[]}
 */
export function checkSignature(r, issuer) {
	if (r.v !== RECEIPT_VERSION) return [`unsupported receipt version ${r.v}`];
	if (r.issuer !== issuer) return [`issued by ${r.issuer}, expected ${issuer}`];
	if (typeof r.id !== "string" || !HEX64.test(r.id)) return ["malformed id"];
	let id;
	try {
		id = receiptId(r);
	} catch (e) {
		return [`malformed receipt: ${/** @type {Error} */ (e).message}`];
	}
	if (id !== r.id) return ["id does not match the receipt's contents"];
	try {
		if (!schnorr.verify(hexToBytes(r.sig), hexToBytes(r.id), hexToBytes(issuer))) return ["bad signature"];
	} catch {
		return ["bad signature"];
	}
	return [];
}

/**
 * Recomputes a weighted debit the way Aperture's meter does: the usage's
 * value at the bundle's rates, in bundle tokens priced at the blended
 * (input + output) / 2 rate, rounded up.
 * @param {Usage} usage
 * @param {Rates} rates
 */
export function weightedDebit(usage, rates) {
	const prompt = BigInt(usage.prompt ?? 0);
	const cached = BigInt(Math.min(Math.max(usage.cached ?? 0, 0), usage.prompt ?? 0));
	const completion = BigInt(usage.completion ?? 0);
	const input = BigInt(rates.input_msat_per_ktok);
	const output = BigInt(rates.output_msat_per_ktok);
	const permille = BigInt(rates.cached_input_permille);
	const value = (prompt - cached) * input * 1000n + cached * input * permille + completion * output * 1000n;
	const num = value * 2n;
	const den = (input + output) * 1000n;
	if (den <= 0n) throw new RangeError("rates sum to zero");
	return Number((num + den - 1n) / den);
}

/**
 * The debit a receipt's usage implies, or null when the receipt cannot be
 * recomputed (a response that settled at an estimate, or a plain debit).
 * @param {ReceiptBody} r
 */
export function expectedDebit(r) {
	if (r.source === "split" && r.usage) {
		if (r.rates) return weightedDebit(r.usage, r.rates);
		return (r.usage.prompt ?? 0) + (r.usage.completion ?? 0);
	}
	if (r.source === "total" && r.usage) return r.usage.total ?? 0;
	return null;
}

export { HEX64 };
