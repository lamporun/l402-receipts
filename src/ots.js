// A minimal OpenTimestamps stamper: it commits a 32-byte digest to public
// calendars, which aggregate it into a Bitcoin transaction within hours, and
// writes a standard .ots proof that the `ots` client can upgrade and verify.
//
// Each calendar gets its own branch: the digest with a random nonce appended,
// hashed with SHA-256. Keeping the nonce, the committed digest and the
// calendar's answer per branch lets a later upgrade swap in the calendar's
// complete proof without parsing it.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, randomBytes } from "@noble/hashes/utils.js";

export const CALENDARS = [
	"https://a.pool.opentimestamps.org",
	"https://b.pool.opentimestamps.org",
	"https://a.pool.eternitywall.com",
];

const MAGIC = hexToBytes("004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294");
const OP_SHA256 = 0x08;
const OP_APPEND = 0xf0;
const BRANCH = 0xff;
const BITCOIN_ATTESTATION = hexToBytes("0588960d73d71901");

/**
 * @typedef {object} OtsBranch
 * @property {string} calendar
 * @property {string} nonce hex
 * @property {string} commitment hex, the digest the calendar committed to
 * @property {string} answer hex, the calendar's timestamp of the commitment
 * @property {boolean} complete whether the answer carries a Bitcoin attestation
 */

/**
 * @typedef {object} OtsState
 * @property {string} digest hex
 * @property {OtsBranch[]} branches
 */

/** @param {number} n */
function varuint(n) {
	const out = [];
	do {
		let b = n & 0x7f;
		n = Math.floor(n / 128);
		if (n > 0) b |= 0x80;
		out.push(b);
	} while (n > 0);
	return Uint8Array.from(out);
}

/** @param {Uint8Array} haystack @param {Uint8Array} needle */
function contains(haystack, needle) {
	outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
		for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
		return true;
	}
	return false;
}

/**
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} timeoutMs
 */
async function fetchBytes(url, init, timeoutMs) {
	const res = await fetch(url, {
		...init,
		redirect: "error",
		signal: AbortSignal.timeout(timeoutMs),
		headers: { Accept: "application/vnd.opentimestamps.v1", "User-Agent": "l402-receipts", ...(init.headers || {}) },
	});
	if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
	const body = new Uint8Array(await res.arrayBuffer());
	if (body.length === 0 || body.length > 10000) throw new Error(`${url}: unexpected answer of ${body.length} bytes`);
	return body;
}

/**
 * Submits the digest to the calendars. Resolves with the branches of every
 * calendar that answered; throws when none did.
 * @param {string} digestHex
 * @param {{ calendars?: string[], timeoutMs?: number }} [opts]
 * @returns {Promise<OtsState>}
 */
export async function stamp(digestHex, opts = {}) {
	const digest = hexToBytes(digestHex);
	const calendars = opts.calendars ?? CALENDARS;
	const results = await Promise.allSettled(
		calendars.map(async (calendar) => {
			const nonce = randomBytes(16);
			const commitment = sha256(concatBytes(digest, nonce));
			const answer = await fetchBytes(
				`${calendar}/digest`,
				{ method: "POST", body: new Uint8Array(commitment), headers: { "Content-Type": "application/x-www-form-urlencoded" } },
				opts.timeoutMs ?? 15000,
			);
			return {
				calendar,
				nonce: bytesToHex(nonce),
				commitment: bytesToHex(commitment),
				answer: bytesToHex(answer),
				complete: contains(answer, BITCOIN_ATTESTATION),
			};
		}),
	);
	const branches = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
	if (branches.length === 0) {
		const reasons = results.map((r) => (r.status === "rejected" ? String(r.reason?.message ?? r.reason) : "")).join("; ");
		throw new Error(`no calendar accepted the digest: ${reasons}`);
	}
	return { digest: digestHex, branches };
}

/**
 * Asks each pending calendar for its complete proof. Returns the state with
 * the branches that are now anchored in Bitcoin, and whether anything changed.
 * @param {OtsState} state
 * @param {{ timeoutMs?: number }} [opts]
 */
export async function upgrade(state, opts = {}) {
	let changed = false;
	const branches = await Promise.all(
		state.branches.map(async (b) => {
			if (b.complete) return b;
			try {
				const answer = await fetchBytes(`${b.calendar}/timestamp/${b.commitment}`, { method: "GET" }, opts.timeoutMs ?? 15000);
				if (!contains(answer, BITCOIN_ATTESTATION)) return b;
				changed = true;
				return { ...b, answer: bytesToHex(answer), complete: true };
			} catch {
				return b;
			}
		}),
	);
	return { state: { ...state, branches }, changed };
}

/**
 * The .ots file for a stamp: the header, the digest, and one branch per
 * calendar (append nonce, SHA-256, then the calendar's answer).
 * @param {OtsState} state
 */
export function otsFile(state) {
	/** @type {Uint8Array[]} */
	const parts = [MAGIC, varuint(1), Uint8Array.of(OP_SHA256), hexToBytes(state.digest)];
	state.branches.forEach((b, i) => {
		const nonce = hexToBytes(b.nonce);
		if (i < state.branches.length - 1) parts.push(Uint8Array.of(BRANCH));
		parts.push(Uint8Array.of(OP_APPEND), varuint(nonce.length), nonce, Uint8Array.of(OP_SHA256), hexToBytes(b.answer));
	});
	return concatBytes(...parts);
}
