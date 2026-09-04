import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { taskToCalendarEvent, calendarEventToTaskPatch } from '../../src/lib/google/calendar.js';

describe('taskToCalendarEvent', () => {
	const NOW = Math.floor(Date.now() / 1000);
	const task = {
		task_id: 'abc-123-def',
		title: 'Review PR #42',
		description: 'Check the edge cases in the sync module',
		assigned_to: '987654321',
		created_by: '123456789',
		deadline: NOW + 7200, // 2 hours from now
		status: 'pending',
		cancelled: 0
	};

	it('produces a valid Calendar event JSON body', () => {
		const event = taskToCalendarEvent(task);
		expect(event.summary).toBe('Review PR #42');
		expect(event.description).toContain('Review PR #42');
		expect(event.description).toContain(task.task_id);
		expect(event.description).toContain(task.assigned_to);
		expect(event.description).toContain('Check the edge cases');
		expect(event.start.dateTime).toBeDefined();
		expect(event.end.dateTime).toBeDefined();
		expect(event.start.timeZone).toBe('UTC');
		expect(event.end.timeZone).toBe('UTC');
	});

	it('schedules the event 1 hour before the deadline', () => {
		const event = taskToCalendarEvent(task);
		const startMs = new Date(event.start.dateTime).getTime();
		const endMs = new Date(event.end.dateTime).getTime();
		expect(endMs - startMs).toBe(3600 * 1000);
		expect(endMs).toBe(task.deadline * 1000);
		expect(startMs).toBe((task.deadline - 3600) * 1000);
	});

	it('marks the event with bot-owned extendedProperties', () => {
		const event = taskToCalendarEvent(task);
		expect(event.extendedProperties.private.xCtfbotTask).toBe('true');
		expect(event.extendedProperties.private.xCtfbotTaskId).toBe(task.task_id);
	});

	it('handles tasks without a description', () => {
		const noDesc = { ...task, description: null };
		const event = taskToCalendarEvent(noDesc);
		expect(event.description).toContain(noDesc.title);
		expect(event.description).not.toContain('null');
	});

	it('handles tasks with a very short deadline', () => {
		const soon = { ...task, deadline: NOW + 1800 }; // 30 min from now
		const event = taskToCalendarEvent(soon);
		expect(event.start.dateTime).toBeDefined();
		expect(event.end.dateTime).toBeDefined();
	});
});

describe('calendarEventToTaskPatch', () => {
	const rawEvent = {
		id: 'evt_google_abc123',
		summary: 'Review PR #42',
		status: 'confirmed',
		start: { dateTime: '2026-09-05T09:00:00Z', timeZone: 'UTC' },
		end: { dateTime: '2026-09-05T10:00:00Z', timeZone: 'UTC' },
		updated: '2026-09-04T12:00:00.000Z',
		extendedProperties: {
			private: {
				xCtfbotTask: 'true',
				xCtfbotTaskId: 'abc-123-def'
			}
		}
	};

	it('extracts the bot task id from private properties', () => {
		const patch = calendarEventToTaskPatch(rawEvent);
		expect(patch.taskId).toBe('abc-123-def');
		expect(patch.isBotOwned).toBe(true);
	});

	it('extracts the event id and title', () => {
		const patch = calendarEventToTaskPatch(rawEvent);
		expect(patch.eventId).toBe('evt_google_abc123');
		expect(patch.title).toBe('Review PR #42');
	});

	it('converts the end dateTime to a Unix timestamp', () => {
		const patch = calendarEventToTaskPatch(rawEvent);
		const expected = Math.floor(new Date('2026-09-05T10:00:00Z').getTime() / 1000);
		expect(patch.deadline).toBe(expected);
	});

	it('extracts the event status', () => {
		const patch = calendarEventToTaskPatch(rawEvent);
		expect(patch.status).toBe('confirmed');
	});

	it('handles cancelled events', () => {
		const cancelled = { ...rawEvent, status: 'cancelled' };
		const patch = calendarEventToTaskPatch(cancelled);
		expect(patch.status).toBe('cancelled');
	});

	it('handles a non-bot-owned event (no extendedProperties)', () => {
		const foreign = { ...rawEvent, extendedProperties: undefined };
		const patch = calendarEventToTaskPatch(foreign);
		expect(patch.taskId).toBeNull();
		expect(patch.isBotOwned).toBe(false);
	});

	it('returns null deadline when end.dateTime is missing', () => {
		const noEnd = { ...rawEvent, end: {} };
		const patch = calendarEventToTaskPatch(noEnd);
		expect(patch.deadline).toBeNull();
	});
});

describe('oauth module', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('buildAuthUrl returns a valid URL with the calendar scope', async () => {
		const { buildAuthUrl } = await import('../../src/lib/google/oauth.js');
		const url = buildAuthUrl('client-123');
		expect(url).toContain('accounts.google.com');
		expect(url).toContain('client_id=client-123');
		expect(url).toContain('scope=' + encodeURIComponent('https://www.googleapis.com/auth/calendar'));
		expect(url).toContain('access_type=offline');
		expect(url).toContain('prompt=consent');
	});

	it('getAccessToken returns a token and caches it', async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ access_token: 'ya29.mock-token', expires_in: 3600, token_type: 'Bearer' })
		});

		const { getAccessToken, clearTokenCache } = await import('../../src/lib/google/oauth.js');
		clearTokenCache();

		const token = await getAccessToken('c', 's', 'rt');
		expect(token).toBe('ya29.mock-token');
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);

		// Second call should use cache
		const token2 = await getAccessToken('c', 's', 'rt');
		expect(token2).toBe('ya29.mock-token');
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);

		globalThis.fetch = originalFetch;
	});
});