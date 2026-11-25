// Merkle trees over receipt ids, as in Certificate Transparency (RFC 6962,
// section 2.1): leaves and inner nodes are hashed with different prefixes,
// and a tree of n leaves splits at the largest power of two below n. A daily
// anchor commits to every receipt of the day through the tree's root, and a
// receipt's audit path proves it is one of them.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";

const LEAF = Uint8Array.of(0);
const NODE = Uint8Array.of(1);

/** @param {Uint8Array} data */
const leafHash = (data) => sha256(concatBytes(LEAF, data));
/** @param {Uint8Array} l @param {Uint8Array} r */
const nodeHash = (l, r) => sha256(concatBytes(NODE, l, r));

/** Largest power of two strictly below n, for n > 1. @param {number} n */
function split(n) {
	let k = 1;
	while (k * 2 < n) k *= 2;
	return k;
}

/** @param {Uint8Array[]} leaves @returns {Uint8Array} */
function root(leaves) {
	if (leaves.length === 0) return sha256(new Uint8Array(0));
	if (leaves.length === 1) return leafHash(leaves[0]);
	const k = split(leaves.length);
	return nodeHash(root(leaves.slice(0, k)), root(leaves.slice(k)));
}

/**
 * The root of the tree whose leaves are the given hex ids, in order.
 * @param {string[]} ids
 */
export function merkleRoot(ids) {
	return bytesToHex(root(ids.map((id) => hexToBytes(id))));
}

/**
 * The audit path of leaf m: the sibling hashes from the leaf up to the root.
 * @param {string[]} ids
 * @param {number} m
 * @returns {string[]}
 */
export function auditPath(ids, m) {
	if (!Number.isInteger(m) || m < 0 || m >= ids.length) throw new RangeError("leaf index out of range");
	/** @param {Uint8Array[]} leaves @param {number} i @returns {Uint8Array[]} */
	const path = (leaves, i) => {
		if (leaves.length <= 1) return [];
		const k = split(leaves.length);
		if (i < k) return [...path(leaves.slice(0, k), i), root(leaves.slice(k))];
		return [...path(leaves.slice(k), i - k), root(leaves.slice(0, k))];
	};
	return path(ids.map((id) => hexToBytes(id)), m).map(bytesToHex);
}

/**
 * Checks that the id is leaf `index` of a tree of `size` leaves with the
 * given root (RFC 9162, section 2.1.3.2).
 * @param {string} id
 * @param {number} index
 * @param {number} size
 * @param {string[]} path
 * @param {string} expectedRoot
 */
export function verifyInclusion(id, index, size, path, expectedRoot) {
	if (!Number.isInteger(index) || !Number.isInteger(size) || index < 0 || index >= size) return false;
	let fn = index;
	let sn = size - 1;
	let r = leafHash(hexToBytes(id));
	for (const hex of path) {
		if (sn === 0) return false;
		const p = hexToBytes(hex);
		if (fn % 2 === 1 || fn === sn) {
			r = nodeHash(p, r);
			if (fn % 2 === 0) {
				while (fn % 2 === 0 && fn !== 0) {
					fn >>= 1;
					sn >>= 1;
				}
			}
		} else {
			r = nodeHash(r, p);
		}
		fn >>= 1;
		sn >>= 1;
	}
	return sn === 0 && bytesToHex(r) === expectedRoot;
}
