export declare const ANCHOR_VERSION = 1;
export type AnchorBody = {
    v: number;
    issuer: string;
    /**
     * YYYY-MM-DD, UTC
     */
    day: string;
    count: number;
    root: string;
    first_event: number | null;
    last_event: number | null;
    /**
     * id of the previous day's anchor, or 64 zeros
     */
    prev: string;
};
export type Anchor = AnchorBody & {
    id: string;
    sig: string;
};
/** @param {AnchorBody | Anchor} a @returns {AnchorBody} */
export declare function anchorBody(a: AnchorBody | Anchor): AnchorBody;
/**
 * The UTC bounds of a day, in unix seconds: [from, to).
 * @param {string} day
 * @returns {[number, number]}
 */
export declare function dayBounds(day: string): [number, number];
/** @param {number} unix */
export declare function dayOf(unix: number): string;
/** @param {string} day @param {number} n */
export declare function addDays(day: string, n: number): string;
/**
 * Builds and signs the anchor of a day from its receipt leaves.
 * @param {{ day: string, leaves: { id: string, event: number }[], prev: string, issuer: string, secretKey: Uint8Array }} p
 * @returns {Anchor}
 */
export declare function makeAnchor({ day, leaves, prev, issuer, secretKey }: {
    day: string;
    leaves: {
        id: string;
        event: number;
    }[];
    prev: string;
    issuer: string;
    secretKey: Uint8Array;
}): Anchor;
/**
 * Checks an anchor's id and signature. Returns the problems found.
 * @param {Anchor} a
 * @param {string} issuer
 * @returns {string[]}
 */
export declare function checkAnchor(a: Anchor, issuer: string): string[];
/**
 * The Nostr note that publishes an anchor: a kind 1 event by the issuer key,
 * tagged with the anchor id ("x") so verifiers can look it up on relays.
 * @param {Anchor} a
 * @param {string} url where the anchor file is served
 * @param {string} seller e.g. lampo.run
 */
export declare function anchorNote(a: Anchor, url: string, seller: string): {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
};
