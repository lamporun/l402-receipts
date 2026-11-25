// The issuer's anchor directory and the daily anchoring job.
//
//   <day>.json        the signed anchor, served publicly
//   <day>.ots         its OpenTimestamps proof, served publicly
//   <day>.ots.json    the stamp state the proof is rebuilt from on upgrade
//   <day>.nostr.json  the published Nostr note and the relays that took it

import fs from "node:fs";
import path from "node:path";
import { finalizeEvent } from "nostr-tools/pure";
import { addDays, anchorNote, dayBounds, dayOf, makeAnchor } from "./anchor.js";
import { GENESIS } from "./receipt.js";
import * as ots from "./ots.js";

/** @typedef {import("./anchor.js").Anchor} Anchor */
/** @typedef {import("./ledger.js").Ledger} Ledger */

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;

/** @param {string} file @param {string | Uint8Array} data */
function writeAtomic(file, data) {
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, data, { mode: 0o644 });
	fs.renameSync(tmp, file);
}

export class AnchorDir {
	/** @param {string} dir */
	constructor(dir) {
		this.dir = dir;
		fs.mkdirSync(dir, { recursive: true });
	}

	/** Anchored days, oldest first. */
	days() {
		return fs
			.readdirSync(this.dir)
			.map((f) => DAY_FILE.exec(f)?.[1])
			.filter((d) => d !== undefined)
			.sort();
	}

	/** @param {string} day @returns {Anchor | null} */
	get(day) {
		try {
			return JSON.parse(fs.readFileSync(path.join(this.dir, `${day}.json`), "utf8"));
		} catch {
			return null;
		}
	}

	/** @param {Anchor} a */
	put(a) {
		writeAtomic(path.join(this.dir, `${a.day}.json`), `${JSON.stringify(a, null, 1)}\n`);
	}

	/** @param {string} day @param {string} ext */
	file(day, ext) {
		return path.join(this.dir, `${day}${ext}`);
	}

	/** @param {string} day @param {string} ext @returns {any} */
	readJson(day, ext) {
		try {
			return JSON.parse(fs.readFileSync(this.file(day, ext), "utf8"));
		} catch {
			return null;
		}
	}

	/** @param {string} day @param {string} ext @param {unknown} value */
	writeJson(day, ext, value) {
		writeAtomic(this.file(day, ext), `${JSON.stringify(value, null, 1)}\n`);
	}
}

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
 * Publishes an event to relays. Resolves with the relays that accepted it.
 * @param {any} event
 * @param {string[]} relays
 */
async function publishToRelays(event, relays) {
	const { SimplePool } = await import("nostr-tools/pool");
	const pool = new SimplePool();
	try {
		const results = await Promise.allSettled(pool.publish(relays, event));
		return relays.filter((_, i) => results[i].status === "fulfilled");
	} finally {
		pool.close(relays);
	}
}

/**
 * Anchors every complete UTC day from `since` to yesterday that has no
 * anchor yet, then retries missing timestamps and notes, and upgrades
 * pending timestamps. Safe to run as often as wanted.
 * @param {AnchorJobOptions} o
 */
export async function runAnchorJob(o) {
	const log = o.log ?? (() => {});
	const publish = o.publish ?? publishToRelays;
	const now = o.now ?? Math.floor(Date.now() / 1000);
	const yesterday = addDays(dayOf(now), -1);
	const made = [];

	const existing = o.anchors.days();
	let day = existing.length ? addDays(existing[existing.length - 1], 1) : o.since;
	let prev = existing.length ? /** @type {Anchor} */ (o.anchors.get(existing[existing.length - 1])).id : GENESIS;
	for (; day <= yesterday; day = addDays(day, 1)) {
		const [from, to] = dayBounds(day);
		const leaves = o.ledger.idsBetween(from, to);
		const a = makeAnchor({ day, leaves, prev, issuer: o.issuer, secretKey: o.secretKey });
		o.anchors.put(a);
		made.push(a);
		prev = a.id;
		log(`anchored ${day}: ${a.count} receipts, root ${a.root}`);
	}

	for (const d of o.anchors.days()) {
		const a = /** @type {Anchor} */ (o.anchors.get(d));
		const url = `${o.publicUrl}/receipts/anchors/${d}.json`;

		if (o.timestamp) {
			/** @type {ots.OtsState | null} */
			let state = o.anchors.readJson(d, ".ots.json");
			try {
				if (!state) {
					state = await ots.stamp(a.id);
					log(`timestamped ${d} with ${state.branches.length} calendars`);
				} else if (state.branches.some((b) => !b.complete)) {
					const up = await ots.upgrade(state);
					if (up.changed) log(`timestamp of ${d} is now anchored in Bitcoin`);
					state = up.changed ? up.state : null;
				} else {
					state = null;
				}
				if (state) {
					o.anchors.writeJson(d, ".ots.json", state);
					fs.writeFileSync(o.anchors.file(d, ".ots"), ots.otsFile(state), { mode: 0o644 });
				}
			} catch (e) {
				log(`timestamp of ${d} failed: ${/** @type {Error} */ (e).message}`);
			}
		}

		if (o.relays.length && a.count > 0 && !o.anchors.readJson(d, ".nostr.json")) {
			try {
				const event = finalizeEvent(anchorNote(a, url, o.seller), o.secretKey);
				const accepted = await publish(event, o.relays);
				if (accepted.length) {
					o.anchors.writeJson(d, ".nostr.json", { event, relays: accepted });
					log(`published ${d} on ${accepted.length} relays: ${event.id}`);
				} else {
					log(`no relay accepted the note for ${d}`);
				}
			} catch (e) {
				log(`publishing ${d} failed: ${/** @type {Error} */ (e).message}`);
			}
		}
	}
	return made;
}
