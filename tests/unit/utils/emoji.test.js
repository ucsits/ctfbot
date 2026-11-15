import { describe, it, expect } from 'vitest';
import { stripEmoji } from '../../../src/lib/utils/emoji.js';

describe('stripEmoji', () => {
	it('removes pictographs and keeps the surrounding words apart', () => {
		expect(stripEmoji('halo 😀 apa kabar')).toBe('halo apa kabar');
		expect(stripEmoji('halo😀apa')).toBe('halo apa');
		expect(stripEmoji('😀 halo')).toBe('halo');
		expect(stripEmoji('halo 🎉')).toBe('halo');
	});

	it('removes emoji presentation and text presentation variants', () => {
		expect(stripEmoji('nice ✅ done')).toBe('nice done');
		expect(stripEmoji('⚠️ careful')).toBe('careful');
		expect(stripEmoji('ℹ️ already')).toBe('already');
		expect(stripEmoji('❤️ love')).toBe('love');
	});

	it('removes joined sequences, skin tones, keycaps and flags', () => {
		expect(stripEmoji('👨‍👩‍👧‍👦 family')).toBe('family');
		expect(stripEmoji('👍🏽 ok')).toBe('ok');
		expect(stripEmoji('1️⃣ first')).toBe('first');
		expect(stripEmoji('🇮🇩 merdeka')).toBe('merdeka');
	});

	it('removes Discord custom emoji markup but keeps mentions and timestamps', () => {
		expect(stripEmoji('<:blob:123> hi')).toBe('hi');
		expect(stripEmoji('<a:party:456> yay')).toBe('yay');
		expect(stripEmoji('<@123> hello <#456> <t:123:F>')).toBe('<@123> hello <#456> <t:123:F>');
	});

	it('tidies the whitespace left behind', () => {
		expect(stripEmoji('a 😀 😀 b')).toBe('a b');
		expect(stripEmoji('ok 😀, lanjut')).toBe('ok, lanjut');
		expect(stripEmoji('line1\n😀\nline2')).toBe('line1\n\nline2');
		expect(stripEmoji('   ')).toBe('');
		expect(stripEmoji('')).toBe('');
	});

	it('leaves ordinary punctuation alone', () => {
		expect(stripEmoji('a — b')).toBe('a — b');
		expect(stripEmoji('jam 9-10 pagi')).toBe('jam 9-10 pagi');
	});
});
