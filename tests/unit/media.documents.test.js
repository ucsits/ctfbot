import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as documents from '../../src/lib/media/documents.js';

const fixture = name => readFileSync(join(import.meta.dirname, '../fixtures/documents', name));

beforeEach(() => {
	documents._reset();
});

/** A fetch response double with a declared length and the given bytes. */
const ok = bytes => ({
	ok: true,
	headers: { get: () => String(bytes.length) },
	arrayBuffer: () => Promise.resolve(bytes)
});

describe('documents.detectKind', () => {
	it('recognises a supported extension even when Discord sends octet-stream', () => {
		expect(documents.detectKind({ name: 'rekap.csv', contentType: 'application/octet-stream' })).toBe('csv');
		expect(documents.detectKind({ name: 'data.tsv' })).toBe('tsv');
		expect(documents.detectKind({ name: 'laporan.PDF' })).toBe('pdf');
		expect(documents.detectKind({ name: 'brief.docx' })).toBe('docx');
		expect(documents.detectKind({ name: 'poin.xlsx' })).toBe('xlsx');
	});

	it('falls back to the MIME type when the name has no extension', () => {
		expect(documents.detectKind({ name: 'brief', contentType: 'application/pdf' })).toBe('pdf');
		expect(
			documents.detectKind({
				name: 'brief',
				contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
			})
		).toBe('docx');
		expect(
			documents.detectKind({
				name: 'poin',
				contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
			})
		).toBe('xlsx');
		expect(documents.detectKind({ name: 'x', contentType: 'text/csv; charset=utf-8' })).toBe('csv');
	});

	it('rejects anything else', () => {
		expect(documents.detectKind({ name: 'notes.txt', contentType: 'text/plain' })).toBeNull();
		expect(documents.detectKind({ name: 'poster.png', contentType: 'image/png' })).toBeNull();
		expect(documents.detectKind({})).toBeNull();
		expect(documents.isSupportedDocument({ name: 'rekap.csv' })).toBe(true);
		expect(documents.isSupportedDocument({ name: 'rekap.txt' })).toBe(false);
	});
});

describe('documents.parseDelimited', () => {
	it('handles quoted fields, doubled quotes and newlines inside quotes', () => {
		const rows = documents.parseDelimited('nama,catatan\n"Alice","halo, dunia"\n"Bob","kata ""kunci"""');
		expect(rows).toEqual([
			['nama', 'catatan'],
			['Alice', 'halo, dunia'],
			['Bob', 'kata "kunci"']
		]);
	});

	it('handles CRLF and a BOM, and drops a trailing empty line', () => {
		const rows = documents.parseDelimited('\uFEFFa,b\r\n1,2\r\n');
		expect(rows).toEqual([
			['a', 'b'],
			['1', '2']
		]);
	});

	it('keeps an empty cell but drops a fully empty row', () => {
		expect(documents.parseDelimited('a,,c\n\n1,2,3\n')).toEqual([
			['a', '', 'c'],
			['1', '2', '3']
		]);
	});

	it('sniffs a semicolon delimiter when commas are absent', () => {
		expect(documents.detectDelimiter('nama;poin\nAlice;120\n', 'csv')).toBe(';');
		expect(documents.detectDelimiter('nama,poin\nAlice,120\n', 'csv')).toBe(',');
		expect(documents.detectDelimiter('nama\tpoin\n', 'csv')).toBe('\t');
		// A TSV is a TSV whatever the content looks like.
		expect(documents.detectDelimiter('a,b\n', 'tsv')).toBe('\t');
	});
});

describe('documents.extractText', () => {
	it('renders a CSV as tab separated rows', async () => {
		const result = await documents.extractText(Buffer.from('nama,poin\nAlice,120\nBob,80\n'), {
			name: 'rekap.csv'
		});
		expect(result.kind).toBe('csv');
		expect(result.text).toBe('nama\tpoin\nAlice\t120\nBob\t80');
		expect(result.summary).toBe('3 baris');
		expect(result.truncated).toBe(false);
	});

	it('renders a TSV as rows', async () => {
		const result = await documents.extractText(Buffer.from('nama\tpoin\nAlice\t120\n'), { name: 'rekap.tsv' });
		expect(result.kind).toBe('tsv');
		expect(result.text).toBe('nama\tpoin\nAlice\t120');
	});

	it('reads a DOCX fixture', async () => {
		const result = await documents.extractText(fixture('sample.docx'), { name: 'sample.docx' });
		expect(result.kind).toBe('docx');
		expect(result.text).toContain('Laporan CTF 2026');
		expect(result.text).toContain('Juara: tim nol');
		expect(result.summary).toMatch(/kata$/);
	});

	it('reads every sheet of an XLSX fixture', async () => {
		const result = await documents.extractText(fixture('sample.xlsx'), { name: 'sample.xlsx' });
		expect(result.kind).toBe('xlsx');
		expect(result.text).toContain('# sheet: Poin');
		expect(result.text).toContain('Alice\t120');
		expect(result.text).toContain('# sheet: Tim');
		expect(result.text).toContain('nol\t9');
		expect(result.summary).toBe('2 sheet, 5 baris');
	});

	it('reads the text layer of a PDF fixture', async () => {
		const result = await documents.extractText(fixture('sample.pdf'), { name: 'sample.pdf' });
		expect(result.kind).toBe('pdf');
		expect(result.text).toContain('[halaman 1]');
		expect(result.text).toContain('Laporan CTF 2026');
		expect(result.summary).toBe('1 halaman');
	}, 15_000);

	it('cuts a long file and says so', async () => {
		const result = await documents.extractText(
			Buffer.from('a'.repeat(500)),
			{ name: 'panjang.csv' },
			{
				maxChars: 50
			}
		);
		expect(result.truncated).toBe(true);
		expect(result.chars).toBeLessThanOrEqual(51);
		expect(result.text.endsWith('…')).toBe(true);
	});

	it('caps spreadsheet rows', async () => {
		const rows = ['n'].concat(Array.from({ length: 20 }, (_, i) => String(i)));
		const result = await documents.extractText(
			Buffer.from(rows.join('\n')),
			{ name: 'baris.csv' },
			{
				maxRows: 5
			}
		);
		expect(result.text.split('\n')).toHaveLength(5);
		expect(result.summary).toBe('21 baris, dibaca 5');
	});

	it('throws for an unsupported attachment', async () => {
		await expect(documents.extractText(Buffer.from('x'), { name: 'notes.txt' })).rejects.toThrow(/unsupported/);
	});
});

describe('documents.collectDocuments', () => {
	const csv = Buffer.from('nama,poin\nAlice,120\nBob,80\n');

	it('reads supported attachments and leaves the rest alone', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(ok(csv));
		const docs = await documents.collectDocuments([
			{
				id: 'm1',
				authorId: 'u1',
				attachments: [
					{
						id: 'a1',
						name: 'rekap.csv',
						contentType: 'text/csv',
						size: csv.length,
						url: 'https://cdn.test/a'
					},
					{ id: 'a2', name: 'poster.png', contentType: 'image/png', size: 10, url: 'https://cdn.test/b' }
				]
			}
		]);

		expect(docs).toHaveLength(1);
		expect(docs[0]).toMatchObject({
			messageId: 'm1',
			authorId: 'u1',
			name: 'rekap.csv',
			kind: 'csv',
			truncated: false
		});
		expect(docs[0].text).toContain('Alice\t120');
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(globalThis.fetch.mock.calls[0][0]).toBe('https://cdn.test/a');
	});

	it('spends the file budget on the newest attachments', async () => {
		globalThis.fetch = vi.fn(url => Promise.resolve(ok(Buffer.from(url.endsWith('old') ? 'a\n1\n' : 'b\n2\n'))));
		const docs = await documents.collectDocuments(
			[
				{ id: 'm1', attachments: [{ id: 'a1', name: 'old.csv', url: 'https://cdn.test/old' }] },
				{ id: 'm2', attachments: [{ id: 'a2', name: 'new.csv', url: 'https://cdn.test/new' }] }
			],
			{ maxFiles: 1 }
		);

		expect(docs.map(d => d.name)).toEqual(['new.csv']);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it('downloads the same attachment once', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(ok(csv));
		const entries = [{ id: 'm1', attachments: [{ id: 'a1', name: 'rekap.csv', url: 'https://cdn.test/a' }] }];

		await documents.collectDocuments(entries);
		await documents.collectDocuments(entries);

		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it('keeps the message when a document cannot be downloaded', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve('gone') });
		const docs = await documents.collectDocuments([
			{ id: 'm1', attachments: [{ id: 'a1', name: 'rekap.csv', url: 'https://cdn.test/a' }] }
		]);
		expect(docs).toEqual([]);
	});

	it('skips an attachment the server declares too large', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			headers: { get: () => String(10 * 1024 * 1024) },
			arrayBuffer: () => Promise.resolve(csv)
		});
		const docs = await documents.collectDocuments(
			[{ id: 'm1', attachments: [{ id: 'a1', name: 'rekap.csv', url: 'https://cdn.test/a' }] }],
			{ maxBytes: 1024 }
		);
		expect(docs).toEqual([]);
	});

	it('shares the character budget across documents', async () => {
		const big = Buffer.from(`${'x'.repeat(40)}\n`);
		globalThis.fetch = vi.fn().mockResolvedValue(ok(big));
		const docs = await documents.collectDocuments(
			[
				{ id: 'm1', attachments: [{ id: 'a1', name: 'satu.csv', url: 'https://cdn.test/1' }] },
				{ id: 'm2', attachments: [{ id: 'a2', name: 'dua.csv', url: 'https://cdn.test/2' }] }
			],
			{ maxTotalChars: 50 }
		);

		expect(docs).toHaveLength(2);
		expect(docs.reduce((sum, doc) => sum + doc.chars, 0)).toBeLessThanOrEqual(51);
		// The oldest file is the one that loses its tail.
		expect(docs[0].truncated).toBe(true);
		expect(docs[1].truncated).toBe(false);
	});
});

describe('documents bounds', () => {
	it('reports a wide or long-cell file as cut', async () => {
		const wide = Array.from({ length: 25 }, (_, i) => `kolom${i}`).join(',');
		const wideResult = await documents.extractText(Buffer.from(wide), { name: 'lebar.csv' });
		expect(wideResult.truncated).toBe(true);
		expect(wideResult.text.split('\t')).toHaveLength(20);

		const longCell = 'x'.repeat(300);
		const longResult = await documents.extractText(Buffer.from(`a,${longCell}`), { name: 'sel.csv' });
		expect(longResult.truncated).toBe(true);
		expect(longResult.text).toContain('…');
	});
});
