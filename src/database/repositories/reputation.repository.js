/**
 * Reputation repository: database operations for rep ledger
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
 * Atomically claim the giver's rep slot for today (UTC).
 *
 * The daily limit used to be a read-then-write check (`hasGivenRepToday`
 * followed by an async blockchain append and then `addReputation`), which two
 * concurrent reactions or replies could both pass. This turns the check into a
 * single conditional insert so exactly one caller can win the day.
 *
 * `block_height` starts at 0 and is stamped by `finalizeReputationBlock` once
 * the chain write succeeds, so an unconfirmed claim is visible as height 0.
 *
 * @param {object} params
 * @param {string} params.userId - recipient
 * @param {string} params.fromUser - giver
 * @param {number} params.amount - 1 or -1
 * @param {string} [params.reason]
 * @returns {{claimed: boolean, date: string}} `claimed` is false when the
 *   giver already spent rep today (including losing a concurrent race)
 */
function claimDailyReputation({ userId, fromUser, amount, reason }) {
	const now = Math.floor(Date.now() / 1000);
	const date = new Date().toISOString().slice(0, 10);
	const result = db().prepare(`
		INSERT OR IGNORE INTO reputations (user_id, from_user, amount, reason, date, block_height, created_at)
		VALUES (?, ?, ?, ?, ?, 0, ?)
	`).run(userId, fromUser, amount, reason || null, date, now);

	return { claimed: result.changes > 0, date };
}

/**
 * Stamp the blockchain height onto a previously claimed rep row.
 *
 * @param {object} params
 * @param {string} params.fromUser - giver
 * @param {string} params.date - UTC date (YYYY-MM-DD) of the claim
 * @param {number} params.blockHeight
 */
function finalizeReputationBlock({ fromUser, date, blockHeight }) {
	db().prepare('UPDATE reputations SET block_height = ? WHERE from_user = ? AND date = ?')
		.run(blockHeight, fromUser, date);
}

/**
 * Release a claim whose blockchain append failed, so the giver can retry.
 *
 * @param {object} params
 * @param {string} params.fromUser - giver
 * @param {string} params.date - UTC date (YYYY-MM-DD) of the claim
 * @returns {boolean} true when a claim row was removed
 */
function releaseReputationClaim({ fromUser, date }) {
	const result = db().prepare('DELETE FROM reputations WHERE from_user = ? AND date = ?')
		.run(fromUser, date);
	return result.changes > 0;
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
	claimDailyReputation,
	finalizeReputationBlock,
	releaseReputationClaim,
	getLeaderboard,
	getUserTotal
};
