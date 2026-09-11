/**
 * Calendar repository — database operations for the Google Calendar sync layer.
 * Stores the shared org OAuth credentials, the incremental sync cursor, and the
 * calendar_event_id linkage on tasks so the sync service can push new tasks and
 * reconcile bot-owned calendar events back into the task DB.
 *
 * @module database/repositories/calendar
 */

const { getConnection } = require('../connection');

const db = () => getConnection();

/**
 * Fetch the stored shared Google credentials, or null when none have been
 * provisioned yet.
 *
 * @returns {{client_id: string, client_secret: string, refresh_token: string, calendar_id: string}|null}
 */
function getCredentials() {
	return (
		db()
			.prepare('SELECT client_id, client_secret, refresh_token, calendar_id FROM google_credentials WHERE id = 1')
			.get() || null
	);
}

/**
 * Upsert the shared Google credentials. Single-row table keyed on id = 1.
 *
 * @param {object} params
 * @param {string} params.clientId
 * @param {string} params.clientSecret
 * @param {string} params.refreshToken
 * @param {string} params.calendarId
 */
function setCredentials({ clientId, clientSecret, refreshToken, calendarId }) {
	db()
		.prepare(
			`
		INSERT INTO google_credentials (id, client_id, client_secret, refresh_token, calendar_id, updated_at)
		VALUES (1, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			client_id = excluded.client_id,
			client_secret = excluded.client_secret,
			refresh_token = excluded.refresh_token,
			calendar_id = excluded.calendar_id,
			updated_at = excluded.updated_at
	`
		)
		.run(clientId, clientSecret, refreshToken, calendarId, Math.floor(Date.now() / 1000));
}

/**
 * Fetch the incremental sync cursor, or null when no sync has run yet.
 *
 * @returns {{sync_token: string|null, last_sync_at: number|null}|null}
 */
function getSyncToken() {
	return db().prepare('SELECT sync_token, last_sync_at FROM calendar_sync_state WHERE id = 1').get() || null;
}

/**
 * Store the incremental sync token and the time it was captured.
 *
 * @param {string} syncToken - nextSyncToken from the Calendar API
 */
function setSyncToken(syncToken) {
	db()
		.prepare(
			`
		INSERT INTO calendar_sync_state (id, sync_token, last_sync_at)
		VALUES (1, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			sync_token = excluded.sync_token,
			last_sync_at = excluded.last_sync_at
	`
		)
		.run(syncToken, Math.floor(Date.now() / 1000));
}

/**
 * Clear the incremental sync cursor, forcing a full re-scan on the next cycle.
 */
function clearSyncToken() {
	db().prepare('UPDATE calendar_sync_state SET sync_token = NULL WHERE id = 1').run();
}

/**
 * Pending, non-cancelled tasks that still need to be pushed to the calendar:
 * either they have no linked calendar event yet, or they were never marked as
 * synced.
 *
 * @param {object} [params]
 * @param {number} [params.limit]
 * @returns {Array<object>}
 */
function listTasksNeedingCalendarPush({ limit = 100 } = {}) {
	return db()
		.prepare(
			`
		SELECT task_id, title, description, assigned_to, created_by, deadline, status, cancelled,
		       calendar_event_id, calendar_synced_at, calendar_source
		FROM tasks
		WHERE status = 'pending' AND cancelled = 0
		AND (calendar_event_id IS NULL OR calendar_synced_at IS NULL)
		ORDER BY deadline ASC
		LIMIT ?
	`
		)
		.all(limit);
}

/**
 * Record that a task has been pushed to the calendar, linking its event id.
 *
 * @param {object} params
 * @param {string} params.taskId
 * @param {string} params.eventId - The Google Calendar event id
 * @param {string} [params.source] - Origin tag (default 'google')
 */
function markCalendarSynced({ taskId, eventId, source = 'google' }) {
	db()
		.prepare(
			`
		UPDATE tasks
		SET calendar_event_id = ?, calendar_synced_at = ?, calendar_source = ?
		WHERE task_id = ?
	`
		)
		.run(eventId, Math.floor(Date.now() / 1000), source, taskId);
}

/**
 * Clear the calendar linkage on a task (e.g. after the linked event is gone),
 * so the task becomes a push candidate again.
 *
 * @param {string} taskId
 */
function clearCalendarEventId(taskId) {
	db()
		.prepare(
			'UPDATE tasks SET calendar_event_id = NULL, calendar_synced_at = NULL, calendar_source = NULL WHERE task_id = ?'
		)
		.run(taskId);
}

/**
 * Find tasks linked to a given calendar event id. Should normally be 0 or 1.
 *
 * @param {string} eventId
 * @returns {Array<object>}
 */
function tasksByCalendarEventId(eventId) {
	return db().prepare('SELECT * FROM tasks WHERE calendar_event_id = ?').all(eventId);
}

module.exports = {
	getCredentials,
	setCredentials,
	getSyncToken,
	setSyncToken,
	clearSyncToken,
	listTasksNeedingCalendarPush,
	markCalendarSynced,
	clearCalendarEventId,
	tasksByCalendarEventId
};
