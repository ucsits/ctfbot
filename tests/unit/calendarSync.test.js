import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, copyFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let tmpDir;
let originalCwd;
let db;
let repo;

const NOW = Math.floor(Date.now() / 1000);

beforeAll(async () => {
	originalCwd = process.cwd();
	tmpDir = mkdtempSync(join(tmpdir(), 'ctfbot-cal-sync-'));
	copyFileSync(join(originalCwd, 'ctfbot.db'), join(tmpDir, 'ctfbot.db'));
	process.chdir(tmpDir);

	const { getConnection } = await import('../../src/database/connection.js');
	const { runMigrations } = await import('../../src/database/migrations.js');
	db = getConnection();
	const migration = runMigrations(db, join(originalCwd, 'migrations'));
	expect(migration.error).toBeNull();
	repo = await import('../../src/database/repositories/calendar.repository.js');
});

afterAll(() => {
	if (db?.open) {
		db.close();
	}
	process.chdir(originalCwd);
	if (tmpDir) {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

// ── isEnabled basic check ────────────────────────────────────────
describe('isEnabled', () => {
	it('returns false when env var is not set', async () => {
		const OLD = process.env.GOOGLE_CALENDAR_ENABLED;
		process.env.GOOGLE_CALENDAR_ENABLED = 'false';
		vi.resetModules();
		const { isEnabled } = await import('../../src/services/calendarSync.js');
		expect(isEnabled()).toBe(false);
		process.env.GOOGLE_CALENDAR_ENABLED = OLD;
	});
});

// ── Direct DB operations ─────────────────────────────────────────
describe('direct DB operations', () => {
	const taskId = 'cal-sync-op-1';
	const taskId2 = 'cal-sync-op-2';

	beforeAll(() => {
		db.prepare(
			'INSERT INTO tasks (task_id, title, assigned_to, created_by, deadline, block_height, created_at, calendar_event_id, calendar_synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
		).run(taskId, 'Sync test', 'user', 'creator', NOW + 1000, 11, NOW, 'evt-1', NOW);
		db.prepare(
			'INSERT INTO tasks (task_id, title, assigned_to, created_by, deadline, block_height, created_at, calendar_event_id, calendar_synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
		).run(taskId2, 'Another sync test', 'user', 'creator', NOW + 2000, 11, NOW, 'evt-2', NOW);
	});

	it('cancelTaskDirectly marks a task as cancelled and sets completed_by', async () => {
		const { _cancelTaskDirectly } = await import('../../src/services/calendarSync.js');
		_cancelTaskDirectly(taskId, 'calendar');

		const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
		expect(task.cancelled).toBe(1);
		expect(task.completed_by).toBe('calendar');
	});

	it('updateTaskFromCalendar updates task title', async () => {
		const { _updateTaskFromCalendar } = await import('../../src/services/calendarSync.js');
		_updateTaskFromCalendar(taskId2, { title: 'Updated title from calendar' });

		const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId2);
		expect(task.title).toBe('Updated title from calendar');
	});

	it('updateTaskFromCalendar updates task deadline', async () => {
		const { _updateTaskFromCalendar } = await import('../../src/services/calendarSync.js');
		_updateTaskFromCalendar(taskId2, { deadline: NOW + 99999 });

		const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId2);
		expect(task.deadline).toBe(NOW + 99999);
	});

	it('updateTaskFromCalendar updates calendar_synced_at', async () => {
		const { _updateTaskFromCalendar } = await import('../../src/services/calendarSync.js');
		const oldSynced = db.prepare('SELECT calendar_synced_at FROM tasks WHERE task_id = ?').get(taskId2).calendar_synced_at;
		_updateTaskFromCalendar(taskId2, { title: 're-synced' });

		const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId2);
		expect(task.calendar_synced_at).toBeGreaterThanOrEqual(oldSynced);
		expect(task.title).toBe('re-synced');
	});
});

// ── pushTaskUpdate basic edge cases ──────────────────────────────
describe('pushTaskUpdate edge cases', () => {
	it('returns false when task has no calendar_event_id and action is delete', async () => {
		const { pushTaskUpdate } = await import('../../src/services/calendarSync.js');
		const result = await pushTaskUpdate({
			task_id: 't-2',
			calendar_event_id: null
		}, 'delete');
		expect(result.success).toBe(false);
	});

	it('returns false for unknown action', async () => {
		const { pushTaskUpdate } = await import('../../src/services/calendarSync.js');
		const result = await pushTaskUpdate({
			task_id: 't-3',
			calendar_event_id: 'evt-3'
		}, 'unknown');
		expect(result.success).toBe(false);
	});
});