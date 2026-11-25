// Canonical JSON for receipts and anchors: object keys sorted, no whitespace,
// and only the values receipts use (strings, safe integers, booleans, null,
// arrays and plain objects). For this subset the output is the same as the
// JSON Canonicalization Scheme (RFC 8785), so any JCS library can reproduce
// a receipt's id.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/**
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalize(value) {
	if (value === null || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value)) throw new TypeError(`not a safe integer: ${value}`);
		return String(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
		const obj = /** @type {Record<string, unknown>} */ (value);
		const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
	}
	throw new TypeError(`value not allowed in canonical JSON: ${typeof value}`);
}

/**
 * The hex SHA-256 of a value's canonical JSON.
 * @param {unknown} value
 */
export function canonicalHash(value) {
	return bytesToHex(sha256(utf8ToBytes(canonicalize(value))));
}
