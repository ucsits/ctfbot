import { describe, it, expect, vi, beforeEach } from 'vitest';
import sharp from 'sharp';

let media;

beforeEach(async () => {
	vi.resetModules();
	media = await import('../../src/lib/media/index.js');
	media._reset();
});

/** A message double shaped like a discord.js Message for the parts used here. */
function message(overrides = {}) {
	return {
		id: 'm1',
		content: '',
		attachments: new Map(),
		embeds: [],
		...overrides
	};
}

function attachments(...list) {
	return new Map(list.map((item, i) => [item.id ?? `a${i}`, item]));
}

async function gifBytes(frames = 6) {
	const images = [];
	for (let i = 0; i < frames; i++) {
		images.push(
			await sharp({
				create: {
					width: 40,
					height: 30,
					channels: 4,
					background: { r: i * 30, g: 20, b: 90, alpha: 1 }
				}
			})
				.png()
				.toBuffer()
		);
	}
	return sharp(images, { join: { animated: true } })
		.gif({ loop: 0 })
		.toBuffer();
}

describe('media.gifFrameIndices', () => {
	it('samples the first frame, a quarter, half and the last one', () => {
		expect(media.gifFrameIndices(18)).toEqual([0, 4, 8, 17]);
		expect(media.gifFrameIndices(5)).toEqual([0, 1, 2, 4]);
	});

	it('does not repeat a frame in a short animation', () => {
		expect(media.gifFrameIndices(1)).toEqual([0]);
		expect(media.gifFrameIndices(2)).toEqual([0, 1]);
		expect(media.gifFrameIndices(3)).toEqual([0, 1, 2]);
		expect(media.gifFrameIndices(0)).toEqual([0]);
	});
});

describe('media.describeMessage', () => {
	it('keeps the text and marks the attachments', () => {
		const text = media.describeMessage(
			message({
				content: 'ikut survey ini ya',
				attachments: attachments(
					{
						id: 'a1',
						name: 'poster.png',
						contentType: 'image/png',
						size: 900_000,
						width: 1080,
						height: 1350
					},
					{ id: 'a2', name: 'reaction.gif', contentType: 'image/gif', size: 2_400_000 },
					{ id: 'a3', name: 'notes.pdf', contentType: 'application/pdf', size: 12_000 }
				)
			})
		);

		expect(text).toContain('ikut survey ini ya');
		expect(text).toContain('[gambar "poster.png", 1080x1350]');
		expect(text).toContain('[GIF "reaction.gif", 2.3 MB]');
		expect(text).toContain('[file "notes.pdf", application/pdf, 12 KB]');
	});

	it('renders an embed card below the message it came from', () => {
		const text = media.describeMessage(
			message({
				content: 'https://docs.google.com/forms/d/x',
				embeds: [
					{
						type: 'rich',
						title: 'Kuesioner Awareness dan Penggunaan FPGA',
						description: 'Hai! Kami dari Tim Riset INA Digital PERURI.',
						url: 'https://docs.google.com/forms/d/x',
						image: { url: 'https://lh3.googleusercontent.com/poster.png' },
						thumbnail: { url: 'https://lh3.googleusercontent.com/thumb.png' },
						fields: [
							{ name: 'Deadline', value: '30 Juni' },
							{ name: 'Durasi', value: '5 menit' }
						],
						footer: { text: 'Google Docs' },
						provider: { name: 'Google' }
					}
				]
			})
		);

		expect(text).toMatch(/^https:\/\/docs\.google\.com\/forms\/d\/x\n\[embed\] "Kuesioner/);
		expect(text).toContain('  Hai! Kami dari Tim Riset INA Digital PERURI.');
		expect(text).toContain('  Deadline: 30 Juni');
		expect(text).toContain('  url=https://docs.google.com/forms/d/x');
		expect(text).toContain('  image=https://lh3.googleusercontent.com/poster.png');
		expect(text).toContain('  thumbnail=https://lh3.googleusercontent.com/thumb.png');
		expect(text).toContain('  Google Docs');
		expect(text).toContain('  via Google');
	});

	it('caps how much of a long embed description is kept', () => {
		const text = media.describeMessage(message({ embeds: [{ title: 'T', description: 'x'.repeat(2000) }] }));
		expect(text.length).toBeLessThan(600);
		expect(text).toContain('…');
	});

	it('returns nothing for a message with no text, no attachment and no embed', () => {
		expect(media.describeMessage(message())).toBe('');
	});

	it('reports whether a message carries anything besides text', () => {
		expect(media.hasVisuals(message())).toBe(false);
		expect(media.hasVisuals(message({ attachments: attachments({ id: 'a1', contentType: 'image/png' }) }))).toBe(
			true
		);
		expect(media.hasVisuals(message({ embeds: [{ title: 'x' }] }))).toBe(true);
	});
});

describe('media.attachmentsOf', () => {
	it('prefers the Discord proxy URL and keeps the dimensions', () => {
		const [a] = media.attachmentsOf(
			message({
				attachments: attachments({
					id: 'a1',
					name: 'p.png',
					contentType: 'image/png',
					size: 10,
					width: 20,
					height: 30,
					url: 'https://media.discordapp.net/x',
					proxyURL: 'https://media.discordapp.net/proxy'
				})
			})
		);
		expect(a).toEqual({
			id: 'a1',
			name: 'p.png',
			contentType: 'image/png',
			size: 10,
			width: 20,
			height: 30,
			url: 'https://media.discordapp.net/proxy'
		});
	});
});

describe('media.collectImages', () => {
	const ok = bytes => ({
		ok: true,
		headers: { get: () => String(bytes.length) },
		arrayBuffer: () => Promise.resolve(bytes)
	});

	it('turns a GIF into four labelled frames, in order', async () => {
		const gif = await gifBytes(6);
		globalThis.fetch = vi.fn().mockResolvedValue(ok(gif));

		const images = await media.collectImages([
			{
				id: 'm1',
				attachments: [
					{
						id: 'a1',
						name: 'reaction.gif',
						contentType: 'image/gif',
						size: gif.length,
						url: 'https://cdn.test/r.gif'
					}
				]
			}
		]);

		expect(images).toHaveLength(4);
		expect(images.map(i => i.label)).toEqual([
			'GIF "reaction.gif" frame 1/6 (0% durasi)',
			'GIF "reaction.gif" frame 2/6 (20% durasi)',
			'GIF "reaction.gif" frame 3/6 (40% durasi)',
			'GIF "reaction.gif" frame 6/6 (100% durasi)'
		]);
		expect(images[0].messageId).toBe('m1');
		expect(images[0].frameIndex).toBe(0);
		expect(images[0].frameTotal).toBe(6);
		expect(images.every(i => i.dataUrl.startsWith('data:image/jpeg;base64,'))).toBe(true);
	});

	it('sends a still image once and downscales it', async () => {
		const png = await sharp({
			create: { width: 3000, height: 2000, channels: 4, background: { r: 5, g: 6, b: 7, alpha: 1 } }
		})
			.png()
			.toBuffer();
		globalThis.fetch = vi.fn().mockResolvedValue(ok(png));

		const images = await media.collectImages(
			[
				{
					id: 'm1',
					attachments: [
						{
							id: 'a1',
							name: 'p.png',
							contentType: 'image/png',
							size: png.length,
							url: 'https://cdn.test/p.png'
						}
					]
				}
			],
			{ maxWidth: 256 }
		);

		expect(images).toHaveLength(1);
		expect(images[0].kind).toBe('image');
		expect(images[0].label).toBe('gambar "p.png"');

		const bytes = Buffer.from(images[0].dataUrl.split(',')[1], 'base64');
		const meta = await sharp(bytes).metadata();
		expect(meta.width).toBe(256);
	});

	it('ignores files that are not pictures and links in embeds', async () => {
		globalThis.fetch = vi.fn();
		const images = await media.collectImages([
			{
				id: 'm1',
				attachments: [
					{ id: 'a1', name: 'n.pdf', contentType: 'application/pdf', url: 'https://cdn.test/n.pdf' }
				]
			},
			{
				id: 'm2',
				embeds: [{ image: { url: 'https://tracker.test/pixel.png' } }],
				attachments: []
			}
		]);

		expect(images).toEqual([]);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('drops a picture that cannot be downloaded without failing the pass', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve('gone') });

		const images = await media.collectImages([
			{
				id: 'm1',
				attachments: [{ id: 'a1', name: 'p.png', contentType: 'image/png', url: 'https://cdn.test/p.png' }]
			}
		]);

		expect(images).toEqual([]);
	});

	it('caches a download so a re-run does not fetch it again', async () => {
		const gif = await gifBytes(4);
		globalThis.fetch = vi.fn().mockResolvedValue(ok(gif));
		const entry = {
			id: 'm1',
			attachments: [
				{ id: 'a1', name: 'r.gif', contentType: 'image/gif', size: gif.length, url: 'https://cdn.test/r.gif' }
			]
		};

		const first = await media.collectImages([entry]);
		const second = await media.collectImages([entry]);

		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(second).toEqual(first);
	});

	it('spends the budget on the most recent attachment', async () => {
		const gif = await gifBytes(6);
		globalThis.fetch = vi.fn().mockResolvedValue(ok(gif));

		const images = await media.collectImages(
			[
				{
					id: 'm1',
					attachments: [
						{ id: 'a1', name: 'old.png', contentType: 'image/png', url: 'https://cdn.test/old.png' }
					]
				},
				{
					id: 'm2',
					attachments: [
						{ id: 'a2', name: 'new.gif', contentType: 'image/gif', url: 'https://cdn.test/new.gif' }
					]
				}
			],
			{ maxImages: 2 }
		);

		expect(images).toHaveLength(2);
		expect(images.every(i => i.messageId === 'm2')).toBe(true);
	});
});
