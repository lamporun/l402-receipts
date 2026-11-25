/**
 * Publishes a signed event. Resolves with the relays that accepted it.
 * @param {{ id: string }} event
 * @param {string[]} relays
 * @param {number} [timeoutMs]
 */
export declare function publish(event: {
    id: string;
}, relays: string[], timeoutMs?: number): Promise<string[]>;
/**
 * Queries relays with one filter. Resolves with the valid events found,
 * deduplicated, newest first.
 * @param {Record<string, unknown>} filter
 * @param {string[]} relays
 * @param {number} [timeoutMs]
 * @returns {Promise<any[]>}
 */
export declare function query(filter: Record<string, unknown>, relays: string[], timeoutMs?: number): Promise<any[]>;
