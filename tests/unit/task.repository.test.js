import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, copyFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let tmpDir;
let originalCwd;
let db;
let repo;
let migrationsDir;

beforeAll(async () => {
	originalCwd = process.cwd();
	migrationsDir = join(originalCwd, 'migrations');
	tmpDir = mkdtempSync(join(tmpdir(), 'ctfbot-task-'));
	copyFileSync(join(originalCwd, 'ctfbot.db'), join(tmpDir, 'ctfbot.db'));
	process.chdir(tmpDir);

	const { getConnection } = await import('../../src/database/connection.js');
	const { runMigrations } = await import('../../src/database/migrations.js');
	db = getConnection();
	const migration = runMigrations(db, join(originalCwd, 'migrations'));
	expect(migration.error).toBeNull();
	repo = await import('../../src/database/repositories/task.repository.js');
	db.prepare(
		'INSERT INTO tasks (task_id, title, assigned_to, created_by, deadline, block_height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
	).run('task-1', 'Test task', 'assignee', 'creator', 2000000000, 1, 1);
	db.prepare(
		'INSERT INTO tasks (task_id, title, assigned_to, created_by, deadline, block_height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
	).run('task-2', 'Second task', 'assignee2', 'creator', 2000000001, 1, 1);
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

function insertReminder(taskId, remindAt, overrides = {}) {
	db.prepare(
		`
		INSERT INTO task_reminders (task_id, channel_id, remind_at, sent, processing_until, attempts, last_error, failed_permanently)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`
	).run(
		taskId,
		overrides.channelId ?? 'ch-1',
		remindAt,
		overrides.sent ?? 0,
		overrides.processingUntil ?? null,
		overrides.attempts ?? 0,
		overrides.lastError ?? null,
		overrides.failedPermanently ?? 0
	);
	return db.prepare('SELECT id FROM task_reminders WHERE task_id = ? ORDER BY id DESC LIMIT 1').get(taskId).id;
}

describe('task repository lifecycle', () => {
	it('allows only one actor to claim and complete a task', () => {
		expect(repo.claimTaskTransition({ taskId: 'task-1', actorId: 'a' })).toBe(true);
		expect(repo.claimTaskTransition({ taskId: 'task-1', actorId: 'b' })).toBe(false);
		expect(repo.completeTask({ taskId: 'task-1', completedBy: 'b' })).toBe(false);
		expect(repo.completeTask({ taskId: 'task-1', completedBy: 'a' })).toBe(true);
	});

	it('allows only one actor to claim and cancel a task', () => {
		expect(repo.claimTaskTransition({ taskId: 'task-2', actorId: 'a' })).toBe(true);
		expect(repo.cancelTask({ taskId: 'task-2', cancelledBy: 'b' })).toBe(false);
		expect(repo.cancelTask({ taskId: 'task-2', cancelledBy: 'a' })).toBe(true);
		const task = repo.getTask('task-2');
		expect(task.cancelled).toBe(1);
		expect(task.status).toBe('pending');
	});

	it('expired transition claims are recoverable', () => {
		// Insert a fresh task, claim with a lease in the past, then verify a new actor can claim
		db.prepare(
			'INSERT INTO tasks (task_id, title, assigned_to, created_by, deadline, block_height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
		).run('task-3', 'Recoverable', 'a', 'c', 2000000002, 1, 1);
		expect(repo.claimTaskTransition({ taskId: 'task-3', actorId: 'old' })).toBe(true);
		// Force the lease to expire
		db.prepare('UPDATE tasks SET transition_until = ? WHERE task_id = ?').run(
			Math.floor(Date.now() / 1000) - 10,
			'task-3'
		);
		expect(repo.claimTaskTransition({ taskId: 'task-3', actorId: 'new' })).toBe(true);
	});

	it('releases transition claims explicitly', () => {
		db.prepare(
			'INSERT INTO tasks (task_id, title, assigned_to, created_by, deadline, block_height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
		).run('task-5', 'Releasable', 'a', 'c', 2000000004, 1, 1);
		expect(repo.claimTaskTransition({ taskId: 'task-5', actorId: 'a' })).toBe(true);
		repo.releaseTaskTransition({ taskId: 'task-5', actorId: 'a' });
		// Another actor can now claim immediately (no lease expiry wait)
		expect(repo.claimTaskTransition({ taskId: 'task-5', actorId: 'b' })).toBe(true);
	});

	it("does not release another actor's transition claim", () => {
		db.prepare(
			'INSERT INTO tasks (task_id, title, assigned_to, created_by, deadline, block_height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
		).run('task-6', 'Owned', 'a', 'c', 2000000005, 1, 1);
		expect(repo.claimTaskTransition({ taskId: 'task-6', actorId: 'a' })).toBe(true);
		repo.releaseTaskTransition({ taskId: 'task-6', actorId: 'z' });
		// Still claimed by 'a' — z's release was a no-op
		expect(repo.claimTaskTransition({ taskId: 'task-6', actorId: 'b' })).toBe(false);
	});

	it('removes reminders when a task is completed', () => {
		db.prepare(
			'INSERT INTO tasks (task_id, title, assigned_to, created_by, deadline, block_height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
		).run('task-4', 'Cleanup', 'a', 'c', 2000000003, 1, 1);
		insertReminder('task-4', 1000);
		expect(repo.claimTaskTransition({ taskId: 'task-4', actorId: 'a' })).toBe(true);
		expect(repo.completeTask({ taskId: 'task-4', completedBy: 'a' })).toBe(true);
		const reminders = db.prepare('SELECT COUNT(*) AS n FROM task_reminders WHERE task_id = ?').get('task-4');
		expect(reminders.n).toBe(0);
	});
});

describe('reminder claiming and retry', () => {
	it('claims due reminders and prevents double-claim', () => {
		const id = insertReminder('task-3', Math.floor(Date.now() / 1000) - 5);
		const due = repo.claimDueReminders(Math.floor(Date.now() / 1000));
		expect(due.some(r => r.id === id)).toBe(true);
		// Second claim in the same lease window returns nothing
		const again = repo.claimDueReminders(Math.floor(Date.now() / 1000));
		expect(again.some(r => r.id === id)).toBe(false);
	});

	it('releases non-permanent failures for retry', () => {
		const id = insertReminder('task-3', Math.floor(Date.now() / 1000) - 5);
		repo.releaseReminder(id, 'network error', false);
		const row = db.prepare('SELECT * FROM task_reminders WHERE id = ?').get(id);
		expect(row.failed_permanently).toBe(0);
		expect(row.processing_until).toBeNull();
		expect(row.last_error).toBe('network error');
		// It is claimable again
		const due = repo.claimDueReminders(Math.floor(Date.now() / 1000));
		expect(due.some(r => r.id === id)).toBe(true);
	});

	it('marks permanent failures as non-retryable', () => {
		const id = insertReminder('task-3', Math.floor(Date.now() / 1000) - 5);
		repo.releaseReminder(id, 'Missing Access', true);
		const row = db.prepare('SELECT * FROM task_reminders WHERE id = ?').get(id);
		expect(row.failed_permanently).toBe(1);
		const due = repo.claimDueReminders(Math.floor(Date.now() / 1000));
		expect(due.some(r => r.id === id)).toBe(false);
	});

	it('tracks attempts across claim cycles', () => {
		const id = insertReminder('task-3', Math.floor(Date.now() / 1000) - 5);
		repo.claimDueReminders(Math.floor(Date.now() / 1000));
		repo.claimDueReminders(Math.floor(Date.now() / 1000) + 200); // past lease
		const row = db.prepare('SELECT attempts FROM task_reminders WHERE id = ?').get(id);
		expect(row.attempts).toBe(2);
	});

	it('markReminderSent clears processing state', () => {
		const id = insertReminder('task-3', Math.floor(Date.now() / 1000) - 5);
		repo.claimDueReminders(Math.floor(Date.now() / 1000));
		repo.markReminderSent(id);
		const row = db.prepare('SELECT * FROM task_reminders WHERE id = ?').get(id);
		expect(row.sent).toBe(1);
		expect(row.processing_until).toBeNull();
	});
});

describe('digest delivery persistence', () => {
	it('claims digest parts and persists delivery idempotently', () => {
		expect(repo.claimDigestPart('daily:2026-08-31:part:1')).toBe(true);
		expect(repo.claimDigestPart('daily:2026-08-31:part:1')).toBe(false);
		repo.markDigestPartSent('daily:2026-08-31:part:1');
		expect(repo.hasDigestBeenSent('daily:2026-08-31:part:1')).toBe(true);
	});

	it('expired digest part claims are recoverable', () => {
		expect(repo.claimDigestPart('daily:2026-08-30:part:1')).toBe(true);
		db.prepare('UPDATE task_digest_deliveries SET processing_until = ? WHERE digest_key = ?').run(
			Math.floor(Date.now() / 1000) - 10,
			'daily:2026-08-30:part:1'
		);
		expect(repo.claimDigestPart('daily:2026-08-30:part:1')).toBe(true);
	});

	it('marks whole digests as sent', () => {
		repo.markDigestSent('weekly:2026-35');
		expect(repo.hasDigestBeenSent('weekly:2026-35')).toBe(true);
		// Idempotent
		repo.markDigestSent('weekly:2026-35');
		expect(repo.hasDigestBeenSent('weekly:2026-35')).toBe(true);
	});
});

describe('searchTasksByQuery (fuzzy search candidate pool)', () => {
	it('returns all pending non-cancelled tasks with the fields needed for fuzzy matching', () => {
		db.prepare(
			'INSERT INTO tasks (task_id, title, description, assigned_to, created_by, deadline, block_height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
		).run('search-1', 'Fuzzy candidate', 'Has a description to match', 'assignee', 'creator', 2000000010, 1, 1);
		const rows = repo.searchTasksByQuery();
		expect(rows.length).toBeGreaterThanOrEqual(1);
		const found = rows.find(r => r.task_id === 'search-1');
		expect(found).toBeTruthy();
		expect(found.title).toBe('Fuzzy candidate');
		expect(found.description).toBe('Has a description to match');
		expect(found.assigned_to).toBe('assignee');
		expect(found.created_by).toBe('creator');
		expect(found.deadline).toBe(2000000010);
		expect(found.status).toBe('pending');
		expect(found.cancelled).toBe(0);
	});

	it('excludes done and cancelled tasks', () => {
		db.prepare(
			'INSERT INTO tasks (task_id, title, assigned_to, created_by, deadline, block_height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
		).run('search-done', 'Done task', 'a', 'c', 2000000011, 1, 1);
		db.prepare(
			'INSERT INTO tasks (task_id, title, assigned_to, created_by, deadline, block_height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
		).run('search-cancelled', 'Cancelled task', 'a', 'c', 2000000012, 1, 1);
		db.prepare('UPDATE tasks SET status = ? WHERE task_id = ?').run('done', 'search-done');
		db.prepare('UPDATE tasks SET cancelled = 1 WHERE task_id = ?').run('search-cancelled');

		const rows = repo.searchTasksByQuery();
		const ids = rows.map(r => r.task_id);
		expect(ids).not.toContain('search-done');
		expect(ids).not.toContain('search-cancelled');
		expect(ids).toContain('search-1');
	});

	it('is empty when no pending tasks exist', () => {
		db.prepare('UPDATE tasks SET status = ?').run('done');
		expect(repo.searchTasksByQuery()).toEqual([]);
	});
});

describe('migration upgrades', () => {
	it('migration 017 and 018 produce expected schema', () => {
		const reminderCols = db
			.prepare('PRAGMA table_info(task_reminders)')
			.all()
			.map(c => c.name);
		expect(reminderCols).toEqual(
			expect.arrayContaining(['processing_until', 'attempts', 'last_error', 'failed_permanently'])
		);

		const taskCols = db
			.prepare('PRAGMA table_info(tasks)')
			.all()
			.map(c => c.name);
		expect(taskCols).toEqual(expect.arrayContaining(['transition_by', 'transition_until']));

		const digestTable = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
			.get('task_digest_deliveries');
		expect(digestTable).toBeTruthy();
	});

	it('reapplying migrations skips already-applied ones', () => {
		const { runMigrations } = require('../../src/database/migrations.js');
		const result = runMigrations(db, migrationsDir);
		expect(result.applied).toEqual([]);
		expect(result.skipped.length).toBeGreaterThanOrEqual(2);
	});
});
