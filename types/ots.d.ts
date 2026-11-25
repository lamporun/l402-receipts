export declare const CALENDARS: string[];
export type OtsBranch = {
    calendar: string;
    /**
     * hex
     */
    nonce: string;
    /**
     * hex, the digest the calendar committed to
     */
    commitment: string;
    /**
     * hex, the calendar's timestamp of the commitment
     */
    answer: string;
    /**
     * whether the answer carries a Bitcoin attestation
     */
    complete: boolean;
};
export type OtsState = {
    /**
     * hex
     */
    digest: string;
    branches: OtsBranch[];
};
/**
 * Submits the digest to the calendars. Resolves with the branches of every
 * calendar that answered; throws when none did.
 * @param {string} digestHex
 * @param {{ calendars?: string[], timeoutMs?: number }} [opts]
 * @returns {Promise<OtsState>}
 */
export declare function stamp(digestHex: string, opts?: {
    calendars?: string[];
    timeoutMs?: number;
}): Promise<OtsState>;
/**
 * Asks each pending calendar for its complete proof. Returns the state with
 * the branches that are now anchored in Bitcoin, and whether anything changed.
 * @param {OtsState} state
 * @param {{ timeoutMs?: number }} [opts]
 */
export declare function upgrade(state: OtsState, opts?: {
    timeoutMs?: number;
}): Promise<{
    state: {
        digest: string;
        branches: OtsBranch[];
    };
    changed: boolean;
}>;
/**
 * The .ots file for a stamp: the header, the digest, and one branch per
 * calendar (append nonce, SHA-256, then the calendar's answer).
 * @param {OtsState} state
 */
export declare function otsFile(state: OtsState): Uint8Array<ArrayBufferLike>;
