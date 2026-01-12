import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ensureCTFChannel, CTFChannelError } from '../../../src/lib/middleware/ensureCTFChannel.js';

describe('CTF Channel Middleware', () => {
	const mockInteraction = {
		channel: {
			parentId: 'test-category-id'
		}
	};

	beforeEach(() => {
		vi.resetModules();
		process.env.CTF_CATEGORY_ID = 'test-category-id';
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('ensureCTFChannel', () => {
		it('should return channel if parentId matches CTF category', () => {
			const channel = ensureCTFChannel(mockInteraction);
			expect(channel).toBe(mockInteraction.channel);
		});

		it('should throw error if channel is undefined', () => {
			const interaction = { channel: undefined };
			expect(() => ensureCTFChannel(interaction)).toThrow(CTFChannelError);
		});

		it('should throw error if parentId does not match', () => {
			const interaction = {
				channel: {
					parentId: 'different-category-id'
				}
			};
			expect(() => ensureCTFChannel(interaction)).toThrow(CTFChannelError);
		});

		it('should throw error with correct message when not CTF channel', () => {
			const interaction = {
				channel: {
					parentId: 'wrong-id'
				}
			};

			expect(() => ensureCTFChannel(interaction)).toThrow(
				'❌ This command can only be used in CTF channels (channels within the CTF category).'
			);
		});
	});
});
