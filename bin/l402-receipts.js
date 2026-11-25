#!/usr/bin/env node
// l402-receipts: issue, anchor and verify usage receipts for metered L402 APIs.

import fs from "node:fs";
import { parseArgs } from "node:util";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

const HELP = `l402-receipts: signed, verifiable usage receipts for metered L402 APIs

Buyers:
  l402-receipts verify --seller https://lampo.run --credential "L402 <macaroon>:<preimage>"
      [--issuer <hex key>] [--nostr] [--bitcoin] [--json]
    --nostr checks that each anchor was posted on the seller's relays;
    --bitcoin checks each anchor's timestamp against mempool.space.
    The credential can also come from --credential-file <path> or the
    L402_CREDENTIAL environment variable.

Sellers (next to a Lightmeter whose store keeps the usage ledger):
  l402-receipts keygen --out <key file>
  l402-receipts serve  --db <lightmeter.db> --key <key file> --anchors <dir>
      --public-url https://example.com --since YYYY-MM-DD
      [--listen 127.0.0.1:10050] [--relay wss://... ...]
  l402-receipts anchor --db <lightmeter.db> --key <key file> --anchors <dir>
      --public-url https://example.com --since YYYY-MM-DD
      [--relay wss://... ...] [--no-ots]
`;

/** @param {string} msg @returns {never} */
function fail(msg) {
	console.error(`l402-receipts: ${msg}`);
	process.exit(2);
}

/** @param {string} file */
function loadKey(file) {
	const st = fs.statSync(file);
	if (st.mode & 0o077) fail(`${file} must not be readable by others (chmod 600)`);
	const hex = fs.readFileSync(file, "utf8").trim();
	if (!/^[0-9a-f]{64}$/.test(hex)) fail(`${file} does not hold a 32-byte hex key`);
	const secretKey = hexToBytes(hex);
	return { secretKey, issuer: bytesToHex(schnorr.getPublicKey(secretKey)) };
}

/** @param {string | undefined} v @param {string} name */
function need(v, name) {
	if (!v) fail(`--${name} is required\n\n${HELP}`);
	return /** @type {string} */ (v);
}

/** @param {string} day */
function checkDay(day) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail(`--since must be a day like 2026-11-25`);
	return day;
}

const [cmd, ...rest] = process.argv.slice(2);
const { values: a } = parseArgs({
	args: rest,
	options: {
		seller: { type: "string" },
		credential: { type: "string" },
		"credential-file": { type: "string" },
		issuer: { type: "string" },
		nostr: { type: "boolean", default: false },
		bitcoin: { type: "boolean", default: false },
		json: { type: "boolean", default: false },
		out: { type: "string" },
		db: { type: "string" },
		key: { type: "string" },
		anchors: { type: "string" },
		"public-url": { type: "string" },
		since: { type: "string" },
		listen: { type: "string", default: "127.0.0.1:10050" },
		relay: { type: "string", multiple: true, default: [] },
		"no-ots": { type: "boolean", default: false },
		help: { type: "boolean", short: "h", default: false },
	},
	allowPositionals: false,
});

if (!cmd || cmd === "help" || a.help) {
	process.stdout.write(HELP);
	process.exit(0);
}

if (cmd === "--version" || cmd === "version") {
	const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	console.log(pkg.version);
	process.exit(0);
}

if (cmd === "keygen") {
	const out = need(a.out, "out");
	if (fs.existsSync(out)) fail(`${out} exists, refusing to overwrite a key`);
	const sk = schnorr.utils.randomSecretKey();
	fs.writeFileSync(out, `${bytesToHex(sk)}\n`, { mode: 0o600, flag: "wx" });
	console.log(`issuer key written to ${out}\npublic key: ${bytesToHex(schnorr.getPublicKey(sk))}`);
	process.exit(0);
}

if (cmd === "verify") {
	const { verifyBundle } = await import("../src/verify.js");
	const credential =
		a.credential ?? (a["credential-file"] ? fs.readFileSync(a["credential-file"], "utf8").trim() : process.env.L402_CREDENTIAL);
	if (!credential) fail("pass the credential you paid with: --credential, --credential-file or L402_CREDENTIAL");
	const report = await verifyBundle({
		seller: need(a.seller, "seller"),
		credential: /** @type {string} */ (credential),
		issuer: a.issuer,
		checkNostr: a.nostr,
		checkBitcoin: a.bitcoin,
	}).catch((e) => fail(e.message));
	if (a.json) {
		const { receipts, ...summary } = report;
		console.log(JSON.stringify(summary, null, 2));
	} else {
		const c = report.chain;
		const n = (/** @type {number} */ x) => x.toLocaleString("en-US");
		console.log(`${report.seller}, issuer ${report.issuer}`);
		console.log(`${c.receipts} receipts: ${c.recomputed} debits recomputed exactly, ${c.estimated} settled at an estimate`);
		console.log(`usage ${n(c.usage.prompt)} prompt (${n(c.usage.cached)} cached) + ${n(c.usage.completion)} completion tokens`);
		if (c.initialTokens !== null) console.log(`bundle ${n(c.initialTokens)} tokens, debited ${n(c.debited)}, ${n(c.remaining ?? 0)} left`);
		console.log(`${report.anchored} of ${c.receipts} receipts proven in a daily anchor${a.nostr ? `, ${report.onNostr} anchors found on Nostr` : ""}`);
		for (const b of report.inBitcoin) console.log(`anchor of ${b.day} timestamped in Bitcoin block ${b.height.toLocaleString("en-US")}`);
		if (report.ok) console.log("OK: every receipt checks out");
		else for (const p of report.problems) console.log(`PROBLEM: ${p}`);
	}
	process.exit(report.ok ? 0 : 1);
}

if (cmd === "serve" || cmd === "anchor") {
	const { Ledger } = await import("../src/ledger.js");
	const { AnchorDir, runAnchorJob } = await import("../src/anchors.js");
	const key = loadKey(need(a.key, "key"));
	const ledger = new Ledger(need(a.db, "db"), key);
	const anchors = new AnchorDir(need(a.anchors, "anchors"));
	const publicUrl = new URL(need(a["public-url"], "public-url")).origin;
	const since = checkDay(need(a.since, "since"));
	const seller = new URL(publicUrl).host;
	const relays = /** @type {string[]} */ (a.relay);

	if (cmd === "anchor") {
		await runAnchorJob({
			ledger,
			anchors,
			secretKey: key.secretKey,
			issuer: key.issuer,
			since,
			publicUrl,
			seller,
			relays,
			timestamp: !a["no-ots"],
			log: (m) => console.log(m),
		});
		ledger.close();
		process.exit(0);
	}

	const { createReceiptServer } = await import("../src/server.js");
	const [host, port] = /** @type {string} */ (a.listen).split(/:(?=\d+$)/);
	const server = createReceiptServer({ ledger, anchors, issuer: key.issuer, publicUrl, seller, since, relays });
	server.listen(Number(port), host, () => console.log(`l402-receipts: serving ${seller} receipts on ${a.listen}, issuer ${key.issuer}`));
	const stop = () => server.close(() => (ledger.close(), process.exit(0)));
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
} else if (!["keygen", "verify"].includes(cmd)) {
	fail(`unknown command ${cmd}\n\n${HELP}`);
}
