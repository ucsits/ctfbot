/**
 * Document repository — database operations for anchored documents
 * @module database/repositories/document
 */

const { getConnection } = require('../connection');

const db = () => getConnection();

/**
 * Insert a new anchored document.
 */
function createDocument({ docId, title, content, author, mimeType, blockHeight }) {
	const now = Math.floor(Date.now() / 1000);
	db().prepare(`
		INSERT INTO documents (doc_id, title, content, author, mime_type, block_height, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`).run(docId, title, content, author, mimeType || 'text/plain', blockHeight, now);
}

/**
 * Get a document by its ID.
 */
function getDocument(docId) {
	return db().prepare('SELECT * FROM documents WHERE doc_id = ?').get(docId);
}

/**
 * List all documents ordered by created_at descending.
 */
function listDocuments(limit = 20) {
	return db().prepare('SELECT * FROM documents ORDER BY created_at DESC LIMIT ?').all(limit);
}

module.exports = {
	createDocument,
	getDocument,
	listDocuments
};
