/**
 * Actor memory repository — per-user preferences and notes the bot remembers
 * @module database/repositories/actorMemory
 */

const { getConnection } = require('../connection');

const db = () => getConnection();

const nowSeconds = () => Math.floor(Date.now() / 1000);

// Oldest notes are dropped past this, so the prompt stays small.
const MAX_NOTES_PER_USER = 15;

/**
 * Preferred language of a user, or null when they never picked one.
 *
 * @returns {string|null}
 */
function getLanguage(userId) {
	return db().prepare('SELECT language FROM actor_profiles WHERE user_id = ?').get(userId)?.language ?? null;
}

/**
 * Set (or with null, reset) a user's preferred language.
 */
function setLanguage(userId, language) {
	db()
		.prepare(
			`
		INSERT INTO actor_profiles (user_id, language, updated_at) VALUES (?, ?, ?)
		ON CONFLICT (user_id) DO UPDATE SET language = excluded.language, updated_at = excluded.updated_at
	`
		)
		.run(userId, language, nowSeconds());
}

/**
 * Notes about a user, oldest first.
 *
 * @returns {Array<{ id: number, note: string, added_by: string|null, created_at: number }>}
 */
function listNotes(userId) {
	return db()
		.prepare('SELECT id, note, added_by, created_at FROM actor_memories WHERE user_id = ? ORDER BY id')
		.all(userId);
}

/**
 * Remember a note about a user. Returns the new note id, or null when the
 * same note is already stored. Keeps at most MAX_NOTES_PER_USER notes.
 *
 * @returns {number|null}
 */
function addNote(userId, note, { addedBy = null, sourceMessageId = null } = {}) {
	const result = db()
		.prepare(
			`
		INSERT OR IGNORE INTO actor_memories (user_id, note, added_by, source_message_id, created_at)
		VALUES (?, ?, ?, ?, ?)
	`
		)
		.run(userId, note, addedBy, sourceMessageId, nowSeconds());
	if (result.changes === 0) {
		return null;
	}
	db()
		.prepare(
			`
		DELETE FROM actor_memories WHERE user_id = ? AND id NOT IN
			(SELECT id FROM actor_memories WHERE user_id = ? ORDER BY id DESC LIMIT ?)
	`
		)
		.run(userId, userId, MAX_NOTES_PER_USER);
	return Number(result.lastInsertRowid);
}

/**
 * Delete one of a user's notes. Returns the deleted note text, or null when
 * the user has no note with that id.
 *
 * @returns {string|null}
 */
function removeNote(userId, noteId) {
	const row = db().prepare('SELECT note FROM actor_memories WHERE id = ? AND user_id = ?').get(noteId, userId);
	if (!row) {
		return null;
	}
	db().prepare('DELETE FROM actor_memories WHERE id = ?').run(noteId);
	return row.note;
}

/**
 * Delete the notes learned from a message, after that message was deleted.
 *
 * @returns {number} number of notes removed
 */
function removeNotesFromMessage(sourceMessageId) {
	return db().prepare('DELETE FROM actor_memories WHERE source_message_id = ?').run(sourceMessageId).changes;
}

/**
 * Forget everything about a user: notes and preferences.
 */
function clearUser(userId) {
	db().prepare('DELETE FROM actor_memories WHERE user_id = ?').run(userId);
	db().prepare('DELETE FROM actor_profiles WHERE user_id = ?').run(userId);
}

/**
 * Language and notes for several users at once.
 *
 * @param {string[]} userIds
 * @returns {Map<string, { language: string|null, notes: Array<{ id: number, note: string }> }>}
 */
function getProfiles(userIds) {
	const out = new Map(userIds.map(id => [id, { language: null, notes: [] }]));
	if (userIds.length === 0) {
		return out;
	}
	const placeholders = userIds.map(() => '?').join(', ');
	for (const row of db()
		.prepare(`SELECT user_id, language FROM actor_profiles WHERE user_id IN (${placeholders})`)
		.all(...userIds)) {
		out.get(row.user_id).language = row.language;
	}
	for (const row of db()
		.prepare(`SELECT id, user_id, note FROM actor_memories WHERE user_id IN (${placeholders}) ORDER BY id`)
		.all(...userIds)) {
		out.get(row.user_id).notes.push({ id: row.id, note: row.note });
	}
	return out;
}

module.exports = {
	MAX_NOTES_PER_USER,
	getLanguage,
	setLanguage,
	listNotes,
	addNote,
	removeNote,
	removeNotesFromMessage,
	clearUser,
	getProfiles
};
