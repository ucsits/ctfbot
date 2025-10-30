/**
 * Database operations for CTFBot
 * Uses SQLite with better-sqlite3 for persistent storage
 * @module database
 */

const Database = require('better-sqlite3');
const path = require('path');
const { runMigrations } = require('./lib/migrations');

// Initialize database
const db = new Database(path.join(__dirname, '..', 'ctfbot.db'));

// Enable foreign keys
db.pragma('foreign_keys = ON');

/**
 * Initialize database schema
 * Creates tables if they don't exist
 * 
 * @returns {void}
 */
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
			api_token TEXT,
			archived INTEGER DEFAULT 0,
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

	// Run migrations to apply any schema updates
	const migrationsDir = path.join(__dirname, '..', 'migrations');
	const result = runMigrations(db, migrationsDir);
	
	if (result.error) {
		console.error('❌ Migration error:', result.error);
	} else if (result.applied.length > 0) {
		console.log(`✅ Applied ${result.applied.length} migration(s): ${result.applied.join(', ')}`);
	} else {
		console.log('✅ All migrations up to date');
	}
}

/**
 * CTF database operations
 * @namespace ctfOperations
 */
const ctfOperations = {
	/**
	 * Create a new CTF entry
	 * 
	 * @param {Object} data - CTF data
	 * @param {string} data.guild_id - Discord guild ID
	 * @param {string} data.channel_id - Discord channel ID
	 * @param {string} data.event_id - Discord event ID
	 * @param {string} data.ctf_name - Name of the CTF
	 * @param {string} data.ctf_base_url - Base URL of the CTF
	 * @param {string} data.ctf_date - ISO string of CTF date
	 * @param {string} [data.description] - CTF description
	 * @param {string} [data.banner_url] - Banner image URL
	 * @param {string} [data.api_token] - CTFd API token
	 * @param {string} data.created_by - User ID of creator
	 * @returns {number} The ID of the created CTF
	 */
	createCTF: (data) => {
		const stmt = db.prepare(`
			INSERT INTO ctfs (guild_id, channel_id, event_id, ctf_name, ctf_base_url, ctf_date, description, banner_url, api_token, created_by)
			VALUES (@guild_id, @channel_id, @event_id, @ctf_name, @ctf_base_url, @ctf_date, @description, @banner_url, @api_token, @created_by)
		`);
		const result = stmt.run(data);
		return result.lastInsertRowid;
	},

	/**
	 * Get CTF by channel ID
	 * 
	 * @param {string} channelId - Discord channel ID
	 * @returns {Object|undefined} CTF data or undefined if not found
	 */
	getCTFByChannelId: (channelId) => {
		const stmt = db.prepare('SELECT * FROM ctfs WHERE channel_id = ?');
		return stmt.get(channelId);
	},

	/**
	 * Get CTF by ID
	 * 
	 * @param {number} id - CTF ID
	 * @returns {Object|undefined} CTF data or undefined if not found
	 */
	getCTFById: (id) => {
		const stmt = db.prepare('SELECT * FROM ctfs WHERE id = ?');
		return stmt.get(id);
	},

	/**
	 * Get all CTFs for a guild
	 * 
	 * @param {string} guildId - Discord guild ID
	 * @returns {Object[]} Array of CTF data
	 */
	getCTFsByGuild: (guildId) => {
		const stmt = db.prepare('SELECT * FROM ctfs WHERE guild_id = ? ORDER BY ctf_date DESC');
		return stmt.all(guildId);
	},

	/**
	 * Delete a CTF
	 * 
	 * @param {number} id - CTF ID
	 * @returns {Object} Delete operation result
	 */
	deleteCTF: (id) => {
		const stmt = db.prepare('DELETE FROM ctfs WHERE id = ?');
		return stmt.run(id);
	},

	/**
	 * Archive a CTF
	 * 
	 * @param {string} channelId - Discord channel ID
	 * @returns {Object} Update operation result
	 */
	archiveCTF: (channelId) => {
		const stmt = db.prepare('UPDATE ctfs SET archived = 1 WHERE channel_id = ?');
		return stmt.run(channelId);
	},

	/**
	 * Unarchive a CTF
	 * 
	 * @param {string} channelId - Discord channel ID
	 * @returns {Object} Update operation result
	 */
	unarchiveCTF: (channelId) => {
		const stmt = db.prepare('UPDATE ctfs SET archived = 0 WHERE channel_id = ?');
		return stmt.run(channelId);
	}
};

/**
 * CTF registration database operations
 * @namespace registrationOperations
 */
const registrationOperations = {
	/**
	 * Register a user for a CTF (UPSERT operation)
	 * 
	 * @param {Object} data - Registration data
	 * @param {number} data.ctf_id - CTF ID
	 * @param {string} data.user_id - Discord user ID
	 * @param {string} data.username - Username on CTF platform
	 * @param {string} [data.ctfd_user_id] - CTFd user ID
	 * @param {string} [data.ctfd_team_name] - CTFd team name
	 * @returns {Object} Insert/update operation result
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
	 * 
	 * @param {number} ctfId - CTF ID
	 * @returns {Object[]} Array of registration data
	 */
	getRegistrationsByCTF: (ctfId) => {
		const stmt = db.prepare('SELECT * FROM ctf_registrations WHERE ctf_id = ? ORDER BY registered_at ASC');
		return stmt.all(ctfId);
	},

	/**
	 * Get user registration for a specific CTF
	 * 
	 * @param {number} ctfId - CTF ID
	 * @param {string} userId - Discord user ID
	 * @returns {Object|undefined} Registration data or undefined if not found
	 */
	getUserRegistration: (ctfId, userId) => {
		const stmt = db.prepare('SELECT * FROM ctf_registrations WHERE ctf_id = ? AND user_id = ?');
		return stmt.get(ctfId, userId);
	},

	/**
	 * Delete a registration
	 * 
	 * @param {number} ctfId - CTF ID
	 * @param {string} userId - Discord user ID
	 * @returns {Object} Delete operation result
	 */
	deleteRegistration: (ctfId, userId) => {
		const stmt = db.prepare('DELETE FROM ctf_registrations WHERE ctf_id = ? AND user_id = ?');
		return stmt.run(ctfId, userId);
	}
};

/**
 * CTF challenges database operations
 * @namespace challengeOperations
 */
const challengeOperations = {
	/**
	 * Add a challenge to a CTF
	 * 
	 * @param {Object} data - Challenge data
	 * @param {number} data.ctf_id - CTF ID
	 * @param {string} data.chal_name - Challenge name
	 * @param {string} data.chal_category - Challenge category
	 * @param {string} data.created_by - User ID of creator
	 * @returns {number} The ID of the created challenge
	 */
	addChallenge: (data) => {
		const stmt = db.prepare(`
			INSERT INTO ctf_challenges (ctf_id, chal_name, chal_category, created_by)
			VALUES (@ctf_id, @chal_name, @chal_category, @created_by)
		`);
		const result = stmt.run(data);
		return result.lastInsertRowid;
	},

	/**
	 * Get all challenges for a CTF
	 * 
	 * @param {number} ctfId - CTF ID
	 * @returns {Object[]} Array of challenge data
	 */
	getChallengesByCTF: (ctfId) => {
		const stmt = db.prepare('SELECT * FROM ctf_challenges WHERE ctf_id = ? ORDER BY chal_category, chal_name');
		return stmt.all(ctfId);
	},

	/**
	 * Mark a challenge as solved
	 * 
	 * @param {number} challengeId - Challenge ID
	 * @param {string} userId - Discord user ID who solved it
	 * @returns {Object} Update operation result
	 */
	markChallengeSolved: (challengeId, userId) => {
		const stmt = db.prepare(`
			UPDATE ctf_challenges 
			SET solved = 1, solved_by = ?, solved_at = CURRENT_TIMESTAMP 
			WHERE id = ?
		`);
		return stmt.run(userId, challengeId);
	},

	/**
	 * Delete a challenge
	 * 
	 * @param {number} challengeId - Challenge ID
	 * @returns {Object} Delete operation result
	 */
	deleteChallenge: (challengeId) => {
		const stmt = db.prepare('DELETE FROM ctf_challenges WHERE id = ?');
		return stmt.run(challengeId);
	}
};

module.exports = {
	db,
	initDatabase,
	ctfOperations,
	registrationOperations,
	challengeOperations
};
