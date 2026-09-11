/**
 * Activity points repository: database operations for the activity economy.
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
	return db()
		.prepare(
			`
		SELECT user_id, balance
		FROM activity_balances
		WHERE balance != 0
		ORDER BY balance DESC
		LIMIT ?
	`
		)
		.all(limit);
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
		db()
			.prepare(
				`
			INSERT INTO activity_ledger (user_id, amount, kind, granted_by, note, block_height, created_at)
			VALUES (?, ?, 'grant', ?, ?, ?, ?)
		`
			)
			.run(userId, amount, grantedBy, note || null, blockHeight, now);

		db()
			.prepare(
				`
			INSERT INTO activity_balances (user_id, balance)
			VALUES (?, ?)
			ON CONFLICT(user_id) DO UPDATE SET balance = balance + excluded.balance
		`
			)
			.run(userId, amount);

		return getBalance(userId);
	});

	return tx();
}

/**
 * Grant APs to many users as a single all-or-nothing batch.
 *
 * A role grant or a CSV bulk grant is anchored by one blockchain block, so the
 * database half has to behave like one unit: every recipient is credited or
 * none is. The batch key makes a retry safe, because the block and the batch
 * both carry the same interaction id and the second attempt is reported as
 * already applied instead of double-crediting.
 *
 * @param {object} params
 * @param {string} params.batchKey - idempotency key, normally the Discord interaction id
 * @param {Array<{discord_id: string, points: number, note?: string}>} params.entries
 * @param {string} params.grantedBy - admin Discord ID
 * @param {string} [params.note] - ledger note applied to every entry
 * @param {number} params.blockHeight - Luce block height anchoring the batch
 * @returns {{applied: boolean, balances: Array<{discord_id: string, balance: number}>}}
 *   `applied` is false when this batch key was already processed
 */
function grantPointsMany({ batchKey, entries, grantedBy, note, blockHeight }) {
	const now = Math.floor(Date.now() / 1000);

	const tx = db().transaction(() => {
		const claim = db()
			.prepare(
				`
			INSERT OR IGNORE INTO ap_grant_batches (batch_key, block_height, created_at)
			VALUES (?, ?, ?)
		`
			)
			.run(batchKey, blockHeight, now);

		if (claim.changes === 0) {
			return { applied: false, balances: [] };
		}

		const insertLedger = db().prepare(`
			INSERT INTO activity_ledger (user_id, amount, kind, granted_by, note, block_height, created_at)
			VALUES (?, ?, 'grant', ?, ?, ?, ?)
		`);
		const upsertBalance = db().prepare(`
			INSERT INTO activity_balances (user_id, balance)
			VALUES (?, ?)
			ON CONFLICT(user_id) DO UPDATE SET balance = balance + excluded.balance
		`);

		const balances = [];
		for (const entry of entries) {
			insertLedger.run(entry.discord_id, entry.points, grantedBy, entry.note || note || null, blockHeight, now);
			upsertBalance.run(entry.discord_id, entry.points);
			balances.push({ discord_id: entry.discord_id, balance: getBalance(entry.discord_id) });
		}

		return { applied: true, balances };
	});

	return tx();
}

/**
 * Reserve an AP purchase before anchoring it on the blockchain.
 *
 * The purchase used to be anchored first and only then debited, so a double
 * click appended two "completed purchase" blocks while a single debit went
 * through, and a crash after the block left a purchase that had no balance
 * movement. Reserving first reverses the dependency: the debit and the pending
 * purchase row commit together, and the block is anchored against an existing
 * reservation. That row is created with block_height 0 and status 'pending'
 * until finalizeApPurchase stamps the confirmed height.
 *
 * @param {object} params
 * @param {string} params.purchaseId
 * @param {string} params.userId
 * @param {number} params.itemId
 * @param {number} params.apCost
 * @returns {number|null} new balance, or null when the user cannot afford it
 */
function reserveApPurchase({ purchaseId, userId, itemId, apCost }) {
	const now = Math.floor(Date.now() / 1000);

	const tx = db().transaction(() => {
		// Ensure a balance row exists so the conditional debit below is
		// deterministic even for a zero-cost item or a first-time spender.
		db()
			.prepare(
				`
			INSERT INTO activity_balances (user_id, balance)
			VALUES (?, 0)
			ON CONFLICT(user_id) DO NOTHING
		`
			)
			.run(userId);

		const debit = db()
			.prepare(
				`
			UPDATE activity_balances SET balance = balance - ?
			WHERE user_id = ? AND balance >= ?
		`
			)
			.run(apCost, userId, apCost);

		if (debit.changes === 0) {
			return null;
		}

		db()
			.prepare(
				`
			INSERT INTO activity_ledger (user_id, amount, kind, reference_id, block_height, created_at)
			VALUES (?, ?, 'purchase', ?, 0, ?)
		`
			)
			.run(userId, -apCost, purchaseId, now);

		db()
			.prepare(
				`
			INSERT INTO purchases (id, user_id, item_id, payment_method, status, cost_ap, cost_rp, block_height, created_at)
			VALUES (?, ?, ?, 'ap', 'pending', ?, 0, NULL, ?)
		`
			)
			.run(purchaseId, userId, itemId, apCost, now);

		return getBalance(userId);
	});

	return tx();
}

/**
 * Mark a reserved AP purchase as completed once its block is anchored.
 *
 * @param {object} params
 * @param {string} params.purchaseId
 * @param {number} params.blockHeight
 * @returns {boolean} true when both the purchase and its ledger row were stamped
 */
function finalizeApPurchase({ purchaseId, blockHeight }) {
	const tx = db().transaction(() => {
		const purchase = db()
			.prepare(
				`
			UPDATE purchases SET status = 'completed', block_height = ?
			WHERE id = ? AND payment_method = 'ap' AND status = 'pending'
		`
			)
			.run(blockHeight, purchaseId);

		if (purchase.changes === 0) {
			return false;
		}

		db()
			.prepare(
				`
			UPDATE activity_ledger SET block_height = ?
			WHERE reference_id = ? AND kind = 'purchase'
		`
			)
			.run(blockHeight, purchaseId);

		return true;
	});

	return tx();
}

/**
 * Roll back a reserved AP purchase, restoring the spent points.
 *
 * Used when the blockchain append fails, and by the startup sweep that releases
 * reservations abandoned by a crash. Only a still-pending AP purchase can be
 * released, so a completed purchase is never undone.
 *
 * @param {object} params
 * @param {string} params.purchaseId
 * @returns {boolean} true when a reservation was released
 */
function releaseApPurchase({ purchaseId }) {
	const tx = db().transaction(() => {
		const purchase = db()
			.prepare(
				`
			SELECT id, user_id, cost_ap FROM purchases
			WHERE id = ? AND payment_method = 'ap' AND status = 'pending'
		`
			)
			.get(purchaseId);

		if (!purchase) {
			return false;
		}

		db()
			.prepare(
				`
			DELETE FROM activity_ledger WHERE reference_id = ? AND kind = 'purchase'
		`
			)
			.run(purchaseId);
		db().prepare('DELETE FROM purchases WHERE id = ?').run(purchaseId);

		// Put the reserved points back. The conditional debit already proved the
		// cost was covered, so this restore can never take a balance negative.
		db()
			.prepare('UPDATE activity_balances SET balance = balance + ? WHERE user_id = ?')
			.run(purchase.cost_ap, purchase.user_id);

		return true;
	});

	return tx();
}

/**
 * Release AP reservations abandoned by a crash, so startup does not strand a
 * user's points behind a purchase that was never anchored.
 *
 * @param {object} [params]
 * @param {number} [params.olderThanSeconds=900] - age threshold for a reservation
 * @returns {number} count of released reservations
 */
function releaseStaleApReservations({ olderThanSeconds = 900 } = {}) {
	const cutoff = Math.floor(Date.now() / 1000) - olderThanSeconds;
	const stale = db()
		.prepare(
			`
		SELECT id FROM purchases
		WHERE payment_method = 'ap' AND status = 'pending' AND created_at < ?
	`
		)
		.all(cutoff);

	let released = 0;
	for (const row of stale) {
		if (releaseApPurchase({ purchaseId: row.id })) {
			released++;
		}
	}

	return released;
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
	const now = Math.floor(Date.now() / 1000);

	const tx = db().transaction(() => {
		// The affordability guard IS the debit. A separate getBalance() read
		// outside the transaction could go stale between the check and the write,
		// which is exactly the hole that would allow a negative balance if a
		// second writer ever appeared. Zero changed rows means the user could not
		// afford it, and nothing else is written.
		const debit = db()
			.prepare(
				`
			UPDATE activity_balances SET balance = balance - ?
			WHERE user_id = ? AND balance >= ?
		`
			)
			.run(apCost, userId, apCost);

		if (debit.changes === 0) {
			return null;
		}

		db()
			.prepare(
				`
			INSERT INTO activity_ledger (user_id, amount, kind, reference_id, block_height, created_at)
			VALUES (?, ?, 'purchase', ?, ?, ?)
		`
			)
			.run(userId, -apCost, purchaseId, blockHeight, now);

		db()
			.prepare(
				`
			INSERT INTO purchases (id, user_id, item_id, payment_method, status, cost_ap, cost_rp, block_height, created_at)
			VALUES (?, ?, ?, 'ap', 'completed', ?, 0, ?, ?)
		`
			)
			.run(purchaseId, userId, itemId, apCost, blockHeight, now);

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
	const now = Math.floor(Date.now() / 1000);

	const tx = db().transaction(() => {
		// Same pattern as completeApPurchase: the conditional debit is the guard,
		// so it cannot be separated from the write by a stale read.
		const debit = db()
			.prepare(
				`
			UPDATE activity_balances SET balance = balance - ?
			WHERE user_id = ? AND balance >= ?
		`
			)
			.run(amount, userId, amount);

		if (debit.changes === 0) {
			return null;
		}

		db()
			.prepare(
				`
			INSERT INTO activity_ledger (user_id, amount, kind, reference_id, block_height, created_at)
			VALUES (?, ?, 'purchase', ?, ?, ?)
		`
			)
			.run(userId, -amount, purchaseId, blockHeight, now);

		return getBalance(userId);
	});

	return tx();
}

/**
 * Get all store items, ordered by AP price ascending.
 * @returns {Array<object>}
 */
function getStoreItems() {
	return db()
		.prepare(
			`
		SELECT id, slug, name, description, ap_price, rp_price
		FROM store_items
		ORDER BY ap_price ASC
	`
		)
		.all();
}

/**
 * Get a single store item by slug.
 * @param {string} slug
 * @returns {object|undefined}
 */
function getStoreItemBySlug(slug) {
	return db()
		.prepare(
			`
		SELECT id, slug, name, description, ap_price, rp_price
		FROM store_items
		WHERE slug = ?
	`
		)
		.get(slug);
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
	db()
		.prepare(
			`
		INSERT INTO purchases (id, user_id, item_id, payment_method, status, cost_ap, cost_rp, block_height, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`
		)
		.run(id, userId, itemId, paymentMethod, status, costAp, costRp, blockHeight || null, now);
}

/**
 * Get a purchase by id.
 * @param {string} id
 * @returns {object|undefined}
 */
function getPurchase(id) {
	return db()
		.prepare(
			`
		SELECT p.*, s.name AS item_name, s.slug AS item_slug
		FROM purchases p
		JOIN store_items s ON s.id = p.item_id
		WHERE p.id = ?
	`
		)
		.get(id);
}

/**
 * List pending (unconfirmed) Rp purchases, oldest first.
 * @returns {Array<object>}
 */
function listPendingPurchases() {
	return db()
		.prepare(
			`
		SELECT p.*, s.name AS item_name, s.slug AS item_slug
		FROM purchases p
		JOIN store_items s ON s.id = p.item_id
		WHERE p.status = 'pending' AND p.payment_method = 'rp'
		ORDER BY p.created_at ASC
	`
		)
		.all();
}

/**
 * Claim a pending purchase for confirmation, before anchoring a block.
 *
 * The claim is a conditional update, so exactly one caller can win an
 * unclaimed (or lease-expired) pending purchase. Without it two admins could
 * both read `pending`, both anchor a confirmation block, and both report
 * success while only one row changed.
 *
 * @param {object} params
 * @param {string} params.id - purchase id
 * @param {string} params.claimedBy - admin Discord ID
 * @param {number} [params.leaseSeconds=120]
 * @returns {boolean} true when this caller now holds the claim
 */
function claimPurchaseConfirmation({ id, claimedBy, leaseSeconds = 120 }) {
	const now = Math.floor(Date.now() / 1000);
	const result = db()
		.prepare(
			`
		UPDATE purchases
		SET confirm_claim_by = ?, confirm_claim_until = ?
		WHERE id = ? AND status = 'pending'
		AND (confirm_claim_until IS NULL OR confirm_claim_until < ?)
	`
		)
		.run(claimedBy, now + leaseSeconds, id, now);
	return result.changes > 0;
}

/**
 * Release a confirmation claim, e.g. after the blockchain append failed.
 *
 * @param {object} params
 * @param {string} params.id
 * @param {string} params.claimedBy
 * @returns {boolean} true when a claim was cleared
 */
function releasePurchaseConfirmation({ id, claimedBy }) {
	const result = db()
		.prepare(
			`
		UPDATE purchases
		SET confirm_claim_by = NULL, confirm_claim_until = NULL
		WHERE id = ? AND confirm_claim_by = ?
	`
		)
		.run(id, claimedBy);
	return result.changes > 0;
}

/**
 * Stamp the anchoring block height onto a purchase row that has none yet.
 *
 * Used by the Rp flow, which creates the pending row before anchoring.
 *
 * @param {object} params
 * @param {string} params.id
 * @param {number} params.blockHeight
 * @returns {boolean} true when a row was stamped
 */
function setPurchaseBlockHeight({ id, blockHeight }) {
	const result = db()
		.prepare('UPDATE purchases SET block_height = ? WHERE id = ? AND block_height IS NULL')
		.run(blockHeight, id);
	return result.changes > 0;
}

/**
 * Delete a still-pending purchase, used when anchoring its block failed so no
 * phantom purchase is left behind.
 *
 * @param {string} id
 * @returns {boolean} true when a row was removed
 */
function deletePendingPurchase(id) {
	const result = db().prepare("DELETE FROM purchases WHERE id = ? AND status = 'pending'").run(id);
	return result.changes > 0;
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
	const result = db()
		.prepare(
			`
		UPDATE purchases
		SET status = 'completed', block_height = ?, confirmed_at = ?, confirmed_by = ?,
			confirm_claim_by = NULL, confirm_claim_until = NULL
		WHERE id = ? AND status = 'pending'
	`
		)
		.run(blockHeight, now, confirmedBy, id);
	return result.changes > 0;
}

/**
 * Get a user's purchase history, newest first.
 * @param {string} userId
 * @param {number} [limit=20]
 * @returns {Array<object>}
 */
function getUserPurchases(userId, limit = 20) {
	return db()
		.prepare(
			`
		SELECT p.*, s.name AS item_name, s.slug AS item_slug
		FROM purchases p
		JOIN store_items s ON s.id = p.item_id
		WHERE p.user_id = ?
		ORDER BY p.created_at DESC
		LIMIT ?
	`
		)
		.all(userId, limit);
}

module.exports = {
	getBalance,
	getLeaderboard,
	grantPoints,
	grantPointsMany,
	spendPoints,
	completeApPurchase,
	getStoreItems,
	getStoreItemBySlug,
	createPurchase,
	getPurchase,
	listPendingPurchases,
	reserveApPurchase,
	finalizeApPurchase,
	releaseApPurchase,
	releaseStaleApReservations,
	setPurchaseBlockHeight,
	deletePendingPurchase,
	claimPurchaseConfirmation,
	releasePurchaseConfirmation,
	confirmPurchase,
	getUserPurchases
};
