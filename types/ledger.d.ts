import { DatabaseSync } from "node:sqlite";
export type Receipt = import("./receipt.js").Receipt;
export type ReceiptBody = import("./receipt.js").ReceiptBody;
export type LedgerRow = {
    id: number;
    token_id: string;
    model: string;
    tokens: number;
    created_at: number;
    remaining_tokens: number | null;
    source: string | null;
    prompt_tokens: number | null;
    cached_tokens: number | null;
    completion_tokens: number | null;
    total_tokens: number | null;
    input_msat_per_ktok: number | null;
    output_msat_per_ktok: number | null;
    cached_input_permille: number | null;
    price_sats: number;
    payment_hash: string | null;
};
/**
 * The receipt body for one ledger row.
 * @param {LedgerRow} row
 * @param {number} seq
 * @param {string} prev
 * @param {string} issuer
 * @returns {ReceiptBody}
 */
export declare function rowToBody(row: LedgerRow, seq: number, prev: string, issuer: string): ReceiptBody;
export declare class Ledger {
    db: DatabaseSync;
    issuer: string;
    secretKey: Uint8Array<ArrayBufferLike>;
    byToken: import("node:sqlite").StatementSync;
    tokensOnDay: import("node:sqlite").StatementSync;
    payment: import("node:sqlite").StatementSync;
    firstDay: import("node:sqlite").StatementSync;
    /**
     * @param {string} path Lightmeter's sqlite database
     * @param {{ issuer: string, secretKey: Uint8Array }} key
     */
    constructor(path: string, key: {
        issuer: string;
        secretKey: Uint8Array;
    });
    close(): void;
    /** @param {string} token */
    paymentHash(token: string): string | null;
    /**
     * The unsigned receipt bodies of a bundle, oldest first, or null when the
     * bundle's history predates receipts or has no payment binding.
     * @param {string} token
     * @returns {ReceiptBody[] | null}
     */
    bodies(token: string): ReceiptBody[] | null;
    /**
     * The signed receipts of a bundle, oldest first; null as for bodies.
     * @param {string} token
     * @returns {Receipt[] | null}
     */
    receipts(token: string): Receipt[] | null;
    /**
     * The ids of every receipt with a time in [from, to), ordered by ledger
     * event: the leaves of that period's anchor.
     * @param {number} from unix seconds
     * @param {number} to unix seconds
     * @returns {{ id: string, event: number, token: string, seq: number }[]}
     */
    idsBetween(from: number, to: number): {
        id: string;
        event: number;
        token: string;
        seq: number;
    }[];
    /** Unix time of the first receipt, or null. */
    firstReceiptTime(): number | null;
}
