import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { checkPermission, PermissionError, PermissionFlagsBits } from '../../../src/lib/middleware/ensurePermission.js';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../src/database/migrations.js';

vi.mock('../../../src/lib/middleware/ensureAdmin.js', () => ({
	isAdmin: vi.fn()
}));

import { isAdmin } from '../../../src/lib/middleware/ensureAdmin.js';

const mockDb = new Database(':memory:');

vi.mock('../../../src/database/connection', () => ({
	getConnection: () => mockDb
}));

describe('Permission Middleware', () => {
	const mockMember = {
		permissions: {
			has: vi.fn()
		}
	};

	const mockInteraction = {
		member: mockMember,
		user: {
			id: '123456789'
		}
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mockDb.exec('DROP TABLE IF EXISTS admins');
		mockDb.exec(`
			CREATE TABLE admins (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id TEXT NOT NULL UNIQUE,
				added_by TEXT NOT NULL,
				added_at DATETIME DEFAULT CURRENT_TIMESTAMP
			)
		`);
	});

	afterAll(() => {
		mockDb.close();
	});

	describe('checkPermission', () => {
		it('should return true if member has permission', async () => {
			mockMember.permissions.has.mockReturnValue(true);
			isAdmin.mockResolvedValue(false);

			const result = await checkPermission(mockInteraction, PermissionFlagsBits.ManageChannels, 'Manage Channels');
			expect(result).toBe(true);
		});

		it('should return true if user is admin', async () => {
			mockMember.permissions.has.mockReturnValue(false);
			isAdmin.mockResolvedValue(true);

			const result = await checkPermission(mockInteraction, PermissionFlagsBits.ManageChannels, 'Manage Channels');
			expect(result).toBe(true);
		});

		it('should throw error if member does not have permission and is not admin', async () => {
			mockMember.permissions.has.mockReturnValue(false);
			isAdmin.mockResolvedValue(false);

			await expect(checkPermission(mockInteraction, PermissionFlagsBits.ManageChannels, 'Manage Channels')).rejects.toThrow(
				PermissionError
			);
		});

		it('should throw error with correct message when permission denied', async () => {
			mockMember.permissions.has.mockReturnValue(false);
			isAdmin.mockResolvedValue(false);

			await expect(checkPermission(mockInteraction, PermissionFlagsBits.ManageChannels, 'Manage Channels')).rejects.toThrow(
				'You need the "Manage Channels" permission to use this command.'
			);
		});

		it('should throw error if member is undefined', async () => {
			const interaction = { member: undefined, user: { id: '123456789' } };

			await expect(checkPermission(interaction, PermissionFlagsBits.ManageChannels, 'Manage Channels')).rejects.toThrow(
				PermissionError
			);
		});

		it('should throw error if user is undefined', async () => {
			const interaction = { member: mockMember, user: undefined };

			await expect(checkPermission(interaction, PermissionFlagsBits.ManageChannels, 'Manage Channels')).rejects.toThrow(
				PermissionError
			);
		});
	});
});
