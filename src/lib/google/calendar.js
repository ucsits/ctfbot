/**
 * Google Calendar API v3 — fetch-based client.
 *
 * Thin wrappers around the Calendar API REST endpoints, using the project's
 * existing global fetch (Node 18+) and the OAuth module for token management.
 * Every function accepts a credentials object and passes it through to the
 * oauth module so the token is refreshed transparently on 401.
 *
 * Mapper functions for converting between bot tasks and Calendar event JSON
 * are exported alongside the API wrappers.
 *
 * @module lib/google/calendar
 */

const { logger } = require('../logger');
const oauth = require('./oauth');

const calLog = logger.child('Google|Calendar');

const BASE = 'https://www.googleapis.com/calendar/v3';

/**
 * Retrieve the appropriate access token, making a signed request, and
 * transparently retry once on 401 (expired token) after clearing the cache.
 *
 * @param {string} url
 * @param {object} options
 * @param {object} creds - { clientId, clientSecret, refreshToken }
 * @returns {Promise<Response>}
 */
async function _authorizedFetch(url, options = {}, creds) {
	const token = await oauth.getAccessToken(creds.clientId, creds.clientSecret, creds.refreshToken);

	const res = await fetch(url, {
		...options,
		headers: {
			...options.headers,
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		}
	});

	// Expired or revoked token — clear cache and retry exactly once
	if (res.status === 401) {
		calLog.warn('Got 401 from Calendar API, refreshing token and retrying');
		oauth.clearTokenCache();
		const newToken = await oauth.getAccessToken(creds.clientId, creds.clientSecret, creds.refreshToken);
		const retryRes = await fetch(url, {
			...options,
			headers: {
				...options.headers,
				Authorization: `Bearer ${newToken}`,
				'Content-Type': 'application/json'
			}
		});
		if (!retryRes.ok) {
			const body = await retryRes.text().catch(() => '');
			calLog.error(`Calendar API retry failed (${retryRes.status}): ${body}`);
		}
		return retryRes;
	}

	return res;
}

/**
 * List events from a calendar, optionally using a syncToken for incremental
 * sync or a pageToken for pagination. Returns the full response body.
 *
 * @param {object} creds - { clientId, clientSecret, refreshToken, calendarId }
 * @param {object} [opts]
 * @param {string} [opts.syncToken] - Incremental sync token
 * @param {string} [opts.pageToken] - Pagination token
 * @param {number} [opts.maxResults] - Max results per page (default 250)
 * @returns {Promise<{ items: object[], nextSyncToken?: string, nextPageToken?: string }>}
 */
async function listEvents(creds, opts = {}) {
	const params = new URLSearchParams({
		singleEvents: 'true',
		orderBy: 'startTime',
		maxResults: String(opts.maxResults || 250),
		...(opts.syncToken ? { syncToken: opts.syncToken } : {}),
		...(opts.pageToken ? { pageToken: opts.pageToken } : {}),
		// Google expects `key=value`; used to find an event already created for
		// a given task so a push can adopt it instead of creating a duplicate.
		...(opts.privateExtendedProperty ? { privateExtendedProperty: opts.privateExtendedProperty } : {})
	});

	const url = `${BASE}/calendars/${encodeURIComponent(creds.calendarId)}/events?${params}`;
	const res = await _authorizedFetch(url, {}, creds);

	if (!res.ok) {
		// 410: syncToken is too old — caller must fall back to a full sync
		if (res.status === 410) {
			calLog.warn('syncToken expired (410 Gone) — caller should force a full re-sync');
			return { items: [], nextSyncToken: null, tokenExpired: true };
		}
		const body = await res.text().catch(() => '');
		throw new Error(`Calendar API listEvents failed (${res.status}): ${body}`);
	}

	const data = await res.json();
	return {
		items: data.items || [],
		nextSyncToken: data.nextSyncToken || null,
		nextPageToken: data.nextPageToken || null
	};
}

/**
 * List all events, following pagination, until all pages are consumed.
 * When a syncToken is provided and still valid, returns only the incremental
 * changes. When no syncToken is provided, returns the full event set.
 *
 * Note: `privateExtendedProperty` is only valid on a FULL sync. Google
 * rejects it together with a syncToken, so callers that filter must not pass a
 * syncToken at the same time.
 *
 * @param {object} creds
 * @param {object} [opts]
 * @param {string} [opts.syncToken]
 * @param {string} [opts.privateExtendedProperty] - e.g. `xCtfbotTaskId=<uuid>`
 * @returns {Promise<{ items: object[], nextSyncToken: string|null, tokenExpired: boolean }>}
 */
async function listAllEvents(creds, opts = {}) {
	let allItems = [];
	let pageToken = null;
	let nextSyncToken = null;

	do {
		const result = await listEvents(creds, {
			syncToken: opts.syncToken,
			pageToken,
			maxResults: 250,
			privateExtendedProperty: opts.privateExtendedProperty
		});

		if (result.tokenExpired) {
			return { items: [], nextSyncToken: null, tokenExpired: true };
		}

		allItems = allItems.concat(result.items);
		nextSyncToken = result.nextSyncToken || nextSyncToken;
		pageToken = result.nextPageToken || null;
	} while (pageToken);

	return { items: allItems, nextSyncToken, tokenExpired: false };
}

/**
 * Create a new event on the calendar.
 *
 * @param {object} creds
 * @param {object} event - Calendar event JSON body
 * @returns {Promise<object>} The created event (including its id)
 */
async function createEvent(creds, event) {
	const url = `${BASE}/calendars/${encodeURIComponent(creds.calendarId)}/events`;
	const res = await _authorizedFetch(
		url,
		{ method: 'POST', body: JSON.stringify(event) },
		creds
	);

	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`Calendar API createEvent failed (${res.status}): ${body}`);
	}

	return res.json();
}

/**
 * Update an existing event's fields (partial patch).
 *
 * @param {object} creds
 * @param {string} eventId
 * @param {object} fields - Fields to patch (e.g. { summary, description })
 * @returns {Promise<object>} The patched event
 */
async function patchEvent(creds, eventId, fields) {
	const url = `${BASE}/calendars/${encodeURIComponent(creds.calendarId)}/events/${encodeURIComponent(eventId)}`;
	const res = await _authorizedFetch(
		url,
		{ method: 'PATCH', body: JSON.stringify(fields) },
		creds
	);

	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`Calendar API patchEvent failed (${res.status}): ${body}`);
	}

	return res.json();
}

/**
 * Delete an event from the calendar.
 *
 * @param {object} creds
 * @param {string} eventId
 * @returns {Promise<void>}
 */
async function deleteEvent(creds, eventId) {
	const url = `${BASE}/calendars/${encodeURIComponent(creds.calendarId)}/events/${encodeURIComponent(eventId)}`;
	const res = await _authorizedFetch(url, { method: 'DELETE' }, creds);

	if (!res.ok && res.status !== 404) {
		// 404 is acceptable — the event might have been deleted externally
		const body = await res.text().catch(() => '');
		throw new Error(`Calendar API deleteEvent failed (${res.status}): ${body}`);
	}
}

// ─────────────────────────────────────────────────────────────
//  Mapper: bot task → Google Calendar event JSON
// ─────────────────────────────────────────────────────────────

/**
 * Convert a bot task row into a Google Calendar event JSON body.
 * The event spans the hour before the deadline so the assignee has a
 * visible block on the calendar. It also carries private extendedProperties
 * that the bot uses to recognise its own events during sync.
 *
 * @param {object} task - Row from the tasks table
 * @param {number} task.deadline - Unix timestamp (seconds)
 * @param {string} task.task_id
 * @param {string} task.title
 * @param {string|null} [task.description]
 * @param {string} task.assigned_to - Discord user id
 * @returns {object} Calendar event JSON body
 */
function taskToCalendarEvent(task) {
	const deadlineSeconds = task.deadline;
	const startSeconds = deadlineSeconds - 3600; // 1 hour before deadline

	const event = {
		summary: task.title,
		start: {
			dateTime: new Date(startSeconds * 1000).toISOString(),
			timeZone: 'UTC'
		},
		end: {
			dateTime: new Date(deadlineSeconds * 1000).toISOString(),
			timeZone: 'UTC'
		},
		extendedProperties: {
			private: {
				xCtfbotTask: 'true',
				xCtfbotTaskId: task.task_id
			}
		}
	};

	if (task.description) {
		event.description = `Discord task: ${task.title}\nAssigned to: <@${task.assigned_to}>\nTask ID: ${task.task_id}\n\n${task.description}`;
	} else {
		event.description = `Discord task: ${task.title}\nAssigned to: <@${task.assigned_to}>\nTask ID: ${task.task_id}`;
	}

	return event;
}

// ─────────────────────────────────────────────────────────────
//  Mapper: Calendar event → bot task fields (for reconciliation)
// ─────────────────────────────────────────────────────────────

/**
 * Extract the relevant fields from a Calendar event that the bot cares about
 * during reconciliation on the pull side.
 *
 * @param {object} event - A Calendar API event resource
 * @returns {object} { taskId, title, deadline, cancelled, status, eventId, privateProps }
 */
function calendarEventToTaskPatch(event) {
	const privateProps = event.extendedProperties?.private || {};
	const taskId = privateProps.xCtfbotTaskId || null;
	const isBotOwned = privateProps.xCtfbotTask === 'true';

	const endTime = event.end?.dateTime
		? Math.floor(new Date(event.end.dateTime).getTime() / 1000)
		: null;

	return {
		eventId: event.id,
		taskId,
		isBotOwned,
		title: event.summary || null,
		deadline: endTime,
		status: event.status || null, // 'confirmed' | 'tentative' | 'cancelled' | null
		updated: event.updated || null,
		privateProps
	};
}

module.exports = {
	listEvents,
	listAllEvents,
	createEvent,
	patchEvent,
	deleteEvent,
	taskToCalendarEvent,
	calendarEventToTaskPatch
};
