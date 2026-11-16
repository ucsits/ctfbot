/**
 * One bounded download, shared by the image and document readers.
 *
 * A Discord CDN attachment is untrusted input. Every fetch here has a size
 * ceiling and a timeout, and an oversized body is rejected before it is read
 * into memory when the server declares its length.
 *
 * @module lib/media/fetch
 */

/**
 * @param {string} url
 * @param {{ maxBytes: number, timeoutMs: number }} options
 * @returns {Promise<Buffer>}
 */
async function fetchBytes(url, { maxBytes, timeoutMs }) {
	const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
	if (!res.ok) {
		throw new Error(`HTTP ${res.status}`);
	}
	const declared = Number(res.headers?.get?.('content-length'));
	if (Number.isFinite(declared) && declared > maxBytes) {
		throw new Error(`too large (${declared} bytes)`);
	}
	const buffer = Buffer.from(await res.arrayBuffer());
	if (buffer.length > maxBytes) {
		throw new Error(`too large (${buffer.length} bytes)`);
	}
	return buffer;
}

module.exports = { fetchBytes };
