import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { checkPermission, PermissionError, PermissionFlagsBits } from '../../../src/lib/middleware/ensurePermission.js';

/**
 * ensurePermission calls isAdmin via a plain CommonJS `require('./ensureAdmin')`.
 * Vitest's vi.mock only intercepts ESM imports / Vite-processed requires, NOT raw
 * require() calls inside plain-CJS source files, so mocking the connection chain
 * here never reaches the real isAdmin. Instead we point the real DB at a temp dir
 * (same pattern as tests/integration/activity.repository.test.js) and seed a real
 * admins row, letting the genuine isAdmin path run end-to-end.
 */
let tmpDir;
let db;

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'ctfbot-perm-'));
	process.chdir(tmpDir);

	db = new Database(join(tmpDir, 'ctfbot.db'));
	db.exec(`
		CREATE TABLE admins (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id TEXT NOT NULL UNIQUE,
			added_by TEXT NOT NULL,
			added_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)
	`);
});

afterAll(() => {
	db.close();
	process.chdir('/home/hanz/Documents/OpenSource/ctfbot');
	rmSync(tmpDir, { recursive: true, force: true });
});

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
		db.exec('DELETE FROM admins');
	});

	describe('checkPermission', () => {
		it('should return true if member has permission', async () => {
			mockMember.permissions.has.mockReturnValue(true);

			const result = await checkPermission(mockInteraction, PermissionFlagsBits.ManageChannels, 'Manage Channels');
			expect(result).toBe(true);
		});

		it('should return true if user is admin', async () => {
			mockMember.permissions.has.mockReturnValue(false);
			// Seed a real admin row so the real isAdmin (require'd by ensurePermission)
			// returns true.
			db.prepare('INSERT INTO admins (user_id, added_by) VALUES (?, ?)').run('123456789', 'test');

			const result = await checkPermission(mockInteraction, PermissionFlagsBits.ManageChannels, 'Manage Channels');
			expect(result).toBe(true);
		});

		it('should throw error if member does not have permission and is not admin', async () => {
			mockMember.permissions.has.mockReturnValue(false);

			await expect(checkPermission(mockInteraction, PermissionFlagsBits.ManageChannels, 'Manage Channels')).rejects.toThrow(
				PermissionError
			);
		});

		it('should throw error with correct message when permission denied', async () => {
			mockMember.permissions.has.mockReturnValue(false);

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
