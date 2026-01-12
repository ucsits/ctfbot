import { describe, it, expect, vi } from 'vitest';
import { parseLocalDateToUTC, formatDiscordTimestamp, hoursToMs, daysToMs } from '../../../src/lib/utils/date.js';
import { validateDateFormat } from '../../../src/lib/validators/index.js';

vi.mock('../../../src/lib/validators/index.js');

describe('Date Utils', () => {
	describe('parseLocalDateToUTC', () => {
		beforeEach(() => {
			vi.mocked(validateDateFormat).mockReturnValue({
				day: '31',
				month: '12',
				year: '2025',
				hour: '20',
				minute: '00'
			});
		});

		it('should parse date string and convert to UTC', () => {
			const result = parseLocalDateToUTC('31-12-2025 20:00', 'Asia/Jakarta');

			expect(result).toBeInstanceOf(Date);
			expect(result.toISOString()).toContain('2025-12-31');
		});
	});

	describe('formatDiscordTimestamp', () => {
		it('should format date as Discord timestamp', () => {
			const date = new Date('2025-01-15T12:00:00Z');
			const result = formatDiscordTimestamp(date);

			const timestamp = Math.floor(date.getTime() / 1000);
			expect(result).toContain(`t:${timestamp}`);
		});

		it('should support different timestamp styles', () => {
			const date = new Date('2025-01-15T12:00:00Z');

			expect(formatDiscordTimestamp(date, 'F')).toContain(':F>');
			expect(formatDiscordTimestamp(date, 'd')).toContain(':d>');
			expect(formatDiscordTimestamp(date, 't')).toContain(':t>');
		});
	});

	describe('hoursToMs', () => {
		it('should convert hours to milliseconds', () => {
			expect(hoursToMs(1)).toBe(3600000);
			expect(hoursToMs(2)).toBe(7200000);
			expect(hoursToMs(24)).toBe(86400000);
		});
	});

	describe('daysToMs', () => {
		it('should convert days to milliseconds', () => {
			expect(daysToMs(1)).toBe(86400000);
			expect(daysToMs(7)).toBe(604800000);
		});
	});
});
