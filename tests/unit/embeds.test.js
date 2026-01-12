import { describe, it, expect } from 'vitest';
import { createSuccessEmbed, createErrorEmbed, createInfoEmbed, createWarningEmbed, COLORS } from '../../src/lib/embeds/index.js';

describe('Embed Helpers', () => {
	describe('COLORS', () => {
		it('should have correct color values', () => {
			expect(COLORS.SUCCESS).toBe(0x00FF00);
			expect(COLORS.ERROR).toBe(0xFF0000);
			expect(COLORS.INFO).toBe(0x0099FF);
			expect(COLORS.WARNING).toBe(0xFFAA00);
			expect(COLORS.PRIMARY).toBe(0x0099FF);
		});
	});

	describe('createSuccessEmbed', () => {
		it('should create success embed with title and description', () => {
			const embed = createSuccessEmbed('Test Title', 'Test Description');

			expect(embed.data.title).toBe('✅ Test Title');
			expect(embed.data.description).toBe('Test Description');
			expect(embed.data.color).toBe(COLORS.SUCCESS);
			expect(embed.data.timestamp).toBeDefined();
		});

		it('should create success embed without description', () => {
			const embed = createSuccessEmbed('Test Title');

			expect(embed.data.title).toBe('✅ Test Title');
			expect(embed.data.description).toBeUndefined();
		});

		it('should add fields to embed', () => {
			const fields = [
				{ name: 'Field 1', value: 'Value 1', inline: true },
				{ name: 'Field 2', value: 'Value 2', inline: true }
			];
			const embed = createSuccessEmbed('Test', null, fields);

			expect(embed.data.fields).toEqual(fields);
		});
	});

	describe('createErrorEmbed', () => {
		it('should create error embed with title and description', () => {
			const embed = createErrorEmbed('Error Title', 'Error Description');

			expect(embed.data.title).toBe('❌ Error Title');
			expect(embed.data.description).toBe('Error Description');
			expect(embed.data.color).toBe(COLORS.ERROR);
		});

		it('should create error embed without description', () => {
			const embed = createErrorEmbed('Error Title');

			expect(embed.data.title).toBe('❌ Error Title');
			expect(embed.data.description).toBeUndefined();
		});
	});

	describe('createInfoEmbed', () => {
		it('should create info embed', () => {
			const embed = createInfoEmbed('Info Title', 'Info Description');

			expect(embed.data.title).toBe('ℹ️ Info Title');
			expect(embed.data.color).toBe(COLORS.INFO);
		});
	});

	describe('createWarningEmbed', () => {
		it('should create warning embed', () => {
			const embed = createWarningEmbed('Warning Title', 'Warning Description');

			expect(embed.data.title).toBe('⚠️ Warning Title');
			expect(embed.data.color).toBe(COLORS.WARNING);
		});
	});
});
