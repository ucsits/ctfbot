/**
 * Turns a document attachment into prompt text.
 *
 * A PDF, a DOCX, a spreadsheet or a CSV dropped in a channel is usually the
 * answer to the question in the next message. A filename marker alone makes the
 * model answer from the name, which is the confident nonsense the chat service
 * exists to avoid. This module reads the text and hands it to the prompt.
 *
 * Supported formats and their readers:
 * - CSV and TSV use a small delimited parser here. Quoted fields, CRLF, a BOM
 *   and a stray delimiter are handled. No dependency, because the bot already
 *   parses CSV for `/giveapbulk`.
 * - XLSX uses `read-excel-file`, every sheet, rendered as tab separated rows.
 * - DOCX uses `mammoth` for its raw text.
 * - PDF uses `pdfjs-dist` for the text layer of each page.
 *
 * Constraints the code keeps:
 * - Every download is bounded by size and timeout, through the same helper the
 *   image reader uses. A document that cannot be read costs its text, not the
 *   reply: the message keeps its marker and the pass continues.
 * - Output is bounded twice, per file and per prompt, so a spreadsheet with a
 *   hundred thousand rows cannot crowd the conversation out of the context.
 * - A scan without a text layer is not OCRed. It yields no text, which the
 *   prompt treats as an unreadable attachment.
 * - The extracted text is data from a member, never an instruction. The chat
 *   prompt labels it as such.
 *
 * @module lib/media/documents
 */

const path = require('path');
const { fetchBytes } = require('./fetch');
const { logger } = require('../logger');

const documentLog = logger.child('Documents');

// A download or a parse is cached so a re-scheduled pass does not repeat it.
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_LIMIT = 40;

const MAX_SHEETS = 5;
const MAX_COLUMNS = 20;
const MAX_CELL_CHARS = 100;

const DEFAULTS = {
	maxFiles: 3,
	maxBytes: 8 * 1024 * 1024,
	maxChars: 12_000,
	maxTotalChars: 24_000,
	maxPages: 30,
	maxRows: 200,
	timeoutMs: 15_000
};

/** Extension first: Discord often sends a document as application/octet-stream. */
const EXTENSIONS = [
	['.docx', 'docx'],
	['.xlsx', 'xlsx'],
	['.pdf', 'pdf'],
	['.csv', 'csv'],
	['.tsv', 'tsv']
];

const MIME_KINDS = new Map([
	['application/pdf', 'pdf'],
	['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
	['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
	['text/csv', 'csv'],
	['application/csv', 'csv'],
	['text/tab-separated-values', 'tsv'],
	['text/tsv', 'tsv']
]);

/** `${messageId}:${attachmentId}` → { at, document } */
const cache = new Map();

/**
 * Which reader handles this attachment, or null when none does.
 *
 * @param {{ name?: string, contentType?: string }} attachment
 * @returns {'docx'|'xlsx'|'pdf'|'csv'|'tsv'|null}
 */
function detectKind(attachment) {
	const name = String(attachment?.name ?? '').toLowerCase();
	for (const [extension, kind] of EXTENSIONS) {
		if (name.endsWith(extension)) {
			return kind;
		}
	}
	const mime = String(attachment?.contentType ?? '')
		.toLowerCase()
		.split(';')[0]
		.trim();
	return MIME_KINDS.get(mime) ?? null;
}

function isSupportedDocument(attachment) {
	return detectKind(attachment) !== null;
}

/** Collapse a cell to one line so it cannot break the tab separated layout. */
function _cellText(value) {
	if (value === null || value === undefined) {
		return '';
	}
	if (value instanceof Date) {
		return value.toISOString().slice(0, 10);
	}
	if (typeof value === 'object') {
		return '';
	}
	const flat = String(value).replace(/\s+/g, ' ').trim();
	return flat.length > MAX_CELL_CHARS ? `${flat.slice(0, MAX_CELL_CHARS)}…` : flat;
}

/**
 * A delimited file as rows of strings. Handles quoted fields, doubled quotes
 * and newlines inside quotes.
 *
 * @param {string} content
 * @param {string} [delimiter]
 * @returns {string[][]}
 */
function parseDelimited(content, delimiter = ',') {
	const text = String(content ?? '').replace(/^\uFEFF/, '');
	const rows = [];
	let row = [];
	let field = '';
	let quoted = false;
	let i = 0;

	while (i < text.length) {
		const ch = text[i];
		if (quoted) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				quoted = false;
				i += 1;
				continue;
			}
			field += ch;
			i += 1;
			continue;
		}
		if (ch === '"' && field.length === 0) {
			quoted = true;
			i += 1;
			continue;
		}
		if (ch === delimiter) {
			row.push(field);
			field = '';
			i += 1;
			continue;
		}
		if (ch === '\r' || ch === '\n') {
			if (ch === '\r' && text[i + 1] === '\n') {
				i += 1;
			}
			row.push(field);
			rows.push(row);
			row = [];
			field = '';
			i += 1;
			continue;
		}
		field += ch;
		i += 1;
	}
	if (field.length > 0 || row.length > 0) {
		row.push(field);
		rows.push(row);
	}

	// A trailing newline, or a line of empty cells, is not a record.
	return rows.filter(cells => cells.some(cell => cell !== ''));
}

/**
 * Sniff the delimiter from the first lines. A CSV exported in a locale that
 * uses semicolons is common enough that assuming a comma is not safe.
 *
 * @param {string} content
 * @param {'csv'|'tsv'} kind
 * @returns {string}
 */
function detectDelimiter(content, kind) {
	if (kind === 'tsv') {
		return '\t';
	}
	const sample = String(content ?? '')
		.replace(/^\uFEFF/, '')
		.split(/\r?\n/)
		.filter(line => line.trim())
		.slice(0, 5)
		.join('\n');

	const counts = { ',': 0, ';': 0, '\t': 0 };
	let quoted = false;
	for (const ch of sample) {
		if (ch === '"') {
			quoted = !quoted;
			continue;
		}
		if (!quoted && ch in counts) {
			counts[ch] += 1;
		}
	}
	const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
	return best && best[1] > 0 ? best[0] : ',';
}

/** Render rows as tab separated text within the row and column budget. */
function _rowsToText(rows, { maxRows }) {
	const shown = rows.slice(0, Math.max(1, maxRows));
	let truncated = rows.length > shown.length;
	const lines = shown.map(cells => {
		if (cells.length > MAX_COLUMNS) {
			truncated = true;
		}
		return cells
			.slice(0, MAX_COLUMNS)
			.map(cell => {
				const flat = String(cell ?? '')
					.replace(/\s+/g, ' ')
					.trim();
				if (flat.length > MAX_CELL_CHARS) {
					truncated = true;
				}
				return _cellText(cell);
			})
			.join('\t')
			.replace(/\t+$/, '');
	});
	return { text: lines.join('\n'), rows: shown.length, truncated };
}

/** One CSV or TSV buffer as text plus a one-line summary. */
function _delimitedText(buffer, kind, options) {
	const content = buffer.toString('utf8');
	const rows = parseDelimited(content, detectDelimiter(content, kind));
	const rendered = _rowsToText(rows, options);
	return {
		text: rendered.text,
		summary: `${rows.length} baris${rendered.truncated ? `, dibaca ${rendered.rows}` : ''}`,
		truncated: rendered.truncated
	};
}

async function _xlsxText(buffer, options) {
	const readXlsxFile = require('read-excel-file/node').default;
	const sheets = await readXlsxFile(buffer);
	const blocks = [];
	let rowCount = 0;
	let truncated = sheets.length > MAX_SHEETS;
	for (const { sheet, data } of sheets.slice(0, MAX_SHEETS)) {
		const rendered = _rowsToText(data ?? [], options);
		blocks.push(`# sheet: ${_cellText(sheet)}\n${rendered.text}`);
		rowCount += rendered.rows;
		truncated = truncated || rendered.truncated;
	}
	return {
		text: blocks.join('\n\n'),
		summary: `${sheets.length} sheet, ${rowCount} baris`,
		truncated
	};
}

async function _docxText(buffer) {
	const mammoth = require('mammoth');
	const { value } = await mammoth.extractRawText({ buffer });
	const words = value.trim() ? value.trim().split(/\s+/).length : 0;
	return { text: value, summary: `${words} kata` };
}

/** Text layer of a PDF, page by page. A scan without one yields nothing. */
async function _pdfText(buffer, options) {
	// The browser build is deliberate. The legacy build requires the optional
	// native `canvas` package as soon as it is loaded, and text extraction does
	// not render anything, so that dependency is not worth its build step.
	const pdfjs = require('pdfjs-dist/build/pdf.js');
	// The standard font data ships with the package. Without the path pdfjs
	// prints a warning for every font and still extracts the text.
	const standardFontDataUrl =
		path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep;

	const task = pdfjs.getDocument({
		data: new Uint8Array(buffer),
		standardFontDataUrl,
		useSystemFonts: false,
		isEvalSupported: false,
		disableFontFace: true,
		// A malformed document should not print its own diagnostics to stdout.
		verbosity: 0
	});
	const doc = await task.promise;
	try {
		const pages = Math.min(doc.numPages, Math.max(1, options.maxPages));
		const blocks = [];
		for (let number = 1; number <= pages; number++) {
			const page = await doc.getPage(number);
			const content = await page.getTextContent();
			let text = '';
			for (const item of content.items ?? []) {
				if (typeof item?.str !== 'string') {
					continue;
				}
				text += item.str;
				text += item.hasEOL ? '\n' : ' ';
			}
			blocks.push(`[halaman ${number}]\n${text.trimEnd()}`);
			page.cleanup?.();
		}
		return {
			text: blocks.join('\n\n'),
			summary: `${doc.numPages} halaman${pages < doc.numPages ? `, dibaca ${pages}` : ''}`,
			truncated: pages < doc.numPages
		};
	} finally {
		await doc.destroy?.();
	}
}

/** Tidy line endings and blank runs without flattening the layout. */
function _normalize(text) {
	return String(text ?? '')
		.replace(/\r\n?/g, '\n')
		.replaceAll('\u0000', '')
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function _truncate(text, maxChars) {
	if (text.length <= maxChars) {
		return { text, truncated: false };
	}
	return { text: `${text.slice(0, maxChars).trimEnd()}…`, truncated: true };
}

/**
 * Read one supported buffer into text.
 *
 * @param {Buffer} buffer
 * @param {{ name?: string, contentType?: string }} attachment
 * @param {object} [options]
 * @returns {Promise<{ kind: string, text: string, chars: number, truncated: boolean, summary: string }>}
 */
async function extractText(buffer, attachment, options = {}) {
	const opts = { ...DEFAULTS, ...options };
	const kind = detectKind(attachment);
	if (!kind) {
		throw new Error('unsupported document type');
	}

	let raw;
	switch (kind) {
		case 'csv':
		case 'tsv':
			raw = _delimitedText(buffer, kind, opts);
			break;
		case 'xlsx':
			raw = await _xlsxText(buffer, opts);
			break;
		case 'docx':
			raw = await _docxText(buffer);
			break;
		case 'pdf':
			raw = await _pdfText(buffer, opts);
			break;
		default:
			throw new Error(`unsupported document type ${kind}`);
	}

	const clipped = _truncate(_normalize(raw.text), Math.max(1, opts.maxChars));
	return {
		kind,
		text: clipped.text,
		chars: clipped.text.length,
		truncated: clipped.truncated || Boolean(raw.truncated),
		summary: raw.summary
	};
}

function _cacheSet(key, document) {
	cache.set(key, { at: Date.now(), document });
	while (cache.size > CACHE_LIMIT) {
		const oldest = cache.keys().next().value;
		cache.delete(oldest);
	}
}

/** One attachment as a parsed document, or null when it cannot be read. */
async function _documentFor(entry, attachment, options) {
	if (!attachment?.url) {
		return null;
	}
	const key = `${entry.id}:${attachment.id ?? attachment.url}`;
	const hit = cache.get(key);
	if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
		return hit.document;
	}

	try {
		const buffer = await fetchBytes(attachment.url, options);
		const document = await extractText(buffer, attachment, options);
		_cacheSet(key, document);
		return document;
	} catch (error) {
		documentLog.warn(
			`Could not read document ${String(attachment.name ?? attachment.url).slice(0, 80)} ${error.message}`
		);
		return null;
	}
}

/**
 * Document parts for the prompt, oldest message first.
 *
 * The budget is spent on the newest attachments, because those are what the
 * conversation is about. A file that does not fit is skipped rather than
 * half-read, and the total character budget is shared across all files.
 *
 * @param {Array<{ id: string, authorId?: string, attachments?: Array<object> }>} entries - buffered messages
 * @param {object} [options]
 * @returns {Promise<Array<{ messageId: string, authorId: string|null, name: string|null, size: number|null, kind: string, summary: string, chars: number, truncated: boolean, text: string }>>}
 */
async function collectDocuments(entries, options = {}) {
	const opts = { ...DEFAULTS, ...options };
	const maxFiles = Math.max(1, opts.maxFiles);
	const maxTotalChars = Math.max(1, opts.maxTotalChars);

	const groups = [];
	let used = 0;
	for (const entry of [...entries].reverse()) {
		if (groups.length >= maxFiles || used >= maxTotalChars) {
			break;
		}
		for (const attachment of entry.attachments ?? []) {
			if (groups.length >= maxFiles || used >= maxTotalChars) {
				break;
			}
			if (!isSupportedDocument(attachment)) {
				continue;
			}
			const document = await _documentFor(entry, attachment, opts);
			if (!document || !document.text) {
				continue;
			}
			const room = maxTotalChars - used;
			const clipped = _truncate(document.text, room);
			groups.push({
				messageId: entry.id,
				authorId: entry.authorId ?? null,
				name: attachment.name ?? null,
				size: attachment.size ?? null,
				kind: document.kind,
				summary: document.summary,
				chars: clipped.text.length,
				truncated: document.truncated || clipped.truncated,
				text: clipped.text
			});
			used += clipped.text.length;
		}
	}
	return groups.reverse();
}

/** Test helper. Drop the parse cache. */
function _reset() {
	cache.clear();
}

module.exports = {
	DEFAULTS,
	collectDocuments,
	detectDelimiter,
	detectKind,
	extractText,
	isSupportedDocument,
	parseDelimited,
	_reset
};
