export type Anchor = import("./anchor.js").Anchor;
export type Ledger = import("./ledger.js").Ledger;
export declare class AnchorDir {
    dir: string;
    /** @param {string} dir */
    constructor(dir: string);
    /** Anchored days, oldest first. */
    days(): string[];
    /** @param {string} day @returns {Anchor | null} */
    get(day: string): Anchor | null;
    /** @param {Anchor} a */
    put(a: Anchor): void;
    /** @param {string} day @param {string} ext */
    file(day: string, ext: string): string;
    /** @param {string} day @param {string} ext @returns {any} */
    readJson(day: string, ext: string): any;
    /** @param {string} day @param {string} ext @param {unknown} value */
    writeJson(day: string, ext: string, value: unknown): void;
}
export type AnchorJobOptions = {
    ledger: Ledger;
    anchors: AnchorDir;
    secretKey: Uint8Array;
    issuer: string;
    /**
     * the first day to anchor
     */
    since: string;
    /**
     * e.g. https://lampo.run
     */
    publicUrl: string;
    /**
     * e.g. lampo.run
     */
    seller: string;
    /**
     * Nostr relays to publish to; empty to skip
     */
    relays: string[];
    /**
     * whether to stamp with OpenTimestamps
     */
    timestamp: boolean;
    /**
     * unix seconds, for tests
     */
    now?: number;
    log?: (msg: string) => void;
    publish?: (event: any, relays: string[]) => Promise<string[]>;
};
/**
 * @typedef {object} AnchorJobOptions
 * @property {Ledger} ledger
 * @property {AnchorDir} anchors
 * @property {Uint8Array} secretKey
 * @property {string} issuer
 * @property {string} since the first day to anchor
 * @property {string} publicUrl e.g. https://lampo.run
 * @property {string} seller e.g. lampo.run
 * @property {string[]} relays Nostr relays to publish to; empty to skip
 * @property {boolean} timestamp whether to stamp with OpenTimestamps
 * @property {number} [now] unix seconds, for tests
 * @property {(msg: string) => void} [log]
 * @property {(event: any, relays: string[]) => Promise<string[]>} [publish]
 */
/**
 * Anchors every complete UTC day from `since` to yesterday that has no
 * anchor yet, then retries missing timestamps and notes, and upgrades
 * pending timestamps. Safe to run as often as wanted.
 * @param {AnchorJobOptions} o
 */
export declare function runAnchorJob(o: AnchorJobOptions): Promise<import("./anchor.js").Anchor[]>;
