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
 * Mark a task as done.
 */
function completeTask({ taskId, completedBy }) {
	const now = Math.floor(Date.now() / 1000);
	db().prepare(`
		UPDATE tasks SET status = 'done', completed_by = ?, completed_at = ?
		WHERE task_id = ?
	`).run(completedBy, now, taskId);
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
	let sql = 'SELECT * FROM tasks WHERE status = ?';
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
		ORDER BY r.remind_at ASC
	`).all(now);
}

/**
 * Mark a reminder as sent.
 */
function markReminderSent(reminderId) {
	db().prepare('UPDATE task_reminders SET sent = 1 WHERE id = ?').run(reminderId);
}

module.exports = {
	createTask,
	createReminder,
	completeTask,
	getTask,
	listPendingTasks,
	getDueReminders,
	markReminderSent
};
