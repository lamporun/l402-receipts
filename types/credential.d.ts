export type Credential = {
    scheme: "l402" | "mpp";
    /**
     * the metered token id, hex
     */
    token: string;
    /**
     * hex
     */
    paymentHash: string;
    /**
     * hex
     */
    preimage: string;
};
/**
 * The identifier of a binary (v2) macaroon.
 * @param {Uint8Array} mac
 */
export declare function macaroonIdentifier(mac: Uint8Array): Uint8Array<ArrayBufferLike>;
/**
 * Splits an L402 identifier: version (uint16), payment hash, token id.
 * @param {Uint8Array} id
 */
export declare function decodeIdentifier(id: Uint8Array): {
    paymentHash: string;
    token: string;
};
/**
 * Parses an Authorization header value into a credential and checks that the
 * preimage pays the payment hash. Throws on anything else.
 * @param {string} header
 * @returns {Credential}
 */
export declare function parseCredential(header: string): Credential;
