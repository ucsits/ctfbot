/**
 * Search cache repository for cached SerpBase results and daily credit spend.
 *
 * It uses two small tables. `search_cache` keeps a compacted result payload per
 * normalised query for a day. `search_spend` counts credits. A loop or a popular
 * question cannot then drain the account.
 *
 * @module database/repositories/searchCache
 */

const { getConnection } = require('../connection');
const { DateTime } = require('luxon');
const { DEFAULT_TIMEZONE } = require('../../lib/constants/config');

const db = () => getConnection();

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Local calendar day. The credit cap resets at local midnight. */
function dayBucket() {
	return DateTime.now().setZone(DEFAULT_TIMEZONE).toFormat('yyyy-MM-dd');
}

/**
 * A cached result payload, or null when missing or older than `maxAgeHours`.
 *
 * @returns {object|null}
 */
function get(queryKey, maxAgeHours = 24) {
	const row = db().prepare('SELECT payload, created_at FROM search_cache WHERE query_key = ?').get(queryKey);
	if (!row) {
		return null;
	}
	if (nowSeconds() - row.created_at > maxAgeHours * 3600) {
		return null;
	}
	try {
		return JSON.parse(row.payload);
	} catch {
		return null;
	}
}

/**
 * Cache a result payload. Old rows are pruned so the table stays small.
 */
function put(queryKey, payload, { maxRows = 500 } = {}) {
	db()
		.prepare(
			`
		INSERT INTO search_cache (query_key, payload, created_at) VALUES (?, ?, ?)
		ON CONFLICT (query_key) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at
	`
		)
		.run(queryKey, JSON.stringify(payload), nowSeconds());
	db()
		.prepare(
			'DELETE FROM search_cache WHERE query_key NOT IN (SELECT query_key FROM search_cache ORDER BY created_at DESC LIMIT ?)'
		)
		.run(maxRows);
}

/**
 * Credits already spent today.
 *
 * @returns {number}
 */
function spentToday() {
	return db().prepare('SELECT credits FROM search_spend WHERE day_bucket = ?').get(dayBucket())?.credits ?? 0;
}

/**
 * Add to today's spend.
 *
 * @returns {number} the new total
 */
function addSpend(credits) {
	const day = dayBucket();
	db()
		.prepare(
			`
		INSERT INTO search_spend (day_bucket, credits) VALUES (?, ?)
		ON CONFLICT (day_bucket) DO UPDATE SET credits = credits + excluded.credits
	`
		)
		.run(day, Math.max(0, credits));
	return spentToday();
}

/** Test helper. Drop cached results and spend counters. */
function _reset() {
	db().prepare('DELETE FROM search_cache').run();
	db().prepare('DELETE FROM search_spend').run();
}

module.exports = {
	get,
	put,
	spentToday,
	addSpend,
	_reset
};
