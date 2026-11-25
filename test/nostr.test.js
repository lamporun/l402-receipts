import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { finalizeEvent } from "nostr-tools/pure";
import { publish, query } from "../src/nostr.js";
import { testKey } from "./helpers.js";

/**
 * A fake relay. mode: "ok" stores and accepts events, "reject" refuses them,
 * "silent" accepts connections and never answers.
 * @param {"ok" | "reject" | "silent"} mode
 * @param {any[]} stored
 */
async function relay(mode, stored = []) {
	const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
	await new Promise((r) => wss.once("listening", r));
	wss.on("connection", (/** @type {import("ws").WebSocket} */ ws) => {
		ws.on("message", (/** @type {Buffer} */ data) => {
			if (mode === "silent") return;
			const msg = JSON.parse(String(data));
			if (msg[0] === "EVENT") {
				if (mode === "ok") stored.push(msg[1]);
				ws.send(JSON.stringify(["OK", msg[1].id, mode === "ok", mode === "ok" ? "" : "blocked: no"]));
			}
			if (msg[0] === "REQ") {
				const f = msg[2];
				for (const e of stored) {
					if (f.authors && !f.authors.includes(e.pubkey)) continue;
					if (f["#x"] && !e.tags.some((/** @type {string[]} */ t) => t[0] === "x" && f["#x"].includes(t[1]))) continue;
					ws.send(JSON.stringify(["EVENT", msg[1], e]));
				}
				// A forged event: valid shape, bad signature.
				ws.send(JSON.stringify(["EVENT", msg[1], { ...stored[0], content: "forged" }]));
				ws.send(JSON.stringify(["EOSE", msg[1]]));
			}
		});
	});
	const port = /** @type {import("node:net").AddressInfo} */ (wss.address()).port;
	return { url: `ws://127.0.0.1:${port}`, close: () => new Promise((r) => wss.close(() => r(null))) };
}

/** A port with nothing listening. */
async function deadPort() {
	const srv = net.createServer();
	await new Promise((r) => srv.listen(0, "127.0.0.1", () => r(null)));
	const port = /** @type {import("node:net").AddressInfo} */ (srv.address()).port;
	await new Promise((r) => srv.close(() => r(null)));
	return `ws://127.0.0.1:${port}`;
}

test("publish and query survive relays that refuse, stall or don't exist", async (t) => {
	const stored = /** @type {any[]} */ ([]);
	const ok = await relay("ok", stored);
	const reject = await relay("reject");
	const silent = await relay("silent");
	const dead = await deadPort();
	t.after(async () => {
		await ok.close();
		await reject.close();
		await silent.close();
	});

	const key = testKey();
	const event = finalizeEvent({ kind: 1, created_at: 1795600000, tags: [["x", "ab".repeat(32)]], content: "anchor" }, key.secretKey);
	const relays = [ok.url, reject.url, silent.url, dead, "wss://does-not-exist.invalid"];

	const started = Date.now();
	const accepted = await publish(event, relays, 1500);
	assert.deepEqual(accepted, [ok.url]);
	assert.ok(Date.now() - started < 5000, "a stalled relay must not hold the publish past its timeout");

	const found = await query({ authors: [key.issuer], kinds: [1], "#x": ["ab".repeat(32)] }, relays, 1500);
	assert.deepEqual(
		found.map((e) => e.id),
		[event.id],
		"the forged copy is dropped and the real one kept once",
	);
});
