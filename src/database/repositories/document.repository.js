/**
 * Document repository — database operations for anchored documents
 * Supports both plain-text and binary file documents.
 * @module database/repositories/document
 */

const { getConnection } = require('../connection');

const db = () => getConnection();

/**
 * Insert a new anchored document.
 *
 * For text documents use: title, content, mimeType='text/plain'
 * For file documents use: title, fileData (Buffer), filename, fileSize, mimeType
 *
 * @param {object} params
 * @param {string} params.docId - Unique document UUID
 * @param {string} params.title - Document title
 * @param {string} [params.content] - Plain text content (for text-only docs)
 * @param {string} params.author - Discord user ID
 * @param {string} [params.mimeType='text/plain'] - MIME type
 * @param {number} params.blockHeight - Luce blockchain block height
 * @param {Buffer} [params.fileData] - Raw file binary (for file docs)
 * @param {string} [params.filename] - Original filename (for file docs)
 * @param {number} [params.fileSize] - File size in bytes (for file docs)
 */
function createDocument({ docId, title, content, author, mimeType, blockHeight, fileData, filename, fileSize }) {
	const now = Math.floor(Date.now() / 1000);
	db().prepare(`
		INSERT INTO documents (doc_id, title, content, author, mime_type, block_height, created_at, file_data, filename, file_size)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		docId,
		title,
		fileData ? (content || '') : (content || null),
		author,
		mimeType || 'text/plain',
		blockHeight,
		now,
		fileData || null,
		filename || null,
		fileSize || null
	);
}

/**
 * Get a document by its ID.
 * Returns the full row including file_data (Buffer) if present.
 *
 * @param {string} docId
 * @returns {object|undefined}
 */
function getDocument(docId) {
	return db().prepare('SELECT * FROM documents WHERE doc_id = ?').get(docId);
}

/**
 * List all documents ordered by created_at descending.
 *
 * @param {number} [limit=20]
 * @returns {object[]}
 */
function listDocuments(limit = 20) {
	return db().prepare('SELECT * FROM documents ORDER BY created_at DESC LIMIT ?').all(limit);
}

module.exports = {
	createDocument,
	getDocument,
	listDocuments
};
