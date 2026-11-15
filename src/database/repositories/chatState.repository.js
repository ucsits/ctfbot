/**
 * Chat state repository — per-channel gate for proactive messages.
 *
 * Keeps mute, backoff, engagement tracking and the send budget in SQLite so a
 * restart does not reset a channel that was muted or that the bot learned to
 * leave alone.
 *
 * @module database/repositories/chatState
 */

const { getConnection } = require('../connection');

const db = () => getConnection();

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Hour bucket for the hourly budget, as a plain unix hour number. */
const hourBucket = (now = Date.now()) => Math.floor(now / 3_600_000);

/**
 * One row per channel, created on first use.
 *
 * @returns {object}
 */
function getState(channelId) {
	const existing = db().prepare('SELECT * FROM channel_chat_state WHERE channel_id = ?').get(channelId);
	if (existing) {
		return existing;
	}
	db().prepare('INSERT OR IGNORE INTO channel_chat_state (channel_id, ignored_streak) VALUES (?, 0)').run(channelId);
	return db().prepare('SELECT * FROM channel_chat_state WHERE channel_id = ?').get(channelId);
}

/**
 * Point a channel row at its guild, so guild-wide budgets can be enforced.
 */
function setGuild(channelId, guildId) {
	if (!guildId) {
		return;
	}
	db()
		.prepare('UPDATE channel_chat_state SET guild_id = ? WHERE channel_id = ? AND guild_id IS NOT ?')
		.run(guildId, channelId, guildId);
}

/**
 * Mute a channel until the given unix second. Pass null to lift the mute.
 */
function setMutedUntil(channelId, until) {
	getState(channelId);
	db().prepare('UPDATE channel_chat_state SET muted_until = ? WHERE channel_id = ?').run(until, channelId);
}

/**
 * Record that a human spoke in this channel.
 */
function noteHuman(channelId, at = nowSeconds()) {
	getState(channelId);
	db().prepare('UPDATE channel_chat_state SET last_human_at = ? WHERE channel_id = ?').run(at, channelId);
}

/**
 * Record that the bot spoke: when, which message, and that it is now waiting
 * to see whether anyone reacts or replies.
 */
function noteSpoke(channelId, messageId, at = nowSeconds()) {
	getState(channelId);
	db()
		.prepare(
			`
		UPDATE channel_chat_state
		SET last_spoke_at = ?, last_spoke_message_id = ?, awaiting_since = ?
		WHERE channel_id = ?
	`
		)
		.run(at, messageId, at, channelId);
}

/**
 * Someone replied to or reacted to the bot's last message, so the channel is
 * paying attention. Resets the ignored streak.
 */
function noteEngaged(channelId) {
	getState(channelId);
	db()
		.prepare('UPDATE channel_chat_state SET awaiting_since = NULL, ignored_streak = 0 WHERE channel_id = ?')
		.run(channelId);
}

/**
 * Bump the ignored streak and start the adaptive backoff. Called when the bot
 * spoke, nobody engaged, and it is about to consider speaking again.
 *
 * @returns {number} the new streak
 */
function noteIgnored(channelId) {
	const state = getState(channelId);
	const streak = (state.ignored_streak ?? 0) + 1;
	db()
		.prepare('UPDATE channel_chat_state SET ignored_streak = ?, awaiting_since = NULL WHERE channel_id = ?')
		.run(streak, channelId);
	return streak;
}

/**
 * Set a soft backoff window: the bot stays quiet until `until`, without the
 * channel being explicitly muted.
 */
function setBackoffUntil(channelId, until) {
	getState(channelId);
	db().prepare('UPDATE channel_chat_state SET backoff_until = ? WHERE channel_id = ?').run(until, channelId);
}

/**
 * Whether the channel still has budget for one more proactive message.
 *
 * @param {object} params
 * @param {string} params.channelId
 * @param {string|null} [params.guildId]
 * @param {number} params.maxPerHour
 * @param {number} params.maxPerDay
 * @param {number} params.guildMaxPerDay
 * @returns {{ ok: boolean, reason?: string }}
 */
function budgetAvailable({ channelId, guildId = null, maxPerHour, maxPerDay, guildMaxPerDay }) {
	const state = getState(channelId);
	const hour = hourBucket();
	const day = dayBucketNow();

	if (state.hour_bucket === hour && state.hour_count >= maxPerHour) {
		return { ok: false, reason: `hourly budget (${maxPerHour}) reached` };
	}
	if (state.day_bucket === day && state.day_count >= maxPerDay) {
		return { ok: false, reason: `daily budget (${maxPerDay}) reached` };
	}
	if (guildId && guildMaxPerDay > 0) {
		const guild = db().prepare('SELECT * FROM guild_chat_state WHERE guild_id = ?').get(guildId);
		if (guild?.day_bucket === day && guild.day_count >= guildMaxPerDay) {
			return { ok: false, reason: `guild daily budget (${guildMaxPerDay}) reached` };
		}
	}
	return { ok: true };
}

/**
 * Count one sent proactive message against the channel and guild budgets.
 */
function consumeBudget({ channelId, guildId = null }) {
	const hour = hourBucket();
	const day = dayBucketNow();

	db()
		.prepare(
			`
		INSERT INTO channel_chat_state (channel_id, hour_bucket, hour_count, day_bucket, day_count)
		VALUES (?, ?, 1, ?, 1)
		ON CONFLICT (channel_id) DO UPDATE SET
			hour_count = CASE WHEN hour_bucket = excluded.hour_bucket THEN hour_count + 1 ELSE 1 END,
			hour_bucket = excluded.hour_bucket,
			day_count  = CASE WHEN day_bucket = excluded.day_bucket THEN day_count + 1 ELSE 1 END,
			day_bucket = excluded.day_bucket
	`
		)
		.run(channelId, hour, day);

	if (guildId) {
		db()
			.prepare(
				`
			INSERT INTO guild_chat_state (guild_id, day_bucket, day_count) VALUES (?, ?, 1)
			ON CONFLICT (guild_id) DO UPDATE SET
				day_count  = CASE WHEN day_bucket = excluded.day_bucket THEN day_count + 1 ELSE 1 END,
				day_bucket = excluded.day_bucket
		`
			)
			.run(guildId, day);
	}
}

/**
 * Local calendar day, so "20 messages per day" resets at local midnight
 * instead of at an arbitrary UTC hour.
 */
function dayBucketNow() {
	const { DateTime } = require('luxon');
	const { DEFAULT_TIMEZONE } = require('../../lib/constants/config');
	return DateTime.now().setZone(DEFAULT_TIMEZONE).toFormat('yyyy-MM-dd');
}

/** Test helper: forget every channel's gate state. */
function _reset() {
	db().prepare('DELETE FROM channel_chat_state').run();
	db().prepare('DELETE FROM guild_chat_state').run();
}

module.exports = {
	getState,
	setGuild,
	setMutedUntil,
	noteHuman,
	noteSpoke,
	noteEngaged,
	noteIgnored,
	setBackoffUntil,
	budgetAvailable,
	consumeBudget,
	_reset
};
