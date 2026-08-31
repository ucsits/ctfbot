/**
 * Task repository — database operations for tasks & reminders
 * @module database/repositories/task
 */

const { getConnection } = require('../connection');

const db = () => getConnection();

/**
 * Insert a new task.
 */
function createTask({ taskId, title, description, assignedTo, createdBy, deadline, blockHeight }) {
	const now = Math.floor(Date.now() / 1000);
	db().prepare(`
		INSERT INTO tasks (task_id, title, description, assigned_to, created_by, deadline, block_height, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`).run(taskId, title, description || null, assignedTo, createdBy, deadline, blockHeight, now);
}

/**
 * Schedule a reminder for a task (e.g. 1 hour before deadline).
 */
function createReminder({ taskId, channelId, remindAt }) {
	db().prepare(`
		INSERT INTO task_reminders (task_id, channel_id, remind_at)
		VALUES (?, ?, ?)
	`).run(taskId, channelId, remindAt);
}

/**
 * Cancel a task (soft delete — marks cancelled=1, keeps blockchain audit trail).
 */
function claimTaskTransition({ taskId, actorId, leaseSeconds = 120 }) {
	const now = Math.floor(Date.now() / 1000);
	const result = db().prepare(`
		UPDATE tasks SET transition_by = ?, transition_until = ?
		WHERE task_id = ? AND status = 'pending' AND cancelled = 0
		AND (transition_until IS NULL OR transition_until < ?)
	`).run(actorId, now + leaseSeconds, taskId, now);
	return result.changes > 0;
}

function releaseTaskTransition({ taskId, actorId }) {
	db().prepare('UPDATE tasks SET transition_by = NULL, transition_until = NULL WHERE task_id = ? AND transition_by = ?')
		.run(taskId, actorId);
}

function cancelTask({ taskId, cancelledBy }) {
	const now = Math.floor(Date.now() / 1000);
	const result = db().prepare(`
		UPDATE tasks SET cancelled = 1, completed_by = ?, completed_at = ?, transition_by = NULL, transition_until = NULL
		WHERE task_id = ? AND status = 'pending' AND cancelled = 0 AND transition_by = ?
	`).run(cancelledBy, now, taskId, cancelledBy);
	if (result.changes === 0) {
		return false;
	}
	// Remove associated reminders
	db().prepare('DELETE FROM task_reminders WHERE task_id = ?').run(taskId);
	return true;
}

/**
 * Mark a task as done.
 */
function completeTask({ taskId, completedBy }) {
	const now = Math.floor(Date.now() / 1000);
	const result = db().prepare(`
		UPDATE tasks SET status = 'done', completed_by = ?, completed_at = ?, transition_by = NULL, transition_until = NULL
		WHERE task_id = ? AND status = 'pending' AND cancelled = 0 AND transition_by = ?
	`).run(completedBy, now, taskId, completedBy);
	if (result.changes === 0) {
		return false;
	}
	// Remove associated reminders so they don't fire after completion
	db().prepare('DELETE FROM task_reminders WHERE task_id = ?').run(taskId);
	return true;
}

/**
 * Get a single task by ID.
 */
function getTask(taskId) {
	return db().prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
}

/**
 * List pending tasks for a user, optionally filtered by deadline range.
 */
function listPendingTasks({ assignedTo, deadlineAfter, deadlineBefore } = {}) {
	let sql = 'SELECT * FROM tasks WHERE status = ? AND cancelled = 0';
	const params = ['pending'];

	if (assignedTo) {
		sql += ' AND assigned_to = ?';
		params.push(assignedTo);
	}
	if (deadlineAfter) {
		sql += ' AND deadline >= ?';
		params.push(deadlineAfter);
	}
	if (deadlineBefore) {
		sql += ' AND deadline <= ?';
		params.push(deadlineBefore);
	}

	sql += ' ORDER BY deadline ASC';
	return db().prepare(sql).all(...params);
}

/**
 * Get all unsent reminders that are due.
 */
function getDueReminders(now) {
	return db().prepare(`
		SELECT r.*, t.title, t.description, t.assigned_to, t.deadline
		FROM task_reminders r
		JOIN tasks t ON t.task_id = r.task_id
		WHERE r.sent = 0 AND r.remind_at <= ?
		AND t.status = 'pending' AND t.cancelled = 0
		ORDER BY r.remind_at ASC
	`).all(now);
}

/**
 * Mark a reminder as sent.
 */
function claimDueReminders(now, leaseSeconds = 120) {
	const due = db().prepare(`
		SELECT r.*, t.title, t.description, t.assigned_to, t.deadline
		FROM task_reminders r
		JOIN tasks t ON t.task_id = r.task_id
		WHERE r.sent = 0 AND r.failed_permanently = 0 AND r.remind_at <= ?
		AND (r.processing_until IS NULL OR r.processing_until < ?)
		AND t.status = 'pending' AND t.cancelled = 0
		ORDER BY r.remind_at ASC
	`).all(now, now);
	const claim = db().prepare(`
		UPDATE task_reminders
		SET processing_until = ?, attempts = attempts + 1
		WHERE id = ? AND sent = 0
		AND (processing_until IS NULL OR processing_until < ?)
	`);
	const claimed = [];
	for (const reminder of due) {
		const result = claim.run(now + leaseSeconds, reminder.id, now);
		if (result.changes > 0) {
			claimed.push(reminder);
		}
	}
	return claimed;
}

function markReminderSent(reminderId) {
	db().prepare('UPDATE task_reminders SET sent = 1, processing_until = NULL, last_error = NULL WHERE id = ?').run(reminderId);
}

function releaseReminder(reminderId, error, permanent = false) {
	db().prepare('UPDATE task_reminders SET processing_until = NULL, last_error = ?, failed_permanently = ? WHERE id = ? AND sent = 0')
		.run(String(error || 'delivery failed').slice(0, 500), permanent ? 1 : 0, reminderId);
}

function hasDigestBeenSent(digestKey) {
	return Boolean(db().prepare('SELECT 1 FROM task_digest_deliveries WHERE digest_key = ? AND delivered_at > 0').get(digestKey));
}

function markDigestSent(digestKey) {
	db().prepare('INSERT OR IGNORE INTO task_digest_deliveries (digest_key, delivered_at) VALUES (?, ?)')
		.run(digestKey, Math.floor(Date.now() / 1000));
}

function claimDigestPart(digestKey, leaseSeconds = 120) {
	const now = Math.floor(Date.now() / 1000);
	const result = db().prepare(`
		INSERT INTO task_digest_deliveries (digest_key, delivered_at, processing_until)
		VALUES (?, 0, ?)
		ON CONFLICT(digest_key) DO UPDATE SET processing_until = excluded.processing_until
		WHERE task_digest_deliveries.delivered_at = 0
		AND (task_digest_deliveries.processing_until IS NULL OR task_digest_deliveries.processing_until < ?)
	`).run(digestKey, now + leaseSeconds, now);
	return result.changes > 0;
}

function markDigestPartSent(digestKey) {
	db().prepare('UPDATE task_digest_deliveries SET delivered_at = ?, processing_until = NULL WHERE digest_key = ?')
		.run(Math.floor(Date.now() / 1000), digestKey);
}

module.exports = {
	createTask,
	createReminder,
	completeTask,
	cancelTask,
	getTask,
	listPendingTasks,
	getDueReminders,
	claimDueReminders,
	claimTaskTransition,
	releaseTaskTransition,
	markReminderSent,
	releaseReminder,
	hasDigestBeenSent,
	markDigestSent,
	claimDigestPart,
	markDigestPartSent
};
