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
    /**
     * Each bundle's receipt bodies with their ids, extended with new
     * ledger rows only: the ledger is append-only, so a long history is
     * hashed once, not on every request. null marks a bundle whose
     * history predates receipts.
     * @type {Map<string, { lastEvent: number, prev: string, bodies: (ReceiptBody & { id: string })[] } | null>}
     */
    chains: Map<string, {
        lastEvent: number;
        prev: string;
        bodies: (ReceiptBody & {
            id: string;
        })[];
    } | null>;
    /** Signatures already made, by receipt id. @type {Map<string, string>} */
    sigs: Map<string, string>;
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
     * The unsigned receipt bodies of a bundle with their ids, oldest first,
     * or null when the bundle's history predates receipts or has no payment
     * binding. The returned array is shared: do not modify it.
     * @param {string} token
     * @returns {(ReceiptBody & { id: string })[] | null}
     */
    bodies(token: string): (ReceiptBody & {
        id: string;
    })[] | null;
    /**
     * @param {string} token
     * @param {{ lastEvent: number, prev: string, bodies: (ReceiptBody & { id: string })[] } | null} chain
     */
    remember(token: string, chain: {
        lastEvent: number;
        prev: string;
        bodies: (ReceiptBody & {
            id: string;
        })[];
    } | null): void;
    /**
     * Signs receipt bodies, reusing signatures already made.
     * @param {(ReceiptBody & { id: string })[]} bodies
     * @returns {Receipt[]}
     */
    sign(bodies: (ReceiptBody & {
        id: string;
    })[]): Receipt[];
    /**
     * The signed receipts of a bundle after the given seq, oldest first, at
     * most `limit` of them; null as for bodies.
     * @param {string} token
     * @param {number} [after]
     * @param {number} [limit]
     * @returns {Receipt[] | null}
     */
    receipts(token: string, after?: number, limit?: number): Receipt[] | null;
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
