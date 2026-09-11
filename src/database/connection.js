const Database = require('better-sqlite3');
const path = require('path');

let dbInstance = null;

function getConnection() {
	if (!dbInstance) {
		const dbPath = path.join(process.cwd(), 'ctfbot.db');
		dbInstance = new Database(dbPath);

		dbInstance.pragma('foreign_keys = ON');
	}

	return dbInstance;
}

function closeConnection() {
	if (dbInstance) {
		dbInstance.close();
		dbInstance = null;
	}
}

/**
 * Run `fn` inside a single database transaction, returning its result.
 *
 * A throw inside `fn` rolls the whole transaction back. Nested calls are
 * supported: better-sqlite3 promotes them to savepoints, so a repository
 * function that already wraps itself in a transaction can safely be called
 * from another transaction scope.
 *
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function runInTransaction(fn) {
	return getConnection().transaction(fn)();
}

module.exports = {
	getConnection,
	closeConnection,
	runInTransaction
};
