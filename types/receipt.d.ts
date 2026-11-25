export declare const RECEIPT_VERSION = 1;
export declare const GENESIS: string;
export type Source = "split" | "total" | "estimate" | "plain";
export type Usage = {
    prompt?: number;
    cached?: number;
    completion?: number;
    total?: number;
};
export type Rates = {
    input_msat_per_ktok: number;
    output_msat_per_ktok: number;
    cached_input_permille: number;
};
export type ReceiptBody = {
    v: number;
    issuer: string;
    token: string;
    payment_hash: string;
    seq: number;
    event: number;
    time: number;
    model: string;
    price_sats: number;
    source: Source;
    usage: Usage | null;
    rates: Rates | null;
    debit: number;
    remaining: number;
    prev: string;
};
export type Receipt = ReceiptBody & {
    id: string;
    sig: string;
};
/** @typedef {"split" | "total" | "estimate" | "plain"} Source */
/**
 * @typedef {object} Usage
 * @property {number} [prompt]
 * @property {number} [cached]
 * @property {number} [completion]
 * @property {number} [total]
 */
/**
 * @typedef {object} Rates
 * @property {number} input_msat_per_ktok
 * @property {number} output_msat_per_ktok
 * @property {number} cached_input_permille
 */
/**
 * @typedef {object} ReceiptBody
 * @property {number} v
 * @property {string} issuer
 * @property {string} token
 * @property {string} payment_hash
 * @property {number} seq
 * @property {number} event
 * @property {number} time
 * @property {string} model
 * @property {number} price_sats
 * @property {Source} source
 * @property {Usage | null} usage
 * @property {Rates | null} rates
 * @property {number} debit
 * @property {number} remaining
 * @property {string} prev
 */
/** @typedef {ReceiptBody & { id: string, sig: string }} Receipt */
declare const HEX64: RegExp;
/**
 * The fields of a receipt that its id covers.
 * @param {ReceiptBody | Receipt} r
 * @returns {ReceiptBody}
 */
export declare function receiptBody(r: ReceiptBody | Receipt): ReceiptBody;
/** @param {ReceiptBody | Receipt} r */
export declare function receiptId(r: ReceiptBody | Receipt): string;
/**
 * @param {ReceiptBody} body
 * @param {Uint8Array} secretKey
 * @returns {Receipt}
 */
export declare function signReceipt(body: ReceiptBody, secretKey: Uint8Array): Receipt;
/**
 * Checks a receipt's id and signature, and that it was issued by the given
 * key. Returns the problems found, an empty list for a valid receipt.
 * @param {Receipt} r
 * @param {string} issuer x-only public key, hex
 * @returns {string[]}
 */
export declare function checkSignature(r: Receipt, issuer: string): string[];
/**
 * Recomputes a weighted debit the way Aperture's meter does: the usage's
 * value at the bundle's rates, in bundle tokens priced at the blended
 * (input + output) / 2 rate, rounded up.
 * @param {Usage} usage
 * @param {Rates} rates
 */
export declare function weightedDebit(usage: Usage, rates: Rates): number;
/**
 * The debit a receipt's usage implies, or null when the receipt cannot be
 * recomputed (a response that settled at an estimate, or a plain debit).
 * @param {ReceiptBody} r
 */
export declare function expectedDebit(r: ReceiptBody): number | null;
export { HEX64 };
