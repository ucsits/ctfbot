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

module.exports = {
	getConnection,
	closeConnection
};
