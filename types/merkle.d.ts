/**
 * The root of the tree whose leaves are the given hex ids, in order.
 * @param {string[]} ids
 */
export declare function merkleRoot(ids: string[]): string;
/**
 * The audit path of leaf m: the sibling hashes from the leaf up to the root.
 * @param {string[]} ids
 * @param {number} m
 * @returns {string[]}
 */
export declare function auditPath(ids: string[], m: number): string[];
/**
 * Checks that the id is leaf `index` of a tree of `size` leaves with the
 * given root (RFC 9162, section 2.1.3.2).
 * @param {string} id
 * @param {number} index
 * @param {number} size
 * @param {string[]} path
 * @param {string} expectedRoot
 */
export declare function verifyInclusion(id: string, index: number, size: number, path: string[], expectedRoot: string): boolean;
