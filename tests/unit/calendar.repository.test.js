import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, copyFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let tmpDir;
let originalCwd;
let db;
let repo;
let migrationsDir;

const NOW = Math.floor(Date.now() / 1000);

const insertTask = (taskId, overrides = {}) => {
	db.prepare(
		`
		INSERT INTO tasks (task_id, title, description, assigned_to, created_by, deadline, status, cancelled, block_height, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`
	).run(
		taskId,
		overrides.title ?? `Task ${taskId}`,
		overrides.description ?? null,
		overrides.assignedTo ?? 'assignee',
		overrides.createdBy ?? 'creator',
		overrides.deadline ?? NOW + 1000,
		overrides.status ?? 'pending',
		overrides.cancelled ?? 0,
		overrides.blockHeight ?? 1,
		overrides.createdAt ?? NOW
	);
};

beforeAll(async () => {
	originalCwd = process.cwd();
	migrationsDir = join(originalCwd, 'migrations');
	tmpDir = mkdtempSync(join(tmpdir(), 'ctfbot-calendar-'));
	copyFileSync(join(originalCwd, 'ctfbot.db'), join(tmpDir, 'ctfbot.db'));
	process.chdir(tmpDir);

	const { getConnection } = await import('../../src/database/connection.js');
	const { runMigrations } = await import('../../src/database/migrations.js');
	db = getConnection();
	const migration = runMigrations(db, migrationsDir);
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

describe('google_credentials storage', () => {
	it('returns null when no credentials have been provisioned', () => {
		expect(repo.getCredentials()).toBeNull();
	});

	it('returns the stored credentials after setCredentials', () => {
		repo.setCredentials({
			clientId: 'client-1',
			clientSecret: 'secret-1',
			refreshToken: 'rt-1',
			calendarId: 'cal-1@group.calendar.google.com'
		});
		const creds = repo.getCredentials();
		expect(creds.client_id).toBe('client-1');
		expect(creds.client_secret).toBe('secret-1');
		expect(creds.refresh_token).toBe('rt-1');
		expect(creds.calendar_id).toBe('cal-1@group.calendar.google.com');
	});

	it('upserts (does not create a second row) on subsequent setCredentials', () => {
		repo.setCredentials({
			clientId: 'client-2',
			clientSecret: 'secret-2',
			refreshToken: 'rt-2',
			calendarId: 'cal-2@group.calendar.google.com'
		});
		const count = db.prepare('SELECT COUNT(*) AS n FROM google_credentials').get().n;
		expect(count).toBe(1);
		const creds = repo.getCredentials();
		expect(creds.client_id).toBe('client-2');
		expect(creds.refresh_token).toBe('rt-2');
	});
});

describe('sync cursor storage', () => {
	it('returns null state before any sync', () => {
		expect(repo.getSyncToken()).toBeNull();
	});

	it('stores and retrieves the sync token', () => {
		repo.setSyncToken('CJ8=token123');
		const state = repo.getSyncToken();
		expect(state.sync_token).toBe('CJ8=token123');
		expect(state.last_sync_at).toBeGreaterThan(0);
	});

	it('upserts (never grows past one row)', () => {
		repo.setSyncToken('CJ8=token456');
		const count = db.prepare('SELECT COUNT(*) AS n FROM calendar_sync_state').get().n;
		expect(count).toBe(1);
		expect(repo.getSyncToken().sync_token).toBe('CJ8=token456');
	});

	it('clearSyncToken resets the cursor for a full re-scan', () => {
		repo.setSyncToken('CJ8=stale');
		repo.clearSyncToken();
		expect(repo.getSyncToken().sync_token).toBeNull();
	});
});

describe('calendar push candidates', () => {
	it('returns tasks that have no linked calendar event', () => {
		insertTask('push-1');
		insertTask('push-2');
		const rows = repo.listTasksNeedingCalendarPush();
		const ids = rows.map(r => r.task_id);
		expect(ids).toContain('push-1');
		expect(ids).toContain('push-2');
	});

	it('excludes tasks already marked as synced', () => {
		repo.markCalendarSynced({ taskId: 'push-1', eventId: 'evt-1' });
		const rows = repo.listTasksNeedingCalendarPush();
		const ids = rows.map(r => r.task_id);
		expect(ids).not.toContain('push-1');
		expect(ids).toContain('push-2');
	});

	it('excludes done and cancelled tasks', () => {
		insertTask('push-done', { status: 'done' });
		insertTask('push-cancelled', { cancelled: 1 });
		const rows = repo.listTasksNeedingCalendarPush();
		const ids = rows.map(r => r.task_id);
		expect(ids).not.toContain('push-done');
		expect(ids).not.toContain('push-cancelled');
	});
});

describe('calendar_event_id linkage', () => {
	it('links a task to its calendar event via markCalendarSynced', () => {
		repo.markCalendarSynced({ taskId: 'push-2', eventId: 'evt-2' });
		const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get('push-2');
		expect(task.calendar_event_id).toBe('evt-2');
		expect(task.calendar_synced_at).toBeGreaterThan(0);
		expect(task.calendar_source).toBe('google');
	});

	it('finds tasks by their calendar event id', () => {
		const rows = repo.tasksByCalendarEventId('evt-2');
		expect(rows.length).toBe(1);
		expect(rows[0].task_id).toBe('push-2');
	});

	it('returns an empty list for an unknown event id', () => {
		expect(repo.tasksByCalendarEventId('does-not-exist')).toEqual([]);
	});

	it('clearCalendarEventId makes the task a push candidate again', () => {
		repo.clearCalendarEventId('push-2');
		const rows = repo.listTasksNeedingCalendarPush();
		expect(rows.map(r => r.task_id)).toContain('push-2');
		expect(repo.tasksByCalendarEventId('evt-2')).toEqual([]);
	});
});
