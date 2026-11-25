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
export type Leaf = {
    kind: "pending" | "bitcoin" | "other";
    /**
     * offset of the attestation's 0x00 tag
     */
    start: number;
    /**
     * offset just past it
     */
    end: number;
    /**
     * the calendar that will complete a pending one
     */
    uri?: string;
    /**
     * the block of a Bitcoin attestation
     */
    height?: number;
    /**
     * the message attested: for Bitcoin, the block's
     * merkle root as it appears in the header
     */
    msg: Uint8Array;
};
/**
 * Asks the calendars named in each pending attestation for their complete
 * proof, as the ots client's upgrade does, and splices it in place of the
 * attestation. Returns the new state and whether anything changed.
 * @param {OtsState} state
 * @param {{ timeoutMs?: number, fetch?: typeof fetch }} [opts]
 */
export declare function upgrade(state: OtsState, opts?: {
    timeoutMs?: number;
    fetch?: typeof fetch;
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
/**
 * The Bitcoin attestations a stamp has reached: for each, the block height
 * and the merkle root the proof commits to, as block explorers show it. It
 * must equal that block's merkle root.
 * @param {OtsState} state
 * @returns {{ calendar: string, height: number, merkleRoot: string }[]}
 */
export declare function bitcoinAttestations(state: OtsState): {
    calendar: string;
    height: number;
    merkleRoot: string;
}[];
/**
 * Reads a .ots file for the given digest and returns its Bitcoin
 * attestations, as bitcoinAttestations does. Throws when the file is not an
 * OpenTimestamps proof of that SHA-256 digest.
 * @param {Uint8Array} file
 * @param {string} digestHex
 */
export declare function otsFileAttestations(file: Uint8Array, digestHex: string): {
    height: number;
    merkleRoot: string;
}[];
