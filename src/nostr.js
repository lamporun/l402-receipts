// A minimal Nostr relay client: publish one event, or query with one filter.
//
// It uses Node's own WebSocket, and a relay that refuses the connection,
// never answers or closes midway only counts as a failed relay: nothing here
// can throw past the returned promise. (nostr-tools' pool can crash the
// process when a relay connection fails under Node 22.)

import { verifyEvent } from "nostr-tools/pure";

/**
 * Runs one exchange with a relay. `onMessage` returns true when the exchange
 * is complete. Resolves when it is, or on any failure or timeout.
 * @param {string} url
 * @param {unknown[]} first the message sent once connected
 * @param {(msg: any[]) => boolean} onMessage
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} whether the exchange completed
 */
function exchange(url, first, onMessage, timeoutMs) {
	return new Promise((resolve) => {
		/** @type {WebSocket | null} */
		let ws = null;
		let done = false;
		const finish = (/** @type {boolean} */ ok) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			const socket = ws;
			if (socket) {
				socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
				// Closing from inside an error handler can re-enter it; do it later.
				setImmediate(() => {
					try {
						socket.close();
					} catch {
						// Already closed.
					}
				});
			}
			resolve(ok);
		};
		const timer = setTimeout(() => finish(false), timeoutMs);
		try {
			ws = new WebSocket(url);
		} catch {
			finish(false);
			return;
		}
		ws.onopen = () => {
			try {
				ws?.send(JSON.stringify(first));
			} catch {
				finish(false);
			}
		};
		ws.onmessage = (ev) => {
			let msg;
			try {
				msg = JSON.parse(String(ev.data));
			} catch {
				return;
			}
			if (Array.isArray(msg) && onMessage(msg)) finish(true);
		};
		ws.onerror = () => finish(false);
		ws.onclose = () => finish(false);
	});
}

/**
 * Publishes a signed event. Resolves with the relays that accepted it.
 * @param {{ id: string }} event
 * @param {string[]} relays
 * @param {number} [timeoutMs]
 */
export async function publish(event, relays, timeoutMs = 10000) {
	const results = await Promise.all(
		relays.map(async (url) => {
			let accepted = false;
			await exchange(
				url,
				["EVENT", event],
				(msg) => {
					if (msg[0] === "OK" && msg[1] === event.id) {
						accepted = msg[2] === true;
						return true;
					}
					return false;
				},
				timeoutMs,
			);
			return accepted;
		}),
	);
	return relays.filter((_, i) => results[i]);
}

/**
 * Queries relays with one filter. Resolves with the valid events found,
 * deduplicated, newest first.
 * @param {Record<string, unknown>} filter
 * @param {string[]} relays
 * @param {number} [timeoutMs]
 * @returns {Promise<any[]>}
 */
export async function query(filter, relays, timeoutMs = 8000) {
	/** @type {Map<string, any>} */
	const found = new Map();
	await Promise.all(
		relays.map((url) => {
			const sub = `q${Math.random().toString(36).slice(2, 10)}`;
			return exchange(
				url,
				["REQ", sub, filter],
				(msg) => {
					if (msg[0] === "EVENT" && msg[1] === sub && msg[2] && !found.has(msg[2].id)) {
						try {
							if (verifyEvent(msg[2])) found.set(msg[2].id, msg[2]);
						} catch {
							// A malformed event.
						}
					}
					return (msg[0] === "EOSE" || msg[0] === "CLOSED") && msg[1] === sub;
				},
				timeoutMs,
			);
		}),
	);
	return [...found.values()].sort((a, b) => b.created_at - a.created_at);
}
