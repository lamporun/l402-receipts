import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { AnchorDir, runAnchorJob } from "../src/anchors.js";
import { checkAnchor, dayBounds } from "../src/anchor.js";
import { Ledger } from "../src/ledger.js";
import { otsFile } from "../src/ots.js";
import { GENESIS, weightedDebit } from "../src/receipt.js";
import { createReceiptServer } from "../src/server.js";
import { verifyBundle, verifyReceipts } from "../src/verify.js";
import { fakeLightmeter, l402Credential, tempDir, testKey } from "./helpers.js";

const DAY1 = "2026-11-25";
const DAY2 = "2026-11-26";
const RATES = /** @type {[number, number, number]} */ ([1000000, 2000000, 100]);
const R = { input_msat_per_ktok: RATES[0], output_msat_per_ktok: RATES[1], cached_input_permille: RATES[2] };

/** A seller with two bundles and debits over two days. */
async function seller() {
	const dir = tempDir();
	const dbFile = path.join(dir, "lightmeter.db");
	const lm = fakeLightmeter(dbFile);
	const key = testKey();
	const alice = l402Credential(10);
	const bob = l402Credential(11);
	const [d1] = dayBounds(DAY1);
	const [d2] = dayBounds(DAY2);

	lm.book(alice.token, alice.paymentHash, 100000, 1000);
	lm.book(bob.token, bob.paymentHash, 100000, 1000);
	const u1 = { prompt: 1000, cached: 800, completion: 300 };
	lm.debit(alice.token, { time: d1 + 60, debit: weightedDebit(u1, R), ...u1, rates: RATES });
	lm.debit(bob.token, { time: d1 + 61, debit: 42, source: "total", total: 42 });
	const u2 = { prompt: 100, cached: 0, completion: 200 };
	lm.debit(alice.token, { time: d1 + 3600, debit: weightedDebit(u2, R), ...u2, rates: RATES });
	lm.debit(alice.token, { time: d2 + 10, debit: 500, source: "estimate" });

	const ledger = new Ledger(dbFile, key);
	const anchors = new AnchorDir(path.join(dir, "anchors"));
	const opts = { ledger, anchors, issuer: key.issuer, publicUrl: "http://seller.test", seller: "seller.test", since: DAY1, relays: [] };
	const server = createReceiptServer(opts);
	await new Promise((r) => server.listen(0, "127.0.0.1", () => r(null)));
	const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
	const base = `http://127.0.0.1:${port}`;

	// The verifier talks to the seller's public URL; route it to the test server.
	/** @type {typeof fetch} */
	const fetchImpl = (input, init) => fetch(String(input).replace("http://seller.test", base), init);
	return { dir, lm, key, alice, bob, ledger, anchors, opts, server, base, fetchImpl, d1, d2 };
}

test("a buyer verifies its receipts end to end, through the anchors", async (t) => {
	const s = await seller();
	t.after(() => s.server.close());
	/** @type {any[]} */
	const notes = [];

	// Before any anchor: the history checks out, nothing is anchored yet.
	let report = await verifyBundle({ seller: "http://seller.test", credential: s.alice.header, fetch: s.fetchImpl });
	assert.deepEqual(report.problems, []);
	assert.equal(report.chain.receipts, 3);
	assert.equal(report.chain.recomputed, 2);
	assert.equal(report.chain.estimated, 1);
	assert.equal(report.anchored, 0);

	// The day after DAY2, both days get anchored, chained, and published.
	const made = await runAnchorJob({
		...s.opts,
		secretKey: s.key.secretKey,
		relays: ["wss://relay.test"],
		timestamp: false,
		now: s.d2 + 86400 + 600,
		publish: async (event, relays) => (notes.push(event), relays),
	});
	assert.deepEqual(made.map((a) => [a.day, a.count]), [[DAY1, 3], [DAY2, 1]]);
	assert.equal(made[0].prev, GENESIS);
	assert.equal(made[1].prev, made[0].id);
	for (const a of made) assert.deepEqual(checkAnchor(a, s.key.issuer), []);
	assert.equal(notes.length, 2);
	assert.ok(notes[0].tags.some((/** @type {string[]} */ t) => t[0] === "x" && t[1] === made[0].id));

	// Running again changes nothing.
	assert.deepEqual(await runAnchorJob({ ...s.opts, secretKey: s.key.secretKey, timestamp: false, now: s.d2 + 86400 + 900 }), []);

	report = await verifyBundle({ seller: "http://seller.test", credential: s.alice.header, fetch: s.fetchImpl });
	assert.deepEqual(report.problems, []);
	assert.equal(report.anchored, 3);
	const saved = report.receipts;

	// Bob only sees his own bundle.
	const bobReport = await verifyBundle({ seller: "http://seller.test", credential: s.bob.header, fetch: s.fetchImpl });
	assert.deepEqual(bobReport.problems, []);
	assert.equal(bobReport.chain.receipts, 1);
	assert.equal(bobReport.anchored, 1);

	// The seller rewrites an anchored debit in its ledger. The buyer's saved
	// copy and the anchor both expose it.
	s.lm.db.prepare("UPDATE usage_events SET tokens = tokens + 1, remaining_tokens = remaining_tokens - 1 WHERE id = 1").run();
	// The issuer caches each bundle's chain; a cheating seller restarts it.
	s.ledger.chains.clear();
	s.ledger.sigs.clear();
	report = await verifyBundle({ seller: "http://seller.test", credential: s.alice.header, fetch: s.fetchImpl, known: saved });
	const all = report.problems.join("\n");
	assert.match(all, /receipt 1: changed since you saved it/);
	assert.match(all, /anchored, but the seller gives no proof/);
	assert.match(all, /its usage at its rates costs/);
});

test("receipts handed over one by one check out, and tampering shows", async (t) => {
	const s = await seller();
	t.after(() => s.server.close());
	await runAnchorJob({ ...s.opts, secretKey: s.key.secretKey, timestamp: false, now: s.d2 + 86400 + 600 });
	const page = await (await fetch(`${s.base}/receipts?after=0`, { headers: { Authorization: s.alice.header } })).json();
	const [r1, r2, r3] = page.receipts;
	const check = (/** @type {any[]} */ receipts, /** @type {any} */ proofs, extra = {}) =>
		verifyReceipts({ seller: "http://seller.test", receipts, proofs, fetch: s.fetchImpl, ...extra });

	// One receipt and its proof, without the rest of the bundle.
	let report = await check([r2], { [r2.seq]: page.proofs[r2.seq] });
	assert.deepEqual(report.problems, []);
	assert.equal(report.checked.recomputed, 1);
	assert.equal(report.anchored, 1);

	// Two that follow each other must chain; one without a proof is reported, not failed.
	report = await check([r2, r1, r3], { [r1.id]: page.proofs[r1.seq] });
	assert.deepEqual(report.problems, []);
	assert.equal(report.anchored, 1);
	assert.equal(report.unproven, 2);
	assert.equal(report.checked.estimated, 1);

	// A changed debit breaks the signature, and the arithmetic.
	report = await check([{ ...r2, debit: r2.debit + 1 }], {});
	assert.match(report.problems.join("\n"), /receipt 2: id does not match/);
	assert.match(report.problems.join("\n"), /its usage at its rates costs/);

	// A proof for another receipt does not prove this one.
	report = await check([r2], { [r2.seq]: page.proofs[r1.seq] });
	assert.match(report.problems.join("\n"), /receipt 2: not included in the anchor/);

	// Receipts from another key are not the seller's.
	report = await check([r2], {}, { issuer: testKey(2).issuer });
	assert.match(report.problems.join("\n"), /the seller now publishes issuer/);
	assert.match(report.problems.join("\n"), /receipt 2: issued by /);
});

test("receipts are only served to the payer", async (t) => {
	const s = await seller();
	t.after(() => s.server.close());
	const get = (/** @type {string | undefined} */ auth) =>
		fetch(`${s.base}/receipts`, { headers: auth ? { Authorization: auth } : {} }).then(async (r) => ({ status: r.status, body: await r.json() }));

	assert.equal((await get(undefined)).status, 401);
	assert.equal((await get("Bearer x")).status, 401);

	// A macaroon naming Alice's token, with a payment the attacker made.
	const mallory = l402Credential(12);
	const forged = l402Credential(10);
	const id = Buffer.from(forged.header.slice(5).split(":")[0], "base64");
	const idStart = id.indexOf(Buffer.from(forged.paymentHash, "hex"));
	Buffer.from(mallory.paymentHash, "hex").copy(id, idStart);
	const res = await get(`L402 ${id.toString("base64")}:${mallory.preimage}`);
	assert.equal(res.status, 404);

	const ok = await get(s.alice.header);
	assert.equal(ok.status, 200);
	assert.equal(ok.body.receipts.length, 3);
	assert.ok(ok.body.receipts.every((/** @type {any} */ r) => r.token === s.alice.token));

	const after = await fetch(`${s.base}/receipts?after=2`, { headers: { Authorization: s.alice.header } }).then((r) => r.json());
	assert.deepEqual(after.receipts.map((/** @type {any} */ r) => r.seq), [3]);

	const wk = await fetch(`${s.base}/.well-known/l402-receipts.json`).then((r) => r.json());
	assert.equal(wk.issuer, s.key.issuer);
	assert.equal((await fetch(`${s.base}/receipts/anchors/2026-11-25.json`)).status, 404);
	assert.equal((await fetch(`${s.base}/receipts`, { method: "POST" })).status, 405);
	assert.equal((await fetch(`${s.base}/receipts/anchors/../../etc/passwd`)).status, 404);
});

test("long histories are paged, and only the requested receipts are signed", async (t) => {
	const s = await seller();
	t.after(() => s.server.close());
	const server = createReceiptServer({ ...s.opts, pageSize: 100 });
	await new Promise((r) => server.listen(0, "127.0.0.1", () => r(null)));
	t.after(() => server.close());
	const base = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;

	// 3,000 more debits on Alice's bundle.
	s.lm.db.exec("BEGIN");
	for (let i = 0; i < 3000; i++) s.lm.debit(s.alice.token, { time: s.d2 + 100 + i, debit: 7, source: "total", total: 7 });
	s.lm.db.exec("COMMIT");

	const get = (/** @type {number} */ after) =>
		fetch(`${base}/receipts?after=${after}`, { headers: { Authorization: s.alice.header } }).then((r) => r.json());
	let started = performance.now();
	const first = await get(0);
	const firstMs = performance.now() - started;
	assert.equal(first.receipts.length, 100);
	assert.equal(first.receipts[0].seq, 1);
	assert.equal(first.more, true);

	// The chain is now cached: the newest receipts cost almost nothing.
	started = performance.now();
	const last = await get(3002);
	assert.deepEqual(last.receipts.map((/** @type {any} */ r) => r.seq), [3003]);
	assert.equal(last.more, false);
	assert.ok(performance.now() - started < 200, "a request for the newest receipt must not rework the whole history");
	assert.ok(s.ledger.sigs.size <= 101, `signed ${s.ledger.sigs.size} receipts, expected only the ones served`);
	void firstMs;

	// The verifier follows every page and checks the whole history.
	/** @type {typeof fetch} */
	const fetchImpl = (input, init) => fetch(String(input).replace("http://seller.test", base), init);
	const report = await verifyBundle({ seller: "http://seller.test", credential: s.alice.header, fetch: fetchImpl });
	assert.deepEqual(report.problems, []);
	assert.equal(report.chain.receipts, 3003);
});

test("bundles with history from before receipts get none", async (t) => {
	const s = await seller();
	t.after(() => s.server.close());
	s.lm.db.prepare("UPDATE usage_events SET remaining_tokens = NULL WHERE token_id = ?").run(s.bob.token);
	const res = await fetch(`${s.base}/receipts`, { headers: { Authorization: s.bob.header } });
	assert.equal(res.status, 404);
	assert.match((await res.json()).error, /before receipts started/);
});

test("failed credentials are rate limited per client", async (t) => {
	const s = await seller();
	t.after(() => s.server.close());
	const server = createReceiptServer({ ...s.opts, failuresPerMinute: 3 });
	await new Promise((r) => server.listen(0, "127.0.0.1", () => r(null)));
	t.after(() => server.close());
	const url = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}/receipts`;
	const statuses = [];
	for (let i = 0; i < 5; i++) statuses.push((await fetch(url, { headers: { Authorization: "Bearer nope" } })).status);
	assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
});

test("the .ots file has the OpenTimestamps layout", () => {
	const file = otsFile({
		digest: "11".repeat(32),
		branches: [
			{ calendar: "a", nonce: "22".repeat(16), commitment: "", answer: "00aabb", complete: false },
			{ calendar: "b", nonce: "33".repeat(16), commitment: "", answer: "00ccdd", complete: false },
		],
	});
	const hex = Buffer.from(file).toString("hex");
	assert.ok(hex.startsWith("004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294" + "01" + "08" + "11".repeat(32)));
	assert.ok(hex.endsWith("ff" + "f010" + "22".repeat(16) + "08" + "00aabb" + "f010" + "33".repeat(16) + "08" + "00ccdd"));
	assert.ok(!fs.existsSync("/nonexistent"));
});

test("timestamps upgrade through the calendar named in each pending attestation", async () => {
	const { upgrade, bitcoinAttestations } = await import("../src/ots.js");
	const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/ots-stamp.json", import.meta.url), "utf8"));
	/** @type {string[]} */
	const asked = [];
	/** @type {typeof fetch} */
	const stub = async (input) => {
		const url = String(input);
		asked.push(url);
		const hit = fx.calendars[url];
		return hit ? new Response(Buffer.from(hit.body, "hex"), { status: hit.status }) : new Response("", { status: 404 });
	};
	assert.deepEqual(bitcoinAttestations(fx.state), []);
	const up = await upgrade(fx.state, { fetch: stub });
	assert.equal(up.changed, true);
	// The proofs are completed by the calendars themselves, not the pools we submitted to.
	assert.ok(asked.every((u) => !u.includes(".pool.")));
	assert.ok(asked.some((u) => u.startsWith("https://alice.btc.calendar.opentimestamps.org/timestamp/")));
	const btc = bitcoinAttestations(up.state);
	assert.ok(btc.length >= 1);
	// Block 977493's merkle root, as mempool.space shows it.
	for (const a of btc) assert.deepEqual([a.height, a.merkleRoot], [977493, "ab87896e01794daa4778a10907e0c06e6a83c0cf8953f2fae0736f732392f857"]);
	// A second upgrade asks only the calendars still pending.
	asked.length = 0;
	await upgrade(up.state, { fetch: stub });
	assert.ok(asked.every((u) => u.includes("eternitywall")));
});

test("a .ots file is read back, and verify checks it against a block explorer", async (t) => {
	const { upgrade, otsFile, otsFileAttestations } = await import("../src/ots.js");
	const { sha256 } = await import("@noble/hashes/sha2.js");
	const { bytesToHex, concatBytes, hexToBytes } = await import("@noble/hashes/utils.js");

	// The real stamp, completed: its file reads back to block 977493.
	const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/ots-stamp.json", import.meta.url), "utf8"));
	/** @type {typeof fetch} */
	const stub = async (input) => {
		const hit = fx.calendars[String(input)];
		return hit ? new Response(Buffer.from(hit.body, "hex"), { status: hit.status }) : new Response("", { status: 404 });
	};
	const file = otsFile((await upgrade(fx.state, { fetch: stub })).state);
	assert.equal(otsFileAttestations(file, fx.state.digest)[0].height, 977493);
	assert.throws(() => otsFileAttestations(file, "00".repeat(32)), /another digest/);

	// An anchored seller whose day-one anchor has a (synthetic) Bitcoin proof.
	const s = await seller();
	t.after(() => s.server.close());
	const [made] = await runAnchorJob({ ...s.opts, secretKey: s.key.secretKey, timestamp: false, now: s.d1 + 86400 + 600 });
	const extra = Uint8Array.of(0xaa);
	const msg = sha256(concatBytes(hexToBytes(made.id), extra));
	const magic = hexToBytes("004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294");
	const btc = concatBytes(Uint8Array.of(0), hexToBytes("0588960d73d71901"), Uint8Array.of(3, 0xfd, 0x9d, 0x3b));
	fs.writeFileSync(
		s.anchors.file(made.day, ".ots"),
		concatBytes(magic, Uint8Array.of(1, 8), hexToBytes(made.id), Uint8Array.of(0xf0, 1), extra, Uint8Array.of(8), btc),
	);
	const blockHeight = otsFileAttestations(fs.readFileSync(s.anchors.file(made.day, ".ots")), made.id)[0].height;

	const root = bytesToHex(msg.slice().reverse());
	/** @param {string} explorerRoot */
	const run = (explorerRoot) =>
		verifyBundle({
			seller: "http://seller.test",
			credential: s.alice.header,
			checkBitcoin: true,
			explorer: "https://explorer.test/api",
			fetch: async (input, init) => {
				const url = String(input);
				if (url === `https://explorer.test/api/block-height/${blockHeight}`) return new Response("blockhash");
				if (url === "https://explorer.test/api/block/blockhash") return Response.json({ merkle_root: explorerRoot });
				return fetch(url.replace("http://seller.test", s.base), init);
			},
		});
	const good = await run(root);
	assert.deepEqual(good.problems, []);
	assert.deepEqual(good.inBitcoin, [{ day: made.day, height: blockHeight }]);
	const bad = await run("00".repeat(32));
	assert.match(bad.problems.join("\n"), /does not match block/);
});
