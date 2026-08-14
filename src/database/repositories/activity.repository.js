/**
 * Activity points repository — database operations for the activity economy.
 * Every AP transaction is backed by a Luce blockchain block; the ledger row
 * records the block height that anchors it.
 * @module database/repositories/activity.repository
 */

const { getConnection } = require('../connection');

const db = () => getConnection();

/**
 * Get a user's current AP balance (0 if never granted).
 * @param {string} userId - Discord user ID
 * @returns {number}
 */
function getBalance(userId) {
	const row = db().prepare('SELECT balance FROM activity_balances WHERE user_id = ?').get(userId);
	return row ? row.balance : 0;
}

/**
 * Get the activity leaderboard, ranked by balance descending.
 * @param {number} [limit=20]
 * @returns {Array<{user_id: string, balance: number}>}
 */
function getLeaderboard(limit = 20) {
	return db().prepare(`
		SELECT user_id, balance
		FROM activity_balances
		WHERE balance != 0
		ORDER BY balance DESC
		LIMIT ?
	`).all(limit);
}

/**
 * Grant APs to a user. Appends a ledger entry and credits the balance
 * atomically. Returns the resulting balance.
 *
 * @param {object} params
 * @param {string} params.userId - recipient
 * @param {number} params.amount - positive integer points
 * @param {string} params.grantedBy - admin Discord ID
 * @param {string} [params.note]
 * @param {number} params.blockHeight - Luce block height anchoring this grant
 * @returns {number} new balance
 */
function grantPoints({ userId, amount, grantedBy, note, blockHeight }) {
	const now = Math.floor(Date.now() / 1000);

	const tx = db().transaction(() => {
		db().prepare(`
			INSERT INTO activity_ledger (user_id, amount, kind, granted_by, note, block_height, created_at)
			VALUES (?, ?, 'grant', ?, ?, ?, ?)
		`).run(userId, amount, grantedBy, note || null, blockHeight, now);

		db().prepare(`
			INSERT INTO activity_balances (user_id, balance)
			VALUES (?, ?)
			ON CONFLICT(user_id) DO UPDATE SET balance = balance + excluded.balance
		`).run(userId, amount);

		return getBalance(userId);
	});

	return tx();
}

/**
 * Complete an AP purchase atomically: spend the points (with an insufficient-
 * funds guard) and create the completed purchase row in one DB transaction.
 * Returns the new balance, or null if the user cannot afford it.
 *
 * @param {object} params
 * @param {string} params.purchaseId
 * @param {string} params.userId
 * @param {number} params.itemId
 * @param {number} params.apCost
 * @param {number} params.blockHeight
 * @returns {number|null} new balance, or null if insufficient funds
 */
function completeApPurchase({ purchaseId, userId, itemId, apCost, blockHeight }) {
	const current = getBalance(userId);
	if (current < apCost) {
		return null;
	}

	const now = Math.floor(Date.now() / 1000);

	const tx = db().transaction(() => {
		db().prepare(`
			INSERT INTO activity_ledger (user_id, amount, kind, reference_id, block_height, created_at)
			VALUES (?, ?, 'purchase', ?, ?, ?)
		`).run(userId, -apCost, purchaseId, blockHeight, now);

		db().prepare(`
			UPDATE activity_balances SET balance = balance - ? WHERE user_id = ?
		`).run(apCost, userId);

		db().prepare(`
			INSERT INTO purchases (id, user_id, item_id, payment_method, status, cost_ap, cost_rp, block_height, created_at)
			VALUES (?, ?, ?, 'ap', 'completed', ?, 0, ?, ?)
		`).run(purchaseId, userId, itemId, apCost, blockHeight, now);

		return getBalance(userId);
	});

	return tx();
}

/**
 * Spend APs on a purchase. Returns the new balance, or null if the user
 * does not have enough points (nothing is written).
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {number} params.amount - positive integer points to spend
 * @param {string} params.purchaseId - purchase row id
 * @param {number} params.blockHeight - Luce block height anchoring this spend
 * @returns {number|null}
 */
function spendPoints({ userId, amount, purchaseId, blockHeight }) {
	const current = getBalance(userId);
	if (current < amount) {
		return null;
	}

	const now = Math.floor(Date.now() / 1000);

	const tx = db().transaction(() => {
		db().prepare(`
			INSERT INTO activity_ledger (user_id, amount, kind, reference_id, block_height, created_at)
			VALUES (?, ?, 'purchase', ?, ?, ?)
		`).run(userId, -amount, purchaseId, blockHeight, now);

		db().prepare(`
			UPDATE activity_balances SET balance = balance - ? WHERE user_id = ?
		`).run(amount, userId);

		return getBalance(userId);
	});

	return tx();
}

/**
 * Get all store items, ordered by AP price ascending.
 * @returns {Array<object>}
 */
function getStoreItems() {
	return db().prepare(`
		SELECT id, slug, name, description, ap_price, rp_price
		FROM store_items
		ORDER BY ap_price ASC
	`).all();
}

/**
 * Get a single store item by slug.
 * @param {string} slug
 * @returns {object|undefined}
 */
function getStoreItemBySlug(slug) {
	return db().prepare(`
		SELECT id, slug, name, description, ap_price, rp_price
		FROM store_items
		WHERE slug = ?
	`).get(slug);
}

/**
 * Create a purchase record.
 * @param {object} params
 * @param {string} params.id - uuid
 * @param {string} params.userId
 * @param {number} params.itemId
 * @param {'ap'|'rp'} params.paymentMethod
 * @param {'pending'|'completed'} params.status
 * @param {number} params.costAp
 * @param {number} params.costRp
 * @param {number} [params.blockHeight] - set when completed immediately (AP)
 */
function createPurchase({ id, userId, itemId, paymentMethod, status, costAp, costRp, blockHeight }) {
	const now = Math.floor(Date.now() / 1000);
	db().prepare(`
		INSERT INTO purchases (id, user_id, item_id, payment_method, status, cost_ap, cost_rp, block_height, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(id, userId, itemId, paymentMethod, status, costAp, costRp, blockHeight || null, now);
}

/**
 * Get a purchase by id.
 * @param {string} id
 * @returns {object|undefined}
 */
function getPurchase(id) {
	return db().prepare(`
		SELECT p.*, s.name AS item_name, s.slug AS item_slug
		FROM purchases p
		JOIN store_items s ON s.id = p.item_id
		WHERE p.id = ?
	`).get(id);
}

/**
 * List pending (unconfirmed) Rp purchases, oldest first.
 * @returns {Array<object>}
 */
function listPendingPurchases() {
	return db().prepare(`
		SELECT p.*, s.name AS item_name, s.slug AS item_slug
		FROM purchases p
		JOIN store_items s ON s.id = p.item_id
		WHERE p.status = 'pending'
		ORDER BY p.created_at ASC
	`).all();
}

/**
 * Confirm a pending purchase (admin confirms offline Rp payment).
 * @param {object} params
 * @param {string} params.id - purchase id
 * @param {string} params.confirmedBy - admin Discord ID
 * @param {number} params.blockHeight - Luce block height anchoring the confirmation
 * @returns {boolean} true if a row was updated
 */
function confirmPurchase({ id, confirmedBy, blockHeight }) {
	const now = Math.floor(Date.now() / 1000);
	const result = db().prepare(`
		UPDATE purchases
		SET status = 'completed', block_height = ?, confirmed_at = ?, confirmed_by = ?
		WHERE id = ? AND status = 'pending'
	`).run(blockHeight, now, confirmedBy, id);
	return result.changes > 0;
}

/**
 * Get a user's purchase history, newest first.
 * @param {string} userId
 * @param {number} [limit=20]
 * @returns {Array<object>}
 */
function getUserPurchases(userId, limit = 20) {
	return db().prepare(`
		SELECT p.*, s.name AS item_name, s.slug AS item_slug
		FROM purchases p
		JOIN store_items s ON s.id = p.item_id
		WHERE p.user_id = ?
		ORDER BY p.created_at DESC
		LIMIT ?
	`).all(userId, limit);
}

module.exports = {
	getBalance,
	getLeaderboard,
	grantPoints,
	spendPoints,
	completeApPurchase,
	getStoreItems,
	getStoreItemBySlug,
	createPurchase,
	getPurchase,
	listPendingPurchases,
	confirmPurchase,
	getUserPurchases
};
