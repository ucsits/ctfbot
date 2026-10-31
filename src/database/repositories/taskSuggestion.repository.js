/**
 * Task suggestion repository — suggestion cards posted from conversations
 * @module database/repositories/taskSuggestion
 */

const { getConnection } = require('../connection');

const db = () => getConnection();

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * Insert a suggestion. Returns false when one already exists for the same
 * source message in that channel, in which case no card should be posted.
 *
 * @returns {boolean}
 */
function createSuggestion({ id, channelId, sourceMessageId, title, description, assigneeId, deadline }) {
	const result = db()
		.prepare(
			`
		INSERT OR IGNORE INTO task_suggestions
			(id, channel_id, source_message_id, title, description, assignee_id, deadline, status, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)
	`
		)
		.run(id, channelId, sourceMessageId, title, description || null, assigneeId, deadline ?? null, nowSeconds());
	return result.changes > 0;
}

/**
 * Remove a suggestion whose card could not be posted, so the decision can be
 * suggested again on a later pass.
 */
function deleteSuggestion(id) {
	db().prepare("DELETE FROM task_suggestions WHERE id = ? AND status = 'open'").run(id);
}

/**
 * Record the message id of the posted card.
 */
function setCardMessage(id, cardMessageId) {
	db().prepare('UPDATE task_suggestions SET card_message_id = ? WHERE id = ?').run(cardMessageId, id);
}

/**
 * Fetch a suggestion in any status, or undefined.
 */
function getSuggestion(id) {
	return db().prepare('SELECT * FROM task_suggestions WHERE id = ?').get(id);
}

/**
 * Atomically claim an open suggestion (or one whose lease ran out) so two
 * clicks cannot both act on it. Returns the row, or null when it is missing,
 * already handled, or being handled right now.
 */
function claimSuggestion(id, leaseSeconds = 120) {
	const now = nowSeconds();
	const result = db()
		.prepare(
			`
		UPDATE task_suggestions SET status = 'working', claimed_until = ?
		WHERE id = ? AND (status = 'open' OR (status = 'working' AND claimed_until < ?))
	`
		)
		.run(now + leaseSeconds, id, now);
	return result.changes > 0 ? getSuggestion(id) : null;
}

/**
 * Put a claimed suggestion back to open so it can be retried.
 */
function releaseSuggestion(id) {
	db()
		.prepare(
			"UPDATE task_suggestions SET status = 'open', claimed_until = NULL WHERE id = ? AND status = 'working'"
		)
		.run(id);
}

/**
 * Close a suggestion as created or dismissed.
 *
 * @param {string} id
 * @param {object} params
 * @param {'created'|'dismissed'} params.status
 * @param {string} params.handledBy - Discord user id
 * @param {string} [params.taskId]
 */
function finishSuggestion(id, { status, handledBy, taskId = null }) {
	db()
		.prepare(
			`
		UPDATE task_suggestions
		SET status = ?, handled_by = ?, task_id = ?, handled_at = ?, claimed_until = NULL
		WHERE id = ?
	`
		)
		.run(status, handledBy, taskId, nowSeconds(), id);
}

/**
 * Source message ids that already have a suggestion in this channel.
 *
 * @returns {Set<string>}
 */
function suggestedSourceIds(channelId, sourceMessageIds) {
	if (sourceMessageIds.length === 0) {
		return new Set();
	}
	const placeholders = sourceMessageIds.map(() => '?').join(', ');
	const rows = db()
		.prepare(
			`SELECT source_message_id FROM task_suggestions WHERE channel_id = ? AND source_message_id IN (${placeholders})`
		)
		.all(channelId, ...sourceMessageIds);
	return new Set(rows.map(r => r.source_message_id));
}

/**
 * Titles of the most recent suggestions in a channel, newest last, so the
 * model can avoid repeating them.
 *
 * @returns {string[]}
 */
function recentTitles(channelId, limit = 20) {
	return db()
		.prepare('SELECT title FROM task_suggestions WHERE channel_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
		.all(channelId, limit)
		.map(r => r.title)
		.reverse();
}

module.exports = {
	createSuggestion,
	deleteSuggestion,
	setCardMessage,
	getSuggestion,
	claimSuggestion,
	releaseSuggestion,
	finishSuggestion,
	suggestedSourceIds,
	recentTitles
};
