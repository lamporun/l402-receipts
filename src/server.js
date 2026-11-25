// The issuer's HTTP service, meant to run behind a reverse proxy on the
// seller's domain:
//
//   GET /.well-known/l402-receipts.json   the issuer key and endpoints
//   GET /receipts[?after=<seq>]           a bundle's receipts, authenticated
//                                         with the buyer's own credential
//   GET /receipts/anchors/                the anchored days
//   GET /receipts/anchors/<day>.json      a day's signed anchor
//   GET /receipts/anchors/<day>.ots       its OpenTimestamps proof

import fs from "node:fs";
import http from "node:http";
import { dayBounds, dayOf } from "./anchor.js";
import { parseCredential } from "./credential.js";
import { auditPath, merkleRoot } from "./merkle.js";

/** @typedef {import("./ledger.js").Ledger} Ledger */
/** @typedef {import("./anchors.js").AnchorDir} AnchorDir */

/**
 * @typedef {object} ServerOptions
 * @property {Ledger} ledger
 * @property {AnchorDir} anchors
 * @property {string} issuer
 * @property {string} publicUrl
 * @property {string} seller
 * @property {string} since
 * @property {string[]} relays
 * @property {number} [perTokenPerMinute]
 * @property {number} [failuresPerMinute]
 */

/**
 * A fixed-window rate limiter: hit counts an event, blocked tells whether
 * the key reached the limit in the current minute.
 * @param {number} limit
 */
function limiter(limit) {
	/** @type {Map<string, { n: number, until: number }>} */
	const seen = new Map();
	/** @param {string} key */
	const current = (key) => {
		const now = Date.now();
		if (seen.size > 10000) for (const [k, v] of seen) if (v.until < now) seen.delete(k);
		let e = seen.get(key);
		if (!e || e.until < now) {
			e = { n: 0, until: now + 60000 };
			seen.set(key, e);
		}
		return e;
	};
	return {
		/** @param {string} key */
		hit(key) {
			const e = current(key);
			e.n += 1;
			return e.n <= limit;
		},
		/** @param {string} key */
		blocked(key) {
			return current(key).n >= limit;
		},
	};
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 */
function sendJson(res, status, body, headers = {}) {
	const data = `${JSON.stringify(body)}\n`;
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(data),
		"X-Content-Type-Options": "nosniff",
		"Access-Control-Allow-Origin": "*",
		...headers,
	});
	res.end(data);
}

/** @param {ServerOptions} o */
export function createReceiptServer(o) {
	const perToken = limiter(o.perTokenPerMinute ?? 60);
	const failures = limiter(o.failuresPerMinute ?? 20);

	/** @type {Map<string, { root: string, ids: string[] }>} */
	const leavesCache = new Map();
	/** @param {string} day */
	const dayLeaves = (day) => {
		let v = leavesCache.get(day);
		if (!v) {
			const [from, to] = dayBounds(day);
			const ids = o.ledger.idsBetween(from, to).map((l) => l.id);
			v = { root: merkleRoot(ids), ids };
			if (leavesCache.size > 400) leavesCache.clear();
			leavesCache.set(day, v);
		}
		return v;
	};

	const wellKnown = () => ({
		v: 1,
		issuer: o.issuer,
		seller: o.seller,
		receipts: `${o.publicUrl}/receipts`,
		anchors: `${o.publicUrl}/receipts/anchors/`,
		relays: o.relays,
		since: o.since,
		spec: "https://github.com/lamporun/l402-receipts/blob/main/SPEC.md",
	});

	/** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
	const handle = (req, res) => {
		const url = new URL(req.url || "/", "http://localhost");
		if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "method not allowed" }, { Allow: "GET, HEAD" });
		const client = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();

		if (url.pathname === "/.well-known/l402-receipts.json") {
			return sendJson(res, 200, wellKnown(), { "Cache-Control": "public, max-age=300" });
		}

		if (url.pathname === "/receipts") {
			if (failures.blocked(client)) return sendJson(res, 429, { error: "too many requests" }, { "Retry-After": "60" });
			let cred;
			try {
				cred = parseCredential(String(req.headers.authorization || ""));
			} catch (e) {
				failures.hit(client);
				return sendJson(res, 401, { error: `send the L402 credential you paid with: ${/** @type {Error} */ (e).message}` });
			}
			const bound = o.ledger.paymentHash(cred.token);
			if (bound !== cred.paymentHash) {
				failures.hit(client);
				return sendJson(res, 404, { error: "no receipts for this credential yet" });
			}
			if (!perToken.hit(cred.token)) return sendJson(res, 429, { error: "too many requests" }, { "Retry-After": "60" });

			const list = o.ledger.receipts(cred.token);
			if (list === null) return sendJson(res, 404, { error: `this bundle was bought before receipts started on ${o.since}` });
			const after = Math.max(0, Number.parseInt(url.searchParams.get("after") || "0", 10) || 0);
			const receipts = list.filter((r) => r.seq > after);

			/** @type {Record<string, unknown>} */
			const proofs = {};
			for (const r of receipts) {
				const day = dayOf(r.time);
				const anchor = o.anchors.get(day);
				if (!anchor) continue;
				const leaves = dayLeaves(day);
				const index = leaves.ids.indexOf(r.id);
				if (index < 0 || leaves.root !== anchor.root) continue;
				proofs[r.seq] = { day, anchor: anchor.id, index, size: leaves.ids.length, path: auditPath(leaves.ids, index) };
			}
			return sendJson(res, 200, { v: 1, issuer: o.issuer, token: cred.token, receipts, proofs }, { "Cache-Control": "no-store" });
		}

		if (url.pathname === "/receipts/anchors/" || url.pathname === "/receipts/anchors") {
			const days = o.anchors.days().map((d) => {
				const a = o.anchors.get(d);
				return a && { day: d, count: a.count, root: a.root, id: a.id };
			});
			return sendJson(res, 200, { v: 1, issuer: o.issuer, anchors: days }, { "Cache-Control": "public, max-age=300" });
		}

		const m = /^\/receipts\/anchors\/(\d{4}-\d{2}-\d{2})\.(json|ots)$/.exec(url.pathname);
		if (m) {
			const file = o.anchors.file(m[1], `.${m[2]}`);
			let data;
			try {
				data = fs.readFileSync(file);
			} catch {
				return sendJson(res, 404, { error: "not anchored yet" });
			}
			res.writeHead(200, {
				"Content-Type": m[2] === "json" ? "application/json; charset=utf-8" : "application/octet-stream",
				"Content-Length": data.length,
				"Cache-Control": m[2] === "json" ? "public, max-age=86400, immutable" : "public, max-age=3600",
				"X-Content-Type-Options": "nosniff",
				"Access-Control-Allow-Origin": "*",
			});
			return res.end(req.method === "HEAD" ? undefined : data);
		}

		return sendJson(res, 404, { error: "not found" });
	};

	return http.createServer((req, res) => {
		try {
			handle(req, res);
		} catch (e) {
			console.error("receipts:", /** @type {Error} */ (e).message);
			if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
			else res.destroy();
		}
	});
}
