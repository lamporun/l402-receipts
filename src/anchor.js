// Daily anchors. Once a day the issuer commits to every receipt of the
// previous UTC day: the Merkle root of their ids, in ledger order, signed and
// chained to the day before. The anchor is served as a file, published as a
// Nostr note, and timestamped in Bitcoin through OpenTimestamps. After that a
// receipt can no longer be changed or dropped without breaking either the
// buyer's copy, its audit path, or a public commitment.

import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { canonicalHash } from "./canonical.js";
import { merkleRoot } from "./merkle.js";

export const ANCHOR_VERSION = 1;

/**
 * @typedef {object} AnchorBody
 * @property {number} v
 * @property {string} issuer
 * @property {string} day YYYY-MM-DD, UTC
 * @property {number} count
 * @property {string} root
 * @property {number | null} first_event
 * @property {number | null} last_event
 * @property {string} prev id of the previous day's anchor, or 64 zeros
 */

/** @typedef {AnchorBody & { id: string, sig: string }} Anchor */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** @param {AnchorBody | Anchor} a @returns {AnchorBody} */
export function anchorBody(a) {
	return {
		v: a.v,
		issuer: a.issuer,
		day: a.day,
		count: a.count,
		root: a.root,
		first_event: a.first_event,
		last_event: a.last_event,
		prev: a.prev,
	};
}

/**
 * The UTC bounds of a day, in unix seconds: [from, to).
 * @param {string} day
 * @returns {[number, number]}
 */
export function dayBounds(day) {
	if (!DAY.test(day)) throw new RangeError(`not a day: ${day}`);
	const from = Date.parse(`${day}T00:00:00Z`) / 1000;
	if (!Number.isFinite(from)) throw new RangeError(`not a day: ${day}`);
	return [from, from + 86400];
}

/** @param {number} unix */
export function dayOf(unix) {
	return new Date(unix * 1000).toISOString().slice(0, 10);
}

/** @param {string} day @param {number} n */
export function addDays(day, n) {
	return dayOf(dayBounds(day)[0] + n * 86400);
}

/**
 * Builds and signs the anchor of a day from its receipt leaves.
 * @param {{ day: string, leaves: { id: string, event: number }[], prev: string, issuer: string, secretKey: Uint8Array }} p
 * @returns {Anchor}
 */
export function makeAnchor({ day, leaves, prev, issuer, secretKey }) {
	dayBounds(day);
	/** @type {AnchorBody} */
	const body = {
		v: ANCHOR_VERSION,
		issuer,
		day,
		count: leaves.length,
		root: merkleRoot(leaves.map((l) => l.id)),
		first_event: leaves.length ? leaves[0].event : null,
		last_event: leaves.length ? leaves[leaves.length - 1].event : null,
		prev,
	};
	const id = canonicalHash(body);
	return { ...body, id, sig: bytesToHex(schnorr.sign(hexToBytes(id), secretKey)) };
}

/**
 * Checks an anchor's id and signature. Returns the problems found.
 * @param {Anchor} a
 * @param {string} issuer
 * @returns {string[]}
 */
export function checkAnchor(a, issuer) {
	if (a.v !== ANCHOR_VERSION) return [`unsupported anchor version ${a.v}`];
	if (a.issuer !== issuer) return [`anchor issued by ${a.issuer}, expected ${issuer}`];
	let id;
	try {
		id = canonicalHash(anchorBody(a));
	} catch (e) {
		return [`malformed anchor: ${/** @type {Error} */ (e).message}`];
	}
	if (id !== a.id) return ["anchor id does not match its contents"];
	try {
		if (!schnorr.verify(hexToBytes(a.sig), hexToBytes(a.id), hexToBytes(issuer))) return ["bad anchor signature"];
	} catch {
		return ["bad anchor signature"];
	}
	return [];
}

/**
 * The Nostr note that publishes an anchor: a kind 1 event by the issuer key,
 * tagged with the anchor id ("x") so verifiers can look it up on relays.
 * @param {Anchor} a
 * @param {string} url where the anchor file is served
 * @param {string} seller e.g. lampo.run
 */
export function anchorNote(a, url, seller) {
	return {
		kind: 1,
		created_at: Math.floor(Date.now() / 1000),
		tags: [
			["t", "l402receipts"],
			["x", a.id],
			["r", url],
		],
		content:
			`${seller} usage receipts for ${a.day}: ${a.count} receipt${a.count === 1 ? "" : "s"}, ` +
			`Merkle root ${a.root}.\n\nAnchor ${a.id}\n${url}\n\n` +
			"Every debit of a prepaid L402 bundle gets a signed receipt; this note commits to all of that day's receipts.",
	};
}
