import { describe, it, expect } from 'vitest';
import { parseCsv } from '../../src/commands/giveapbulk.js';

describe('parseCsv', () => {
	it('parses rows with a header row', () => {
		const rows = parseCsv('discord_id,points\n123,10\n456,20\n');
		expect(rows).toEqual([
			{ discord_id: '123', points: 10 },
			{ discord_id: '456', points: 20 }
		]);
	});

	it('parses rows without a header row', () => {
		const rows = parseCsv('123,10\n456,20');
		expect(rows).toEqual([
			{ discord_id: '123', points: 10 },
			{ discord_id: '456', points: 20 }
		]);
	});

	it('handles quoted fields and commas', () => {
		const rows = parseCsv('discord_id,points\n"789",15');
		expect(rows).toEqual([{ discord_id: '789', points: 15 }]);
	});

	it('handles Windows CRLF line endings and header casing', () => {
		const rows = parseCsv('DISCORD_ID,POINTS\r\n111,5\r\n222,6\r\n');
		expect(rows).toEqual([
			{ discord_id: '111', points: 5 },
			{ discord_id: '222', points: 6 }
		]);
	});

	it('does not strip a numeric-first-column list without a header', () => {
		const rows = parseCsv('1,5\n2,6\n');
		expect(rows).toEqual([
			{ discord_id: '1', points: 5 },
			{ discord_id: '2', points: 6 }
		]);
	});

	it('returns an empty array for empty input', () => {
		expect(parseCsv('')).toEqual([]);
		expect(parseCsv('\n\n')).toEqual([]);
	});

	it('strips surrounding whitespace from cells', () => {
		const rows = parseCsv(' discord_id , points \n 123 , 10 \n');
		expect(rows).toEqual([{ discord_id: '123', points: 10 }]);
	});
});
