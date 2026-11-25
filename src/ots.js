// A minimal OpenTimestamps stamper: it commits a 32-byte digest to public
// calendars, which aggregate it into a Bitcoin transaction within hours, and
// writes a standard .ots proof that the `ots` client can upgrade and verify.
//
// Each calendar gets its own branch: the digest with a random nonce appended,
// hashed with SHA-256. Keeping the nonce, the committed digest and the
// calendar's answer per branch lets a later upgrade swap in the calendar's
// complete proof without parsing it.

import { ripemd160, sha1 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
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
const PENDING_ATTESTATION = hexToBytes("83dfe30d2ef90c8e");
const OP_PREPEND = 0xf1;
const ATTESTATION = 0x00;
/** @type {Record<number, (m: Uint8Array) => Uint8Array>} */
const UNARY = { 0x08: sha256, 0x02: sha1, 0x03: ripemd160, 0x67: keccak_256 };

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
 * @param {typeof fetch} [get]
 */
async function fetchBytes(url, init, timeoutMs, get = fetch) {
	const res = await get(url, {
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
 * @param {Uint8Array} buf
 * @param {number} pos
 * @returns {[number, number]}
 */
function readVaruint(buf, pos) {
	let x = 0;
	let shift = 0;
	for (let i = 0; i < 9; i++) {
		if (pos >= buf.length) throw new Error("truncated timestamp");
		const b = buf[pos++];
		x += (b & 0x7f) * 2 ** shift;
		if (b < 0x80) return [x, pos];
		shift += 7;
	}
	throw new Error("varuint too long");
}

/** @param {Uint8Array} a @param {Uint8Array} b */
function equal(a, b) {
	return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * @typedef {object} Leaf
 * @property {"pending" | "bitcoin" | "other"} kind
 * @property {number} start offset of the attestation's 0x00 tag
 * @property {number} end offset just past it
 * @property {string} [uri] the calendar that will complete a pending one
 * @property {number} [height] the block of a Bitcoin attestation
 * @property {Uint8Array} msg the message attested: for Bitcoin, the block's
 *   merkle root as it appears in the header
 */

/**
 * Walks a serialized timestamp of `msg`, the way the ots client reads it,
 * and collects its pending attestations with the message each one commits.
 * @param {Uint8Array} buf
 * @param {number} pos
 * @param {Uint8Array} msg
 * @param {Leaf[]} out
 * @param {number} depth
 * @returns {number} the offset after the timestamp
 */
function walkTimestamp(buf, pos, msg, out, depth = 0) {
	if (depth > 256) throw new Error("timestamp too deep");
	for (;;) {
		if (pos >= buf.length) throw new Error("truncated timestamp");
		let tag = buf[pos++];
		const last = tag !== BRANCH;
		if (!last) tag = buf[pos++];
		pos = walkItem(tag, buf, pos, msg, out, depth);
		if (last) return pos;
	}
}

/**
 * @param {number} tag
 * @param {Uint8Array} buf
 * @param {number} pos offset just after the tag
 * @param {Uint8Array} msg
 * @param {Leaf[]} out
 * @param {number} depth
 */
function walkItem(tag, buf, pos, msg, out, depth) {
	if (tag === ATTESTATION) {
		const start = pos - 1;
		const kind = buf.subarray(pos, pos + 8);
		const [len, p] = readVaruint(buf, pos + 8);
		const payload = buf.subarray(p, p + len);
		if (p + len > buf.length) throw new Error("truncated attestation");
		if (equal(kind, PENDING_ATTESTATION)) {
			const [ulen, up] = readVaruint(payload, 0);
			const uri = new TextDecoder().decode(payload.subarray(up, up + ulen));
			out.push({ kind: "pending", start, end: p + len, uri, msg });
		} else if (equal(kind, BITCOIN_ATTESTATION)) {
			out.push({ kind: "bitcoin", start, end: p + len, height: readVaruint(payload, 0)[0], msg });
		} else {
			out.push({ kind: "other", start, end: p + len, msg });
		}
		return p + len;
	}
	let next;
	if (tag === OP_APPEND || tag === OP_PREPEND) {
		const [len, p] = readVaruint(buf, pos);
		const arg = buf.subarray(p, p + len);
		if (p + len > buf.length) throw new Error("truncated operation");
		next = tag === OP_APPEND ? concatBytes(msg, arg) : concatBytes(arg, msg);
		pos = p + len;
	} else if (UNARY[tag]) {
		next = UNARY[tag](msg);
	} else {
		throw new Error(`unknown timestamp operation 0x${tag.toString(16)}`);
	}
	return walkTimestamp(buf, pos, next, out, depth + 1);
}

/**
 * Asks the calendars named in each pending attestation for their complete
 * proof, as the ots client's upgrade does, and splices it in place of the
 * attestation. Returns the new state and whether anything changed.
 * @param {OtsState} state
 * @param {{ timeoutMs?: number, fetch?: typeof fetch }} [opts]
 */
export async function upgrade(state, opts = {}) {
	const get = opts.fetch ?? fetch;
	let changed = false;
	const branches = await Promise.all(
		state.branches.map(async (b) => {
			if (b.complete) return b;
			try {
				let answer = hexToBytes(b.answer);
				/** @type {Leaf[]} */
				const leaves = [];
				walkTimestamp(answer, 0, hexToBytes(b.commitment), leaves);
				const pending = leaves.filter((l) => l.kind === "pending" && l.uri);
				// Later offsets first, so earlier ones stay valid.
				for (const leaf of pending.sort((x, y) => y.start - x.start)) {
					if (!leaf.uri || !/^https:\/\/[a-z0-9.-]+(:\d+)?(\/[\w./-]*)?$/i.test(leaf.uri)) continue;
					let upgraded;
					try {
						upgraded = await fetchBytes(`${leaf.uri.replace(/\/$/, "")}/timestamp/${bytesToHex(leaf.msg)}`, { method: "GET" }, opts.timeoutMs ?? 15000, get);
					} catch {
						continue;
					}
					if (!contains(upgraded, BITCOIN_ATTESTATION) || upgraded[0] === BRANCH) continue;
					// The answer must itself be a valid timestamp of that message.
					walkTimestamp(upgraded, 0, leaf.msg, []);
					answer = concatBytes(answer.subarray(0, leaf.start), upgraded, answer.subarray(leaf.end));
				}
				if (!contains(answer, BITCOIN_ATTESTATION)) return b;
				walkTimestamp(answer, 0, hexToBytes(b.commitment), []);
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

/**
 * The Bitcoin attestations a stamp has reached: for each, the block height
 * and the merkle root the proof commits to, as block explorers show it. It
 * must equal that block's merkle root.
 * @param {OtsState} state
 * @returns {{ calendar: string, height: number, merkleRoot: string }[]}
 */
export function bitcoinAttestations(state) {
	/** @type {{ calendar: string, height: number, merkleRoot: string }[]} */
	const out = [];
	for (const b of state.branches) {
		/** @type {Leaf[]} */
		const leaves = [];
		try {
			walkTimestamp(hexToBytes(b.answer), 0, hexToBytes(b.commitment), leaves);
		} catch {
			continue;
		}
		for (const l of leaves) {
			// Explorers show the root byte-reversed, like block hashes.
			if (l.kind === "bitcoin") out.push({ calendar: b.calendar, height: /** @type {number} */ (l.height), merkleRoot: bytesToHex(l.msg.slice().reverse()) });
		}
	}
	return out;
}

/**
 * Reads a .ots file for the given digest and returns its Bitcoin
 * attestations, as bitcoinAttestations does. Throws when the file is not an
 * OpenTimestamps proof of that SHA-256 digest.
 * @param {Uint8Array} file
 * @param {string} digestHex
 */
export function otsFileAttestations(file, digestHex) {
	const head = MAGIC.length;
	if (!equal(file.subarray(0, head), MAGIC) || file[head] !== 1 || file[head + 1] !== OP_SHA256) {
		throw new Error("not an OpenTimestamps SHA-256 proof");
	}
	const digest = file.subarray(head + 2, head + 34);
	if (bytesToHex(digest) !== digestHex) throw new Error("the proof is for another digest");
	/** @type {Leaf[]} */
	const leaves = [];
	walkTimestamp(file, head + 34, digest, leaves);
	return leaves
		.filter((l) => l.kind === "bitcoin")
		.map((l) => ({ height: /** @type {number} */ (l.height), merkleRoot: bytesToHex(l.msg.slice().reverse()) }));
}
