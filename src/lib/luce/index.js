/**
 * Luce Blockchain RPC Client
 * @module luce
 *
 * Communicates with the Luce blockchain server running on the local machine.
 * All POST /blocks calls go through localhostOnly middleware, so the bot must
 * run on the same host as the Luce server.
 */

const LUCE_PORT = process.env.LUCE_PORT || '5500';
const BASE_URL = `http://127.0.0.1:${LUCE_PORT}/api/v1`;

/**
 * Append a new block to the blockchain.
 *
 * @param {object} params
 * @param {number|string} params.author - Discord user ID (block author)
 * @param {string} params.data - Block data (JSON string)
 * @returns {Promise<object>} The created block response
 */
async function appendBlock({ author, data }) {
	const res = await fetch(`${BASE_URL}/blocks`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ author: Number(author), data })
	});

	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error(`Blockchain append failed (${res.status}): ${body.error || res.statusText}`);
	}

	return res.json();
}

/**
 * List all blocks (newest last).
 * @returns {Promise<object[]>}
 */
async function listBlocks() {
	const res = await fetch(`${BASE_URL}/blocks`);
	if (!res.ok) throw new Error(`Blockchain list failed (${res.status})`);
	return res.json();
}

/**
 * Get a single block by height.
 * @param {number} height
 * @returns {Promise<object>}
 */
async function getBlock(height) {
	const res = await fetch(`${BASE_URL}/blocks/${height}`);
	if (!res.ok) throw new Error(`Blockchain get failed (${res.status})`);
	return res.json();
}

/**
 * Get current chain height.
 * @returns {Promise<number>}
 */
async function getHeight() {
	const res = await fetch(`${BASE_URL}/chain/height`);
	if (!res.ok) throw new Error(`Blockchain height failed (${res.status})`);
	const body = await res.json();
	return body.height;
}

/**
 * Validate the chain.
 * @returns {Promise<boolean>}
 */
async function validateChain() {
	const res = await fetch(`${BASE_URL}/chain/validate`);
	if (!res.ok) throw new Error(`Blockchain validate failed (${res.status})`);
	const body = await res.json();
	return body.valid;
}

module.exports = {
	appendBlock,
	listBlocks,
	getBlock,
	getHeight,
	validateChain
};
