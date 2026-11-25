// The buyer authenticates a receipt request with the credential it already
// pays with: an L402 macaroon and preimage, or an MPP charge credential.
// Only the payer knows the preimage, so the receipts of a bundle are only
// readable by whoever paid for it.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

/**
 * @typedef {object} Credential
 * @property {"l402" | "mpp"} scheme
 * @property {string} token the metered token id, hex
 * @property {string} paymentHash hex
 * @property {string} preimage hex
 */

const HEX64 = /^[0-9a-f]{64}$/i;

/**
 * Reads a varint from a macaroon v2 buffer.
 * @param {Uint8Array} buf
 * @param {number} pos
 * @returns {[number, number]}
 */
function uvarint(buf, pos) {
	let x = 0;
	let s = 0;
	for (let i = 0; i < 5; i++) {
		if (pos >= buf.length) throw new Error("truncated varint");
		const b = buf[pos++];
		x += (b & 0x7f) * 2 ** s;
		if (b < 0x80) return [x, pos];
		s += 7;
	}
	throw new Error("varint too long");
}

/**
 * The identifier of a binary (v2) macaroon.
 * @param {Uint8Array} mac
 */
export function macaroonIdentifier(mac) {
	if (mac[0] !== 2) throw new Error("not a v2 macaroon");
	let pos = 1;
	while (pos < mac.length) {
		let type;
		[type, pos] = uvarint(mac, pos);
		if (type === 0) break;
		let len;
		[len, pos] = uvarint(mac, pos);
		if (pos + len > mac.length) throw new Error("truncated macaroon field");
		if (type === 2) return mac.subarray(pos, pos + len);
		pos += len;
	}
	throw new Error("macaroon has no identifier");
}

/**
 * Splits an L402 identifier: version (uint16), payment hash, token id.
 * @param {Uint8Array} id
 */
export function decodeIdentifier(id) {
	if (id.length !== 66) throw new Error(`identifier of ${id.length} bytes, expected 66`);
	const version = (id[0] << 8) | id[1];
	if (version !== 0) throw new Error(`unknown identifier version ${version}`);
	return { paymentHash: bytesToHex(id.subarray(2, 34)), token: bytesToHex(id.subarray(34, 66)) };
}

/** @param {string} s */
function base64ToBytes(s) {
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
	return new Uint8Array(Buffer.from(b64, "base64"));
}

/**
 * Parses an Authorization header value into a credential and checks that the
 * preimage pays the payment hash. Throws on anything else.
 * @param {string} header
 * @returns {Credential}
 */
export function parseCredential(header) {
	const value = String(header || "").trim();
	const l402 = /^(L402|LSAT)\s+([A-Za-z0-9+/_=-]+):([0-9a-fA-F]{64})$/i.exec(value);
	if (l402) {
		const { paymentHash, token } = decodeIdentifier(macaroonIdentifier(base64ToBytes(l402[2])));
		const preimage = l402[3].toLowerCase();
		if (bytesToHex(sha256(hexToBytes(preimage))) !== paymentHash) throw new Error("the preimage does not pay this macaroon");
		return { scheme: "l402", token, paymentHash, preimage };
	}
	const mpp = /^Payment\s+([A-Za-z0-9+/_=-]+)$/i.exec(value);
	if (mpp) {
		let payload;
		try {
			payload = JSON.parse(Buffer.from(base64ToBytes(mpp[1])).toString("utf8"));
		} catch {
			throw new Error("unreadable payment credential");
		}
		const preimage = String(payload?.payload?.preimage ?? "").toLowerCase();
		if (!HEX64.test(preimage)) throw new Error("payment credential has no preimage");
		const paymentHash = bytesToHex(sha256(hexToBytes(preimage)));
		return { scheme: "mpp", token: paymentHash, paymentHash, preimage };
	}
	throw new Error("expected an L402 or Payment credential");
}
