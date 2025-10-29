const Database = require('better-sqlite3');
const path = require('path');

// Initialize database
const db = new Database(path.join(__dirname, '..', 'ctfbot.db'));

// Enable foreign keys
db.pragma('foreign_keys = ON');

// Initialize database schema
function initDatabase() {
	// Create CTFs table
	db.exec(`
		CREATE TABLE IF NOT EXISTS ctfs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			guild_id TEXT NOT NULL,
			channel_id TEXT NOT NULL UNIQUE,
			event_id TEXT,
			ctf_name TEXT NOT NULL,
			ctf_base_url TEXT NOT NULL,
			ctf_date TEXT NOT NULL,
			description TEXT,
			banner_url TEXT,
			created_at TEXT DEFAULT CURRENT_TIMESTAMP,
			created_by TEXT NOT NULL
		)
	`);

	// Create CTF registrations table
	db.exec(`
		CREATE TABLE IF NOT EXISTS ctf_registrations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			ctf_id INTEGER NOT NULL,
			user_id TEXT NOT NULL,
			username TEXT NOT NULL,
			ctfd_user_id TEXT,
			ctfd_team_name TEXT,
			registered_at TEXT DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (ctf_id) REFERENCES ctfs(id) ON DELETE CASCADE,
			UNIQUE(ctf_id, user_id)
		)
	`);

	console.log('Database initialized successfully');
}

// CTF Operations
const ctfOperations = {
	/**
	 * Create a new CTF entry
	 */
	createCTF: (data) => {
		const stmt = db.prepare(`
			INSERT INTO ctfs (guild_id, channel_id, event_id, ctf_name, ctf_base_url, ctf_date, description, banner_url, created_by)
			VALUES (@guild_id, @channel_id, @event_id, @ctf_name, @ctf_base_url, @ctf_date, @description, @banner_url, @created_by)
		`);
		const result = stmt.run(data);
		return result.lastInsertRowid;
	},

	/**
	 * Get CTF by channel ID
	 */
	getCTFByChannelId: (channelId) => {
		const stmt = db.prepare('SELECT * FROM ctfs WHERE channel_id = ?');
		return stmt.get(channelId);
	},

	/**
	 * Get CTF by ID
	 */
	getCTFById: (id) => {
		const stmt = db.prepare('SELECT * FROM ctfs WHERE id = ?');
		return stmt.get(id);
	},

	/**
	 * Get all CTFs for a guild
	 */
	getCTFsByGuild: (guildId) => {
		const stmt = db.prepare('SELECT * FROM ctfs WHERE guild_id = ? ORDER BY ctf_date DESC');
		return stmt.all(guildId);
	},

	/**
	 * Delete a CTF
	 */
	deleteCTF: (id) => {
		const stmt = db.prepare('DELETE FROM ctfs WHERE id = ?');
		return stmt.run(id);
	}
};

// Registration Operations
const registrationOperations = {
	/**
	 * Register a user for a CTF
	 */
	registerUser: (data) => {
		const stmt = db.prepare(`
			INSERT INTO ctf_registrations (ctf_id, user_id, username, ctfd_user_id, ctfd_team_name)
			VALUES (@ctf_id, @user_id, @username, @ctfd_user_id, @ctfd_team_name)
			ON CONFLICT(ctf_id, user_id) DO UPDATE SET
				username = @username,
				ctfd_user_id = @ctfd_user_id,
				ctfd_team_name = @ctfd_team_name
		`);
		return stmt.run(data);
	},

	/**
	 * Get all registrations for a CTF
	 */
	getRegistrationsByCTF: (ctfId) => {
		const stmt = db.prepare('SELECT * FROM ctf_registrations WHERE ctf_id = ? ORDER BY registered_at ASC');
		return stmt.all(ctfId);
	},

	/**
	 * Get user registration for a specific CTF
	 */
	getUserRegistration: (ctfId, userId) => {
		const stmt = db.prepare('SELECT * FROM ctf_registrations WHERE ctf_id = ? AND user_id = ?');
		return stmt.get(ctfId, userId);
	},

	/**
	 * Delete a registration
	 */
	deleteRegistration: (ctfId, userId) => {
		const stmt = db.prepare('DELETE FROM ctf_registrations WHERE ctf_id = ? AND user_id = ?');
		return stmt.run(ctfId, userId);
	}
};

module.exports = {
	db,
	initDatabase,
	ctfOperations,
	registrationOperations
};
