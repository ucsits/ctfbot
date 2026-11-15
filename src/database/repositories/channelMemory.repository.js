/**
 * Channel memory repository for what the bot knows about a channel.
 *
 * Separate from actor_memories (per-user). A channel note is a fact about the
 * room itself, such as what it is for, its jargon, house rules ("jangan bahas
 * politik"), and the things the bot already said. That stops it from repeating
 * them.
 *
 * @module database/repositories/channelMemory
 */

const { getConnection } = require('../connection');

const db = () => getConnection();

const nowSeconds = () => Math.floor(Date.now() / 1000);

// Oldest notes are dropped past this. The prompt stays small.
const MAX_NOTES_PER_CHANNEL = 30;
const MAX_NOTE_CHARS = 240;

const KINDS = new Set(['topic', 'jargon', 'preference', 'said', 'fact']);

/**
 * Notes for a channel, oldest first.
 *
 * @param {string} channelId
 * @param {number} [limit]
 * @returns {Array<{ id: number, note: string, kind: string, created_at: number }>}
 */
function listNotes(channelId, limit = MAX_NOTES_PER_CHANNEL) {
	return db()
		.prepare(
			'SELECT id, note, kind, created_at FROM channel_memory WHERE channel_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'
		)
		.all(channelId, limit)
		.reverse();
}

/**
 * Store a note about a channel. Returns the new id, or null when the same
 * note is already stored. Keeps at most MAX_NOTES_PER_CHANNEL notes.
 *
 * @returns {number|null}
 */
function addNote(channelId, note, { kind = 'topic', sourceMessageId = null } = {}) {
	const text = String(note ?? '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, MAX_NOTE_CHARS);
	if (!text) {
		return null;
	}
	const result = db()
		.prepare(
			`
		INSERT OR IGNORE INTO channel_memory (channel_id, note, kind, source_message_id, created_at)
		VALUES (?, ?, ?, ?, ?)
	`
		)
		.run(channelId, text, KINDS.has(kind) ? kind : 'topic', sourceMessageId, nowSeconds());
	if (result.changes === 0) {
		return null;
	}
	db()
		.prepare(
			`
		DELETE FROM channel_memory WHERE channel_id = ? AND id NOT IN
			(SELECT id FROM channel_memory WHERE channel_id = ? ORDER BY id DESC LIMIT ?)
	`
		)
		.run(channelId, channelId, MAX_NOTES_PER_CHANNEL);
	return Number(result.lastInsertRowid);
}

/**
 * The bot's own recent messages, newest last. The prompt can then tell it not
 * to repeat itself. Stored as ordinary notes with kind 'said'.
 *
 * @returns {string[]}
 */
function recentSaid(channelId, limit = 5) {
	return db()
		.prepare("SELECT note FROM channel_memory WHERE channel_id = ? AND kind = 'said' ORDER BY id DESC LIMIT ?")
		.all(channelId, limit)
		.map(r => r.note)
		.reverse();
}

/** Drop every note for a channel. */
function clearChannel(channelId) {
	db().prepare('DELETE FROM channel_memory WHERE channel_id = ?').run(channelId);
}

/** Test helper. Forget every channel note. */
function _reset() {
	db().prepare('DELETE FROM channel_memory').run();
}

module.exports = {
	MAX_NOTES_PER_CHANNEL,
	MAX_NOTE_CHARS,
	KINDS,
	listNotes,
	addNote,
	recentSaid,
	clearChannel,
	_reset
};
