import http from "node:http";
export type Ledger = import("./ledger.js").Ledger;
export type AnchorDir = import("./anchors.js").AnchorDir;
export type ServerOptions = {
    ledger: Ledger;
    anchors: AnchorDir;
    issuer: string;
    publicUrl: string;
    seller: string;
    since: string;
    relays: string[];
    perTokenPerMinute?: number;
    failuresPerMinute?: number;
};
/** @param {ServerOptions} o */
export declare function createReceiptServer(o: ServerOptions): http.Server<typeof http.IncomingMessage, typeof http.ServerResponse>;
