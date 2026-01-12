import { describe, it, expect } from 'vitest';
import { checkPermission, PermissionError, PermissionFlagsBits } from '../../../src/lib/middleware/ensurePermission.js';

describe('Permission Middleware', () => {
	const mockMember = {
		permissions: {
			has: vi.fn()
		}
	};

	const mockInteraction = {
		member: mockMember
	};

	describe('checkPermission', () => {
		it('should return true if member has permission', () => {
			mockMember.permissions.has.mockReturnValue(true);

			const result = checkPermission(mockInteraction, PermissionFlagsBits.ManageChannels, 'Manage Channels');
			expect(result).toBe(true);
		});

		it('should throw error if member does not have permission', () => {
			mockMember.permissions.has.mockReturnValue(false);

			expect(() => checkPermission(mockInteraction, PermissionFlagsBits.ManageChannels, 'Manage Channels')).toThrow(
				PermissionError
			);
		});

		it('should throw error with correct message when permission denied', () => {
			mockMember.permissions.has.mockReturnValue(false);

			expect(() => checkPermission(mockInteraction, PermissionFlagsBits.ManageChannels, 'Manage Channels')).toThrow(
				'❌ You need the "Manage Channels" permission to use this command.'
			);
		});

		it('should throw error if member is undefined', () => {
			const interaction = { member: undefined };

			expect(() => checkPermission(interaction, PermissionFlagsBits.ManageChannels, 'Manage Channels')).toThrow(
				PermissionError
			);
		});
	});
});
