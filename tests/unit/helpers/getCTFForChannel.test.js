import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getCTFForChannel, CTFNotFoundError } from '../../../src/lib/helpers/getCTFForChannel.js';

vi.mock('../../../src/database');

describe('CTF Lookup Helper', () => {
	const { ctfOperations } = require('../../../src/database');
	const mockCTF = {
		id: 1,
		ctf_name: 'Test CTF',
		channel_id: 'test-channel-id'
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('getCTFForChannel', () => {
		it('should return CTF when found', () => {
			ctfOperations.getCTFByChannelId = vi.fn().mockReturnValue(mockCTF);

			const result = getCTFForChannel('test-channel-id');
			expect(result).toBe(mockCTF);
			expect(ctfOperations.getCTFByChannelId).toHaveBeenCalledWith('test-channel-id');
		});

		it('should throw CTFNotFoundError when CTF not found', () => {
			ctfOperations.getCTFByChannelId = vi.fn().mockReturnValue(undefined);

			expect(() => getCTFForChannel('test-channel-id')).toThrow(CTFNotFoundError);
		});

		it('should throw error with correct message', () => {
			ctfOperations.getCTFByChannelId = vi.fn().mockReturnValue(undefined);

			expect(() => getCTFForChannel('test-channel-id')).toThrow(
				'❌ This channel is not registered as a CTF channel in the database.'
			);
		});
	});
});
