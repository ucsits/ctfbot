/**
 * Reputation repository — database operations for rep ledger
 * @module database/repositories/reputation
 */

const { getConnection } = require('../connection');

const db = () => getConnection();

/**
 * Check if the giver has already used rep today (any amount, any target).
 * UTC date is used.
 *
 * @param {string} fromUser - Discord user ID of the giver
 * @returns {boolean}
 */
function hasGivenRepToday(fromUser) {
	const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
	const row = db().prepare(`
		SELECT COUNT(*) AS cnt FROM reputations WHERE from_user = ? AND date = ?
	`).get(fromUser, today);
	return row.cnt > 0;
}

/**
 * Record a reputation action.
 *
 * @param {object} params
 * @param {string} params.userId - recipient
 * @param {string} params.fromUser - giver
 * @param {number} params.amount - 1 or -1
 * @param {string} [params.reason]
 * @param {number} params.blockHeight
 */
function addReputation({ userId, fromUser, amount, reason, blockHeight }) {
	const now = Math.floor(Date.now() / 1000);
	const date = new Date().toISOString().slice(0, 10);
	db().prepare(`
		INSERT INTO reputations (user_id, from_user, amount, reason, date, block_height, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`).run(userId, fromUser, amount, reason || null, date, blockHeight, now);
}

/**
 * Get total rep for every user, ordered descending.
 *
 * @param {number} [limit=20]
 * @returns {Array<{user_id: string, total: number}>}
 */
function getLeaderboard(limit = 20) {
	return db().prepare(`
		SELECT user_id, SUM(amount) AS total
		FROM reputations
		GROUP BY user_id
		ORDER BY total DESC
		LIMIT ?
	`).all(limit);
}

/**
 * Get total rep for a single user.
 */
function getUserTotal(userId) {
	const row = db().prepare(`
		SELECT COALESCE(SUM(amount), 0) AS total FROM reputations WHERE user_id = ?
	`).get(userId);
	return row.total;
}

module.exports = {
	hasGivenRepToday,
	addReputation,
	getLeaderboard,
	getUserTotal
};
