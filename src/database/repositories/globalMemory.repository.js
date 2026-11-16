/**
 * Global memory repository for what the bot knows about the whole server.
 *
 * This is the third memory layer, next to `actor_memories` (per person) and
 * `channel_memory` (per channel). A global note applies everywhere, which is
 * what lets a member tune the bot's personality or add a house rule such as
 * "kalau ditegur, minta maaf dulu".
 *
 * Notes are advisory. The chat prompt wraps them with the rule that they may
 * never override the safety rules or the silence rules, so a note can shape the
 * tone but cannot make the bot insult people or talk nonstop.
 *
 * @module database/repositories/globalMemory
 */

const { getConnection } = require('../connection');

const db = () => getConnection();

const nowSeconds = () => Math.floor(Date.now() / 1000);

// The prompt stays small. Older notes are dropped past this.
const MAX_NOTES = 60;
const MAX_NOTE_CHARS = 300;
// One member cannot rewrite the whole personality in an afternoon.
const MAX_NOTES_PER_USER_PER_DAY = 5;

const KINDS = new Set(['personality', 'rule', 'correction', 'fact']);

// A note is shown back to the model as context. Anything that reads like a
// credential, a command or a link is refused at the door, because the model
// would otherwise treat it as something to obey or repeat.
const REJECTIONS = [
	{ pattern: /https?:\/\//i, reason: 'a link' },
	{ pattern: /<@[!&]?\d+>|@everyone|@here/i, reason: 'a mention' },
	{ pattern: /```|`[^`]+`/, reason: 'code' },
	{ pattern: /\b(sk|pk|ghp|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/, reason: 'something that looks like a token' },
	{ pattern: /\b(password|passwd|token|api[_ -]?key|secret)\b\s*[:=]/i, reason: 'a credential' },
	{
		pattern: /\b(ignore|abaikan|luputkan)\b.{0,40}\b(instruction|instruksi|aturan|prompt|system)\b/i,
		reason: 'a prompt injection'
	}
];

/**
 * Normalise and vet a note before it is stored.
 *
 * @param {string} note
 * @returns {{ ok: true, note: string }|{ ok: false, reason: string }}
 */
function prepare(note) {
	const text = String(note ?? '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, MAX_NOTE_CHARS);
	if (!text) {
		return { ok: false, reason: 'the note was empty' };
	}
	for (const { pattern, reason } of REJECTIONS) {
		if (pattern.test(text)) {
			return { ok: false, reason: `a note cannot contain ${reason}` };
		}
	}
	return { ok: true, note: text };
}

/**
 * Global notes, oldest first.
 *
 * @param {number} [limit]
 * @returns {Array<{ id: number, note: string, kind: string, added_by: string|null, created_at: number }>}
 */
function listNotes(limit = MAX_NOTES) {
	return db()
		.prepare(
			'SELECT id, note, kind, added_by, created_at FROM global_memory ORDER BY created_at DESC, id DESC LIMIT ?'
		)
		.all(limit)
		.reverse();
}

/**
 * One note by id, or null.
 *
 * @param {number} id
 * @returns {{ id: number, note: string, kind: string, added_by: string|null }|null}
 */
function getNote(id) {
	return db().prepare('SELECT id, note, kind, added_by FROM global_memory WHERE id = ?').get(id) ?? null;
}

/**
 * How many notes a member added since a unix second. Used to rate limit.
 *
 * @param {string} userId
 * @param {number} since
 * @returns {number}
 */
function countByUserSince(userId, since) {
	return db()
		.prepare('SELECT COUNT(*) AS n FROM global_memory WHERE added_by = ? AND created_at >= ?')
		.get(userId, since).n;
}

/**
 * Store a global note. Returns the new id, or a reason it was not stored.
 *
 * @param {string} note
 * @param {{ kind?: string, addedBy?: string|null, sourceMessageId?: string|null, max?: number }} [options]
 * @returns {{ id: number|null, reason?: string }}
 */
function addNote(note, { kind = 'personality', addedBy = null, sourceMessageId = null, max = MAX_NOTES } = {}) {
	const prepared = prepare(note);
	if (!prepared.ok) {
		return { id: null, reason: prepared.reason };
	}

	if (db().prepare('SELECT COUNT(*) AS n FROM global_memory').get().n >= max) {
		return { id: null, reason: `global memory is full (${max} notes)` };
	}

	const resolvedKind = KINDS.has(kind) ? kind : 'personality';
	const result = db()
		.prepare(
			`
		INSERT OR IGNORE INTO global_memory (note, kind, added_by, source_message_id, created_at)
		VALUES (?, ?, ?, ?, ?)
	`
		)
		.run(prepared.note, resolvedKind, addedBy, sourceMessageId, nowSeconds());
	if (result.changes === 0) {
		return { id: null, reason: 'already remembered' };
	}
	return { id: Number(result.lastInsertRowid) };
}

/**
 * Delete one global note.
 *
 * @param {number} id
 * @returns {string|null} the deleted note text, or null when there is no such note
 */
function removeNote(id) {
	const row = db().prepare('SELECT note FROM global_memory WHERE id = ?').get(id);
	if (!row) {
		return null;
	}
	db().prepare('DELETE FROM global_memory WHERE id = ?').run(id);
	return row.note;
}

/** Drop every global note. */
function clear() {
	db().prepare('DELETE FROM global_memory').run();
}

/** Test helper. Forget every global note. */
function _reset() {
	clear();
}

module.exports = {
	MAX_NOTES,
	MAX_NOTE_CHARS,
	MAX_NOTES_PER_USER_PER_DAY,
	KINDS,
	prepare,
	listNotes,
	getNote,
	countByUserSince,
	addNote,
	removeNote,
	clear,
	_reset
};
