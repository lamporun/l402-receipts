export type Receipt = import("./receipt.js").Receipt;
export type Anchor = import("./anchor.js").Anchor;
export type ChainReport = {
    ok: boolean;
    problems: string[];
    receipts: number;
    /**
     * debits recomputed exactly from usage and rates
     */
    recomputed: number;
    /**
     * debits settled at an estimate (no usage reported)
     */
    estimated: number;
    /**
     * bundle tokens debited in total
     */
    debited: number;
    /**
     * the bundle's size, from the first receipt
     */
    initialTokens: number | null;
    /**
     * the balance after the last receipt
     */
    remaining: number | null;
    usage: {
        prompt: number;
        cached: number;
        completion: number;
    };
};
/** @typedef {import("./receipt.js").Receipt} Receipt */
/** @typedef {import("./anchor.js").Anchor} Anchor */
/**
 * @typedef {object} ChainReport
 * @property {boolean} ok
 * @property {string[]} problems
 * @property {number} receipts
 * @property {number} recomputed debits recomputed exactly from usage and rates
 * @property {number} estimated debits settled at an estimate (no usage reported)
 * @property {number} debited bundle tokens debited in total
 * @property {number | null} initialTokens the bundle's size, from the first receipt
 * @property {number | null} remaining the balance after the last receipt
 * @property {{ prompt: number, cached: number, completion: number }} usage
 */
/**
 * @param {Receipt[]} receipts
 * @param {object} o
 * @param {string} o.issuer
 * @param {{ token: string, paymentHash: string }} [o.credential]
 * @param {Receipt} [o.previous] the last receipt already verified, to continue from
 * @returns {ChainReport}
 */
export declare function checkChain(receipts: Receipt[], { issuer, credential, previous }: {
    issuer: string;
    credential?: {
        token: string;
        paymentHash: string;
    };
    previous?: Receipt;
}): ChainReport;
export type BundleReport = {
    ok: boolean;
    seller: string;
    issuer: string;
    chain: ChainReport;
    /**
     * receipts proven to be in a daily anchor
     */
    anchored: number;
    /**
     * anchors found on Nostr relays
     */
    onNostr: number;
    /**
     * anchors whose timestamp is in a Bitcoin block
     */
    inBitcoin: {
        day: string;
        height: number;
    }[];
    problems: string[];
    receipts: Receipt[];
};
/**
 * Fetches and verifies the receipts of the bundle a credential paid for.
 * @param {object} o
 * @param {string} o.seller the seller's origin, e.g. https://lampo.run
 * @param {string} o.credential the Authorization header value used to pay
 * @param {string} [o.issuer] the issuer key to require; defaults to the seller's published one
 * @param {boolean} [o.checkNostr]
 * @param {Receipt[]} [o.known] receipts saved earlier, which must not have changed
 * @param {boolean} [o.checkBitcoin] check each anchor's timestamp against a block explorer
 * @param {string} [o.explorer] an Esplora API, default https://mempool.space/api
 * @param {typeof fetch} [o.fetch]
 * @returns {Promise<BundleReport>}
 */
export declare function verifyBundle(o: {
    seller: string;
    credential: string;
    issuer?: string;
    checkNostr?: boolean;
    known?: Receipt[];
    checkBitcoin?: boolean;
    explorer?: string;
    fetch?: typeof fetch;
}): Promise<BundleReport>;
