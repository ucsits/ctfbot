import { describe, it, expect, vi } from 'vitest';
import { parseLocalDateToUTC, formatDiscordTimestamp, hoursToMs, daysToMs, computePeriodRange } from '../../../src/lib/utils/date.js';
import { validateDateFormat } from '../../../src/lib/validators/index.js';

vi.mock('../../../src/lib/validators/index.js');

describe('Date Utils', () => {
	describe('computePeriodRange', () => {
		it('computes Asia/Jakarta week boundaries', () => {
			// Monday 2026-01-05 00:00 Asia/Jakarta = 2026-01-04 17:00 UTC
			const mondayJakarta = Math.floor(Date.parse('2026-01-05T00:00:00+07:00') / 1000);
			const range = computePeriodRange('week', mondayJakarta, 'Asia/Jakarta');
			expect(range.start).toBe(Math.floor(Date.parse('2026-01-05T00:00:00+07:00') / 1000));
			// End of week = Sunday 2026-01-11 23:59:59.999 Asia/Jakarta
			expect(range.end).toBe(Math.floor(Date.parse('2026-01-12T00:00:00+07:00') / 1000) - 1);
		});

		it('computes Asia/Jakarta month boundaries', () => {
			// Mid-February Jakarta time; month starts Feb 1 00:00 +07
			const midFeb = Math.floor(Date.parse('2026-02-15T12:00:00+07:00') / 1000);
			const range = computePeriodRange('month', midFeb, 'Asia/Jakarta');
			expect(range.start).toBe(Math.floor(Date.parse('2026-02-01T00:00:00+07:00') / 1000));
			expect(range.end).toBe(Math.floor(Date.parse('2026-03-01T00:00:00+07:00') / 1000) - 1);
		});

		it('computes Asia/Jakarta year boundaries', () => {
			const midYear = Math.floor(Date.parse('2026-06-15T12:00:00+07:00') / 1000);
			const range = computePeriodRange('year', midYear, 'Asia/Jakarta');
			expect(range.start).toBe(Math.floor(Date.parse('2026-01-01T00:00:00+07:00') / 1000));
			expect(range.end).toBe(Math.floor(Date.parse('2027-01-01T00:00:00+07:00') / 1000) - 1);
		});

		it('defaults to UTC when no timezone is provided', () => {
			const t = Math.floor(Date.parse('2026-02-15T12:00:00Z') / 1000);
			const range = computePeriodRange('month', t);
			expect(range.start).toBe(Math.floor(Date.parse('2026-02-01T00:00:00Z') / 1000));
		});
	});

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
