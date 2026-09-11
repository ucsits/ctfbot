import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, copyFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ── Strategy ───────────────────────────────────────────────────────────
// pushTaskUpdate('create') used to call createEvent and only afterwards record
// the linkage. If that DB write failed, the Google event existed but the task
// still had calendar_event_id = NULL, and _reconcileOutstanding re-selects
// exactly those tasks, so the next cycle created a DUPLICATE event.
//
// The push now looks for an event already carrying the task's marker and adopts
// it. This suite drives the real pushTaskUpdate against a mocked fetch and
// asserts that a second push issues no second create.

// Must be set before the constants module is first loaded.
process.env.GOOGLE_CALENDAR_ENABLED = 'true';

let tmpDir;
const originalCwd = process.cwd();
let db;
let calendarRepository;

const createdEventIds = [];
let eventsStore = [];
let createPosts = 0;

function jsonResponse(body, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body)
	};
}

beforeAll(async () => {
	tmpDir = mkdtempSync(join(tmpdir(), 'ctfbot-calpush-'));
	copyFileSync(join(originalCwd, 'ctfbot.db'), join(tmpDir, 'ctfbot.db'));
	process.chdir(tmpDir);

	const { getConnection } = await import('../../src/database/connection.js');
	const { runMigrations } = await import('../../src/database/migrations.js');
	db = getConnection();
	const migration = runMigrations(db, join(originalCwd, 'migrations'));
	expect(migration.error).toBeNull();

	calendarRepository = await import('../../src/database/repositories/calendar.repository.js');

	// Credentials in the DB make isEnabled() true and resolveCredentials() work.
	calendarRepository.setCredentials({
		clientId: 'cid',
		clientSecret: 'csec',
		refreshToken: 'rtok',
		calendarId: 'cal@group.calendar.google.com'
	});

	db.prepare(
		'INSERT INTO tasks (task_id, title, assigned_to, created_by, deadline, block_height, created_at) VALUES (?,?,?,?,?,?,?)'
	).run('push-task-1', 'Push me', 'user-1', 'creator-1', Math.floor(Date.now() / 1000) + 7200, 1, Math.floor(Date.now() / 1000));
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

beforeEach(() => {
	eventsStore = [];
	createPosts = 0;
	createdEventIds.length = 0;

	global.fetch = vi.fn(async (url, options = {}) => {
		const href = String(url);

		if (href.includes('oauth2.googleapis.com')) {
			return jsonResponse({ access_token: 'test-token', expires_in: 3600, token_type: 'Bearer' });
		}

		if (href.includes('/calendars/') && href.includes('/events')) {
			const method = (options.method || 'GET').toUpperCase();

			if (method === 'GET') {
				// The events.list response. Echo back whatever has been created
				// so far so a second lookup can find it.
				return jsonResponse({ items: eventsStore, nextSyncToken: null });
			}

			if (method === 'POST') {
				createPosts += 1;
				const body = JSON.parse(options.body);
				const created = {
					id: `evt-created-${createPosts}`,
					summary: body.summary,
					status: 'confirmed',
					end: body.end,
					extendedProperties: body.extendedProperties
				};
				createdEventIds.push(created.id);
				eventsStore.push(created);
				return jsonResponse(created);
			}
		}

		return jsonResponse({});
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function loadService() {
	vi.resetModules();
	// Re-set the flag: resetModules re-evaluates constants from process.env.
	process.env.GOOGLE_CALENDAR_ENABLED = 'true';
	return import('../../src/services/calendarSync.js');
}

describe('findEventForTask', () => {
	it('returns null when the calendar has no event for the task', async () => {
		const { findEventForTask } = await loadService();
		const creds = calendarRepository.getCredentials();
		const resolved = {
			clientId: creds.client_id,
			clientSecret: creds.client_secret,
			refreshToken: creds.refresh_token,
			calendarId: creds.calendar_id
		};

		const result = await findEventForTask(resolved, 'no-such-task');
		expect(result).toBeNull();
	});

	it('finds a bot-owned event carrying the task marker', async () => {
		eventsStore = [
			{
				id: 'evt-existing',
				summary: 'Already there',
				status: 'confirmed',
				end: { dateTime: new Date(Date.now() + 3600_000).toISOString() },
				extendedProperties: { private: { xCtfbotTask: 'true', xCtfbotTaskId: 'push-task-1' } }
			}
		];

		const { findEventForTask } = await loadService();
		const creds = calendarRepository.getCredentials();
		const resolved = {
			clientId: creds.client_id,
			clientSecret: creds.client_secret,
			refreshToken: creds.refresh_token,
			calendarId: creds.calendar_id
		};

		const result = await findEventForTask(resolved, 'push-task-1');
		expect(result).toBeTruthy();
		expect(result.id).toBe('evt-existing');
	});

	it('ignores a foreign event that lacks the bot marker', async () => {
		eventsStore = [
			{ id: 'evt-foreign', summary: 'Someone else', status: 'confirmed', extendedProperties: { private: {} } }
		];

		const { findEventForTask } = await loadService();
		const creds = calendarRepository.getCredentials();
		const resolved = {
			clientId: creds.client_id,
			clientSecret: creds.client_secret,
			refreshToken: creds.refresh_token,
			calendarId: creds.calendar_id
		};

		expect(await findEventForTask(resolved, 'push-task-1')).toBeNull();
	});
});

describe('pushTaskUpdate create idempotency', () => {
	it('creates once and adopts the existing event on a second push', async () => {
		const { pushTaskUpdate } = await loadService();

		const task = {
			task_id: 'push-task-1',
			title: 'Push me',
			description: 'desc',
			assigned_to: 'user-1',
			deadline: Math.floor(Date.now() / 1000) + 7200,
			calendar_event_id: null
		};

		const first = await pushTaskUpdate(task, 'create');
		expect(first.success).toBe(true);
		expect(createPosts).toBe(1);

		// Simulate the DB linkage being lost (the bug): the task still appears
		// unsynced, so reconciliation would push it again.
		db.prepare('UPDATE tasks SET calendar_event_id = NULL, calendar_synced_at = NULL WHERE task_id = ?')
			.run('push-task-1');

		const second = await pushTaskUpdate(task, 'create');
		expect(second.success).toBe(true);

		// The decisive assertion: no second create was issued.
		expect(createPosts).toBe(1);
		expect(second.eventId).toBe(first.eventId);

		// And the linkage was repaired on the existing event.
		const row = db.prepare('SELECT calendar_event_id FROM tasks WHERE task_id = ?').get('push-task-1');
		expect(row.calendar_event_id).toBe(first.eventId);
	});

	it('never throws when credentials are unavailable', async () => {
		const { pushTaskUpdate } = await loadService();
		// Wipe credentials so resolveCredentials returns null.
		db.prepare('DELETE FROM google_credentials').run();

		const result = await pushTaskUpdate(
			{ task_id: 'push-task-1', title: 't', assigned_to: 'u', deadline: 1, calendar_event_id: null },
			'create'
		);
		expect(result.success).toBe(false);

		// Restore for other tests.
		calendarRepository.setCredentials({
			clientId: 'cid',
			clientSecret: 'csec',
			refreshToken: 'rtok',
			calendarId: 'cal@group.calendar.google.com'
		});
	});
});
