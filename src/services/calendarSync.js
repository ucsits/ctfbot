/**
 * Calendar Sync Service
 *
 * Background poller that pushes bot tasks to a shared Google Calendar and
 * pulls incremental changes from bot-owned events back into the task DB.
 *
 * Push direction (bot → calendar):
 *   - Tasks created via /task add are pushed as new events.
 *   - Tasks completed via /task done have their events deleted.
 *   - Tasks cancelled via /task cancel have their events patched to
 *     status=cancelled.
 *
 * Pull direction (calendar → bot):
 *   - Uses Google's incremental sync (syncToken) to reduce API quota.
 *   - Only processes events with the bot-owned extendedProperties marker
 *     (x-ctfbot-task=true), so foreign events are never imported.
 *   - Detects: title changes, deadline changes, event cancellation/deletion.
 *
 * The service is a no-op when GOOGLE_CALENDAR_ENABLED is false or credentials
 * are not provisioned.
 *
 * @module services/calendarSync
 */

const constants = require('../lib/constants/config');
const calendarRepository = require('../database/repositories/calendar.repository');
const calendarApi = require('../lib/google/calendar');
const { logger } = require('../lib/logger');

const syncLog = logger.child('CalendarSync');

let intervalHandle = null;
let syncInProgress = false;

/**
 * Whether the Google Calendar sync feature is enabled.
 * Checks the env flag AND whether credentials are available (either from the
 * DB or from env vars).
 *
 * @returns {boolean}
 */
function isEnabled() {
	if (!constants.GOOGLE_CALENDAR_ENABLED) {
		return false;
	}

	// Check DB credentials (provisioned via setCredentials helper)
	const creds = calendarRepository.getCredentials();
	if (creds) {
		return true;
	}

	// Fall back to env-provided credentials
	if (constants.GOOGLE_CLIENT_ID && constants.GOOGLE_CLIENT_SECRET && constants.GOOGLE_REFRESH_TOKEN && constants.GOOGLE_CALENDAR_ID) {
		return true;
	}

	return false;
}

/**
 * Resolve the effective credentials object from DB or env.
 *
 * @returns {{ clientId: string, clientSecret: string, refreshToken: string, calendarId: string }|null}
 */
function resolveCredentials() {
	const dbCreds = calendarRepository.getCredentials();
	if (dbCreds) {
		return {
			clientId: dbCreds.client_id,
			clientSecret: dbCreds.client_secret,
			refreshToken: dbCreds.refresh_token,
			calendarId: dbCreds.calendar_id
		};
	}

	if (constants.GOOGLE_CLIENT_ID && constants.GOOGLE_CLIENT_SECRET && constants.GOOGLE_REFRESH_TOKEN && constants.GOOGLE_CALENDAR_ID) {
		return {
			clientId: constants.GOOGLE_CLIENT_ID,
			clientSecret: constants.GOOGLE_CLIENT_SECRET,
			refreshToken: constants.GOOGLE_REFRESH_TOKEN,
			calendarId: constants.GOOGLE_CALENDAR_ID
		};
	}

	return null;
}

/**
 * Start the calendar sync polling service.
 * Polls every GOOGLE_SYNC_INTERVAL ms (default 60s) for push reconciliation
 * and incremental pull.
 *
 * @param {import('discord.js').Client} client - Discord client instance
 */
function startCalendarSyncService(_client) {
	if (!isEnabled()) {
		syncLog.info('Google Calendar sync is disabled (GOOGLE_CALENDAR_ENABLED=false or no credentials)');
		return;
	}

	const interval = constants.GOOGLE_SYNC_INTERVAL || 60_000;

	syncLog.info(`Starting calendar sync service (polling every ${interval}ms)`);

	if (intervalHandle) {
		return;
	}
	intervalHandle = setInterval(() => {
		_syncCycle().catch(error => syncLog.error('Calendar sync poll failed:', error));
	}, interval);

	// Run once immediately
	_syncCycle().catch(error => syncLog.error('Initial calendar sync failed:', error));
}

/**
 * Stop the calendar sync polling service.
 */
function stopCalendarSyncService() {
	if (intervalHandle) {
		clearInterval(intervalHandle);
		intervalHandle = null;
	}
}

/**
 * Force a full re-sync on the next cycle by clearing the sync token.
 */
function forceResync() {
	calendarRepository.clearSyncToken();
	syncLog.info('Calendar sync token cleared — next cycle will do a full re-scan');
}

// ──────────────────────────────────────────────
//  Push: bot → Calendar
// ──────────────────────────────────────────────

/**
 * Push a task update to the Google Calendar. Best-effort — never throws to
 * the caller. Errors are logged and the task is left in a state that the
 * reconciliation cycle will pick up.
 *
 * @param {object} task - Full task row from the DB
 * @param {string} action - 'create' | 'delete' | 'cancel'
 * @returns {Promise<{ success: boolean, eventId?: string }>}
 */
/**
 * Find a calendar event that was already created for a task.
 *
 * Used to make the 'create' push idempotent: an earlier push may have created
 * the event but failed to record the linkage, and the reconciliation cycle
 * selects tasks with a null calendar_event_id, so without this check it would
 * create a duplicate event on every pass.
 *
 * The lookup runs a FULL sync (no syncToken), because Google rejects
 * privateExtendedProperty when it is combined with a syncToken.
 *
 * @param {object} creds
 * @param {string} taskId
 * @returns {Promise<object|null>} the matching event, or null
 */
async function findEventForTask(creds, taskId) {
	const result = await calendarApi.listAllEvents(creds, {
		privateExtendedProperty: `xCtfbotTaskId=${taskId}`
	});

	if (result.tokenExpired) {
		return null;
	}

	// The API filter is advisory; confirm the marker before adopting.
	return (
		result.items.find(event => {
			const patch = calendarApi.calendarEventToTaskPatch(event);
			return patch.isBotOwned && patch.taskId === taskId;
		}) || null
	);
}

async function pushTaskUpdate(task, action) {
	if (!isEnabled()) {
		return { success: false };
	}

	const creds = resolveCredentials();
	if (!creds) {
		syncLog.warn('Calendar push skipped: no credentials available');
		return { success: false };
	}

	try {
		switch (action) {
		case 'create': {
			// Idempotency first: adopt an event that already exists for this task
			// rather than creating a second one.
			const existing = await findEventForTask(creds, task.task_id);
			if (existing) {
				calendarRepository.markCalendarSynced({
					taskId: task.task_id,
					eventId: existing.id
				});
				syncLog.info(`Adopted existing calendar event ${existing.id} for task ${task.task_id}`);
				return { success: true, eventId: existing.id };
			}

			const event = calendarApi.taskToCalendarEvent(task);
			const created = await calendarApi.createEvent(creds, event);
			calendarRepository.markCalendarSynced({
				taskId: task.task_id,
				eventId: created.id
			});
			syncLog.info(`Pushed task ${task.task_id} → calendar event ${created.id}`);
			return { success: true, eventId: created.id };
		}
		case 'delete': {
			if (!task.calendar_event_id) {
				syncLog.warn(`Cannot delete calendar event for task ${task.task_id}: no event id`);
				return { success: false };
			}
			await calendarApi.deleteEvent(creds, task.calendar_event_id);
			calendarRepository.clearCalendarEventId(task.task_id);
			syncLog.info(`Deleted calendar event ${task.calendar_event_id} for task ${task.task_id}`);
			return { success: true };
		}
		case 'cancel': {
			if (!task.calendar_event_id) {
				syncLog.warn(`Cannot cancel calendar event for task ${task.task_id}: no event id`);
				return { success: false };
			}
			await calendarApi.patchEvent(creds, task.calendar_event_id, { status: 'cancelled' });
			syncLog.info(`Cancelled calendar event ${task.calendar_event_id} for task ${task.task_id}`);
			return { success: true };
		}
		default:
			syncLog.warn(`Unknown calendar push action: ${action}`);
			return { success: false };
		}
	} catch (error) {
		syncLog.error(`Calendar push (${action}) failed for task ${task.task_id}: ${error.message}`);
		return { success: false };
	}
}

// ──────────────────────────────────────────────
//  Sync cycle
// ──────────────────────────────────────────────

/**
 * Single sync cycle: push outstanding tasks and pull incremental changes.
 */
async function _syncCycle() {
	if (!isEnabled() || syncInProgress) {
		return;
	}
	syncInProgress = true;

	try {
		await _reconcileOutstanding();
		await _pullCalendarChanges();
	} catch (error) {
		syncLog.error('Calendar sync cycle error:', error);
	} finally {
		syncInProgress = false;
	}
}

/**
 * Push any pending tasks that don't yet have a calendar event.
 */
async function _reconcileOutstanding() {
	const tasks = calendarRepository.listTasksNeedingCalendarPush({ limit: 50 });
	if (tasks.length === 0) {
		return;
	}

	syncLog.info(`Reconciling ${tasks.length} outstanding tasks to calendar`);

	for (const task of tasks) {
		await pushTaskUpdate(task, 'create');
	}
}

/**
 * Pull incremental changes from the calendar and reconcile bot-owned events
 * against the task DB.
 */
async function _pullCalendarChanges() {
	const creds = resolveCredentials();
	if (!creds) {
		return;
	}

	const syncState = calendarRepository.getSyncToken();
	const syncToken = syncState?.sync_token || null;

	syncLog.debug(`Pulling calendar changes (syncToken: ${syncToken ? 'present' : 'none'})`);

	const result = await calendarApi.listAllEvents(creds, { syncToken });

	if (result.tokenExpired) {
		// Sync token too old — clear it and retry on the next cycle (full sync)
		syncLog.warn('Sync token expired, clearing for full re-sync');
		calendarRepository.clearSyncToken();
		return;
	}

	if (result.nextSyncToken) {
		calendarRepository.setSyncToken(result.nextSyncToken);
	}

	if (result.items.length === 0) {
		return;
	}

	syncLog.info(`Processing ${result.items.length} calendar event(s) from pull`);

	for (const event of result.items) {
		const patch = calendarApi.calendarEventToTaskPatch(event);

		// Only process bot-owned events
		if (!patch.isBotOwned || !patch.taskId) {
			continue;
		}

		// Find the linked task in our DB
		const tasks = calendarRepository.tasksByCalendarEventId(patch.eventId);
		if (tasks.length === 0) {
			// The event is bot-owned but the task was removed from the DB
			// (e.g. manually deleted). Delete the orphaned event.
			syncLog.warn(`Orphaned bot-owned event ${patch.eventId}, deleting`);
			await calendarApi.deleteEvent(creds, patch.eventId).catch(() => {});
			continue;
		}

		const dbTask = tasks[0];

		// Event was cancelled or deleted in Google → cancel the task
		if (patch.status === 'cancelled') {
			if (dbTask.status === 'pending' && !dbTask.cancelled) {
				syncLog.info(`Calendar event ${patch.eventId} cancelled → cancelling task ${dbTask.task_id}`);
				// Use a direct DB update since we don't have a Discord interaction context
				// to run through the blockchain path. This is a sync reconciliation.
				_cancelTaskDirectly(dbTask.task_id, 'calendar');
			}
			continue;
		}

		// Check for field changes
		const updates = {};
		if (patch.title && patch.title !== dbTask.title) {
			updates.title = patch.title;
		}
		if (patch.deadline && patch.deadline !== dbTask.deadline) {
			updates.deadline = patch.deadline;
		}

		if (Object.keys(updates).length > 0) {
			syncLog.info(`Updating task ${dbTask.task_id} from calendar: ${JSON.stringify(updates)}`);
			_updateTaskFromCalendar(dbTask.task_id, updates);
		}
	}
}

/**
 * Cancel a task directly (without blockchain or Discord interaction).
 * Used during calendar reconciliation when the event was deleted in Google.
 */
function _cancelTaskDirectly(taskId, source) {
	// Bypass the claim-transition pattern since this is a reconciliation action
	// with no Discord interaction context.
	const now = Math.floor(Date.now() / 1000);
	const db = require('../database/connection').getConnection();
	db.prepare(
		'UPDATE tasks SET cancelled = 1, completed_at = ?, completed_by = ?, transition_by = NULL, transition_until = NULL WHERE task_id = ? AND status = ? AND cancelled = 0'
	).run(now, source, taskId, 'pending');
	db.prepare('DELETE FROM task_reminders WHERE task_id = ?').run(taskId);
}

/**
 * Update a task's fields directly during calendar reconciliation.
 */
function _updateTaskFromCalendar(taskId, fields) {
	const db = require('../database/connection').getConnection();
	const parts = [];
	const params = [];

	if (fields.title !== undefined) {
		parts.push('title = ?');
		params.push(fields.title);
	}
	if (fields.deadline !== undefined) {
		parts.push('deadline = ?');
		params.push(Number(fields.deadline));
	}

	if (parts.length === 0) {
		return;
	}

	// Also update the synced_at timestamp so we don't re-push the stale value
	parts.push('calendar_synced_at = ?');
	params.push(Math.floor(Date.now() / 1000));

	params.push(taskId);
	db.prepare(`UPDATE tasks SET ${parts.join(', ')} WHERE task_id = ?`).run(...params);
}

module.exports = {
	startCalendarSyncService,
	stopCalendarSyncService,
	forceResync,
	pushTaskUpdate,
	// Exported for testing
	_syncCycle,
	_reconcileOutstanding,
	_pullCalendarChanges,
	_cancelTaskDirectly,
	_updateTaskFromCalendar,
	findEventForTask,
	isEnabled,
	resolveCredentials
};
