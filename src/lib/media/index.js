/**
 * Turns a Discord message into model input.
 *
 * A message is more than its text. It can carry attachments, and a link can
 * expand into an embed card with a title, a description and a picture. Both
 * belong in the transcript. Otherwise the model answers a poster it never read,
 * which is exactly the kind of confident nonsense the chat service is supposed
 * to avoid.
 *
 * Two halves:
 * - `describeMessage` is synchronous and network free. It renders the text,
 *   an attachment marker per file, and the embed card as indented lines, all
 *   within one character budget.
 * - `collectImages` downloads real image attachments and returns data URLs for
 *   the vision parts of the prompt. A GIF becomes four samples over time: the
 *   first frame, 25%, 50% and the last. Those four frames are one animation,
 *   and the label says so.
 *
 * Constraints the code keeps:
 * - Embed and thumbnail URLs are never fetched. They point at arbitrary third
 *   party hosts, so downloading them is a tracking-pixel and SSRF vector, and
 *   their text is already in the transcript.
 * - Every download is bounded by size and by a timeout, and a failure is not
 *   fatal. A message keeps its text and loses only the picture.
 * - Attachments are re-encoded to JPEG at a bounded width. A 4 MB screenshot
 *   must not cost a megabyte of base64 or an enormous image token count.
 *
 * @module lib/media
 */

const sharp = require('sharp');
const { fetchBytes } = require('./fetch');
const { logger } = require('../logger');

const mediaLog = logger.child('Media');

const MAX_EMBEDS = 3;
const MAX_EMBED_FIELDS = 5;
const MAX_EMBED_DESCRIPTION_CHARS = 400;
const MAX_ATTACHMENTS = 4;
const MAX_MESSAGE_CHARS = 1200;
// A download or a decode is cached so a re-scheduled pass does not repeat it.
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_LIMIT = 60;

const DEFAULTS = {
	maxWidth: 1024,
	maxBytes: 8 * 1024 * 1024,
	maxImages: 6,
	jpegQuality: 82,
	timeoutMs: 15_000
};

/** `${messageId}:${attachmentId}` → { at, images } */
const cache = new Map();

/** Collapse whitespace and cap a string for a single prompt line. */
function _clip(text, max) {
	const flat = String(text ?? '')
		.replace(/\s+/g, ' ')
		.trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** "1.2 MB", "340 KB", or null when the size is unknown. */
function _size(bytes) {
	const n = Number(bytes);
	if (!Number.isFinite(n) || n <= 0) {
		return null;
	}
	if (n >= 1024 * 1024) {
		return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	}
	if (n >= 1024) {
		return `${Math.round(n / 1024)} KB`;
	}
	return `${n} B`;
}

function _isImage(attachment) {
	return /^image\//i.test(attachment?.contentType ?? '');
}

function _isGif(attachment) {
	return /^image\/(gif|apng)$/i.test(attachment?.contentType ?? '');
}

/** Plain attachment records, the shape the chat buffer stores. */
function attachmentsOf(message) {
	const list = [...(message?.attachments?.values?.() ?? [])];
	return list.slice(0, MAX_ATTACHMENTS).map(attachment => ({
		id: attachment.id ?? null,
		name: attachment.name ?? null,
		contentType: attachment.contentType ?? null,
		size: attachment.size ?? null,
		width: attachment.width ?? null,
		height: attachment.height ?? null,
		// The proxy URL is the Discord CDN, not a third party host.
		url: attachment.proxyURL ?? attachment.url ?? null
	}));
}

/** Whether a message carries anything beyond its text. */
function hasVisuals(message) {
	const attachments = message?.attachments;
	const hasAttachments = attachments?.size ? attachments.size > 0 : (attachments?.length ?? 0) > 0;
	return hasAttachments || (message?.embeds?.length ?? 0) > 0;
}

/** One marker line: `[gambar "poster.png", 1080x1350]`. */
function _attachmentLine(attachment) {
	const name = _clip(attachment.name ?? 'file', 80);
	const size = _size(attachment.size);
	const dims = attachment.width && attachment.height ? `${attachment.width}x${attachment.height}` : null;

	if (_isGif(attachment)) {
		return `[GIF "${name}"${size ? `, ${size}` : ''}]`;
	}
	if (_isImage(attachment)) {
		return `[gambar "${name}"${dims ? `, ${dims}` : size ? `, ${size}` : ''}]`;
	}
	const type = _clip(attachment.contentType ?? 'file', 60);
	return `[file "${name}", ${type}${size ? `, ${size}` : ''}]`;
}

/**
 * The embed card as prompt lines. The first line is the header, later lines
 * are indented so they stay attached to the message that produced the link.
 *
 * @returns {string[]}
 */
function _embedLines(embed) {
	const kind = embed.type && embed.type !== 'rich' ? ` ${_clip(embed.type, 20)}` : '';
	let header = `[embed${kind}]`;
	if (embed.author?.name) {
		header += ` ${_clip(embed.author.name, 80)}`;
	}
	if (embed.title) {
		header += ` "${_clip(embed.title, 160)}"`;
	}

	const lines = [header];
	if (embed.description) {
		lines.push(`  ${_clip(embed.description, MAX_EMBED_DESCRIPTION_CHARS)}`);
	}

	const fields = Array.isArray(embed.fields) ? embed.fields : [];
	for (const field of fields.slice(0, MAX_EMBED_FIELDS)) {
		if (!field?.name && !field?.value) {
			continue;
		}
		lines.push(`  ${_clip(field.name, 80)}: ${_clip(field.value, 160)}`);
	}
	const hidden = fields.length - MAX_EMBED_FIELDS;
	if (hidden > 0) {
		lines.push(`  (+${hidden} field lain)`);
	}

	if (embed.url) {
		lines.push(`  url=${_clip(embed.url, 300)}`);
	}
	if (embed.image?.url) {
		lines.push(`  image=${_clip(embed.image.url, 300)}`);
	}
	if (embed.thumbnail?.url) {
		lines.push(`  thumbnail=${_clip(embed.thumbnail.url, 300)}`);
	}
	if (embed.footer?.text) {
		lines.push(`  ${_clip(embed.footer.text, 120)}`);
	}
	if (embed.provider?.name) {
		lines.push(`  via ${_clip(embed.provider.name, 80)}`);
	}
	return lines;
}

/**
 * The transcript text for one message: its content, then a marker per
 * attachment, then the embed card. Returns '' when there is nothing to show,
 * which is how an empty preview or a sticker-only message is skipped.
 *
 * @param {import('discord.js').Message|object} message
 * @param {{ maxChars?: number }} [options]
 * @returns {string}
 */
function describeMessage(message, { maxChars = MAX_MESSAGE_CHARS } = {}) {
	const lines = [];
	const text = message?.content?.trim();
	if (text) {
		lines.push(text);
	}
	for (const attachment of attachmentsOf(message)) {
		lines.push(_attachmentLine(attachment));
	}
	const embeds = Array.isArray(message?.embeds) ? message.embeds : [];
	for (const embed of embeds.slice(0, MAX_EMBEDS)) {
		if (embed) {
			lines.push(..._embedLines(embed));
		}
	}

	const out = lines.join('\n').trim();
	return out.length > maxChars ? `${out.slice(0, maxChars).trimEnd()}…` : out;
}

/**
 * Sample indices for an animation: first, 25%, 50% and last frame.
 * A short animation is not sampled four times at the same spot.
 *
 * @param {number} pages - total frames
 * @returns {number[]} sorted, deduped frame indices
 */
function gifFrameIndices(pages) {
	const total = Math.max(1, Math.floor(Number(pages) || 1));
	const last = total - 1;
	const indices = [0, Math.floor(last * 0.25), Math.floor(last * 0.5), last];
	return [...new Set(indices)].filter(index => index >= 0 && index <= last).sort((a, b) => a - b);
}

/**
 * Decode one attachment into JPEG frames. An animation yields the four
 * sampled frames, a still image yields one.
 *
 * @returns {Promise<Array<{ page: number, pages: number, dataUrl: string }>>}
 */
async function _decodeFrames(buffer, { maxWidth, jpegQuality }) {
	const meta = await sharp(buffer, { animated: true }).metadata();
	const pages = Math.max(1, meta.pages ?? 1);
	const indices = pages > 1 ? gifFrameIndices(pages) : [0];

	const frames = [];
	for (const page of indices) {
		const jpeg = await sharp(buffer, { page, pages: 1 })
			.flatten({ background: '#ffffff' })
			.resize({ width: maxWidth, withoutEnlargement: true })
			.jpeg({ quality: jpegQuality })
			.toBuffer();
		frames.push({ page, pages, dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}` });
	}
	return frames;
}

/** How a frame is described to the model. */
function _frameLabel(attachment, { page, pages }) {
	const name = _clip(attachment.name ?? 'gambar', 80);
	if (pages > 1) {
		const percent = Math.round((page / (pages - 1)) * 100);
		return `GIF "${name}" frame ${page + 1}/${pages} (${percent}% durasi)`;
	}
	return `gambar "${name}"`;
}

function _cacheSet(key, images) {
	cache.set(key, { at: Date.now(), images });
	while (cache.size > CACHE_LIMIT) {
		const oldest = cache.keys().next().value;
		cache.delete(oldest);
	}
}

/** One attachment as image parts, or [] when it cannot be read. */
async function _imagesFor(entry, attachment, options) {
	if (!attachment?.url || !_isImage(attachment)) {
		return [];
	}
	const key = `${entry.id}:${attachment.id ?? attachment.url}`;
	const hit = cache.get(key);
	if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
		return hit.images;
	}

	try {
		const buffer = await fetchBytes(attachment.url, options);
		const frames = await _decodeFrames(buffer, options);
		const images = frames.map(frame => ({
			kind: frame.pages > 1 ? 'gif' : 'image',
			name: attachment.name ?? null,
			frameIndex: frame.page,
			frameTotal: frame.pages,
			label: _frameLabel(attachment, frame),
			dataUrl: frame.dataUrl
		}));
		_cacheSet(key, images);
		return images;
	} catch (error) {
		mediaLog.warn(`Could not read attachment ${_clip(attachment.name ?? attachment.url, 80)} ${error.message}`);
		return [];
	}
}

/**
 * Image parts for the prompt, oldest message first.
 *
 * The budget is spent on the most recent attachments, because those are what
 * the conversation is about. A GIF spends up to four of them on one animation
 * so the model sees how it moves instead of a single misleading frame.
 *
 * @param {Array<{ id: string, attachments?: Array<object> }>} entries - buffered messages
 * @param {object} [options]
 * @returns {Promise<Array<{ messageId: string, kind: string, label: string, dataUrl: string }>>}
 */
async function collectImages(entries, options = {}) {
	const opts = { ...DEFAULTS, ...options };
	const maxImages = Math.max(1, opts.maxImages);

	// Walk the newest messages first so the budget lands on what was just said,
	// then put the groups back into chronological order. Frames inside one GIF
	// keep their own order.
	const groups = [];
	let used = 0;
	for (const entry of [...entries].reverse()) {
		if (used >= maxImages) {
			break;
		}
		for (const attachment of entry.attachments ?? []) {
			if (used >= maxImages) {
				break;
			}
			if (!_isImage(attachment)) {
				continue;
			}
			const frames = await _imagesFor(entry, attachment, opts);
			const take = frames.slice(0, maxImages - used);
			if (take.length > 0) {
				groups.push(take.map(frame => ({ messageId: entry.id, authorId: entry.authorId ?? null, ...frame })));
				used += take.length;
			}
		}
	}
	return groups.reverse().flat();
}

/** Test helper. Drop the download cache. */
function _reset() {
	cache.clear();
}

module.exports = {
	DEFAULTS,
	attachmentsOf,
	collectImages,
	describeMessage,
	gifFrameIndices,
	hasVisuals,
	_reset
};
