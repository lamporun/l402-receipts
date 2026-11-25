import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalize } from "../src/canonical.js";
import { parseCredential } from "../src/credential.js";
import { auditPath, merkleRoot, verifyInclusion } from "../src/merkle.js";
import { checkSignature, expectedDebit, GENESIS, signReceipt, weightedDebit } from "../src/receipt.js";
import { checkChain } from "../src/verify.js";
import { l402Credential, testKey } from "./helpers.js";

test("canonical JSON sorts keys and refuses what it cannot reproduce", () => {
	assert.equal(canonicalize({ b: 1, a: [true, null, "x"], c: { z: 0, y: -2 } }), '{"a":[true,null,"x"],"b":1,"c":{"y":-2,"z":0}}');
	assert.throws(() => canonicalize({ a: 1.5 }));
	assert.throws(() => canonicalize({ a: 2 ** 60 }));
	assert.throws(() => canonicalize({ a: new Date() }));
});

test("weighted debits match Aperture's meter", () => {
	// The vectors of Aperture's meterd tests.
	const rates = { input_msat_per_ktok: 1000000, output_msat_per_ktok: 2000000, cached_input_permille: 1000 };
	assert.equal(weightedDebit({ prompt: 100, cached: 0, completion: 200 }, rates), 334);
	assert.equal(weightedDebit({ prompt: 1000, cached: 800, completion: 300 }, { ...rates, cached_input_permille: 100 }), 587);
	// Cached tokens never exceed the prompt, as in the meter.
	assert.equal(weightedDebit({ prompt: 10, cached: 50, completion: 0 }, { ...rates, cached_input_permille: 0 }), 0);
	// Rounding is up, never in the buyer's favor and never more than one token.
	assert.equal(weightedDebit({ prompt: 1, cached: 0, completion: 0 }, rates), 1);
});

test("expected debits follow the receipt's source", () => {
	const base = /** @type {any} */ ({ usage: null, rates: null });
	assert.equal(expectedDebit({ ...base, source: "split", usage: { prompt: 3, cached: 0, completion: 2 } }), 5);
	assert.equal(expectedDebit({ ...base, source: "total", usage: { total: 42 } }), 42);
	assert.equal(expectedDebit({ ...base, source: "estimate" }), null);
	assert.equal(expectedDebit({ ...base, source: "plain" }), null);
});

test("audit paths prove inclusion for every leaf of every tree size", () => {
	assert.equal(merkleRoot([]), bytesToHex(sha256(new Uint8Array(0))));
	for (let n = 1; n <= 33; n++) {
		const ids = Array.from({ length: n }, (_, i) => bytesToHex(sha256(Uint8Array.of(i))));
		const root = merkleRoot(ids);
		for (let m = 0; m < n; m++) {
			const path = auditPath(ids, m);
			assert.ok(verifyInclusion(ids[m], m, n, path, root), `n=${n} m=${m}`);
			assert.ok(!verifyInclusion(ids[(m + 1) % n], m, n, path, root) || n === 1, `wrong leaf n=${n} m=${m}`);
			if (n > 1) assert.ok(!verifyInclusion(ids[m], (m + 1) % n, n, path, root), `wrong index n=${n} m=${m}`);
			// The size is not bound by the path alone (the anchor's signed
			// count is what fixes it), but an index outside it never verifies.
			assert.ok(!verifyInclusion(ids[m], n, n, path, root), `index past the end n=${n} m=${m}`);
		}
	}
});

test("RFC 6962 tree shape: three leaves split two and one", () => {
	const ids = ["00", "01", "02"].map((b) => b.repeat(32));
	const leaf = (/** @type {string} */ id) => sha256(Uint8Array.from([0, ...Buffer.from(id, "hex")]));
	const node = (/** @type {Uint8Array} */ l, /** @type {Uint8Array} */ r) => sha256(Uint8Array.from([1, ...l, ...r]));
	const want = node(node(leaf(ids[0]), leaf(ids[1])), leaf(ids[2]));
	assert.equal(merkleRoot(ids), bytesToHex(want));
});

test("credentials: the preimage must pay the macaroon", () => {
	const c = l402Credential(1);
	const parsed = parseCredential(c.header);
	assert.equal(parsed.token, c.token);
	assert.equal(parsed.paymentHash, c.paymentHash);
	assert.equal(parseCredential(c.header.replace(/^L402/, "LSAT")).token, c.token);

	const other = l402Credential(2);
	assert.throws(() => parseCredential(`${c.header.split(":")[0]}:${other.preimage}`), /does not pay/);
	assert.throws(() => parseCredential("Bearer abc"));
	assert.throws(() => parseCredential("L402 AAAA:" + "0".repeat(64)));

	const mpp = Buffer.from(JSON.stringify({ challenge: {}, payload: { preimage: c.preimage } })).toString("base64url");
	const m = parseCredential(`Payment ${mpp}`);
	assert.equal(m.scheme, "mpp");
	assert.equal(m.token, c.paymentHash);
});

/** A valid history of three debits. */
function history() {
	const key = testKey();
	const c = l402Credential(3);
	const rates = { input_msat_per_ktok: 1000000, output_msat_per_ktok: 2000000, cached_input_permille: 100 };
	const usages = [
		{ prompt: 1000, cached: 800, completion: 300 },
		{ prompt: 100, cached: 0, completion: 200 },
	];
	let remaining = 10000;
	let prev = GENESIS;
	const out = [];
	for (const [i, usage] of usages.entries()) {
		const debit = weightedDebit(usage, rates);
		remaining -= debit;
		const r = signReceipt(
			{
				v: 1,
				issuer: key.issuer,
				token: c.token,
				payment_hash: c.paymentHash,
				seq: i + 1,
				event: 10 + i,
				time: 1795600000 + i,
				model: "m",
				price_sats: 1000,
				source: "split",
				usage,
				rates,
				debit,
				remaining,
				prev,
			},
			key.secretKey,
		);
		prev = r.id;
		out.push(r);
	}
	return { key, c, rates, receipts: out };
}

test("a valid history checks out", () => {
	const { key, c, receipts } = history();
	const report = checkChain(receipts, { issuer: key.issuer, credential: c });
	assert.deepEqual(report.problems, []);
	assert.equal(report.recomputed, 2);
	assert.equal(report.initialTokens, 10000);
	assert.equal(report.debited, 587 + 334);
	assert.equal(report.remaining, 10000 - 587 - 334);
});

test("every kind of tampering is caught", () => {
	const { key, c, receipts } = history();
	const check = (/** @type {any[]} */ list) => checkChain(list, { issuer: key.issuer, credential: c }).problems.join("\n");

	// A changed field without a new signature.
	assert.match(check([{ ...receipts[0], debit: 600 }, receipts[1]]), /id does not match/);

	// A re-signed overcharge: the arithmetic no longer holds.
	const over = signReceipt({ ...receipts[0], debit: 600, remaining: 9400 }, key.secretKey);
	assert.match(check([over]), /its usage at its rates costs 587/);

	// A dropped receipt.
	assert.match(check([receipts[1]]), /does not start at receipt 1/);

	// A balance that skips ahead.
	const skip = signReceipt({ ...receipts[1], remaining: receipts[1].remaining - 50 }, key.secretKey);
	assert.match(check([receipts[0], skip]), /balance/);

	// A receipt re-signed onto another history: right seq and balance,
	// wrong link.
	const relinked = signReceipt({ ...receipts[1], prev: "ab".repeat(32) }, key.secretKey);
	assert.match(check([receipts[0], relinked]), /does not chain to receipt 1/);

	// A forged signer.
	const other = testKey(2);
	assert.match(check([signReceipt({ ...receipts[0], issuer: other.issuer }, other.secretKey)]), /expected/);

	// Someone else's receipts.
	assert.match(checkChain(receipts, { issuer: key.issuer, credential: l402Credential(4) }).problems.join(), /another bundle/);

	// A signature over another receipt.
	assert.deepEqual(checkSignature({ ...receipts[0], sig: receipts[1].sig }, key.issuer), ["bad signature"]);
});
