const { getConnection } = require('./connection');
const { runMigrations } = require('./migrations');
const ctfOperations = require('./repositories/ctf.repository');
const registrationOperations = require('./repositories/registration.repository');
const challengeOperations = require('./repositories/challenge.repository');
const pactOperations = require('./repositories/pact.repository');

function initDatabase() {
	const db = getConnection();

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
			team_mode INTEGER DEFAULT 0,
			archived INTEGER DEFAULT 0,
			created_at TEXT DEFAULT CURRENT_TIMESTAMP,
			created_by TEXT NOT NULL
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS ctf_registrations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			ctf_id INTEGER NOT NULL,
			user_id TEXT NOT NULL,
			username TEXT NOT NULL,
			team_name TEXT,
			ctfd_user_id TEXT,
			ctfd_team_name TEXT,
			registered_at TEXT DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (ctf_id) REFERENCES ctfs(id) ON DELETE CASCADE,
			UNIQUE(ctf_id, user_id)
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS ctf_challenges (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			ctf_id INTEGER NOT NULL,
			chal_name TEXT NOT NULL,
			chal_category TEXT,
			points INTEGER,
			created_by TEXT,
			FOREIGN KEY (ctf_id) REFERENCES ctfs(id) ON DELETE CASCADE,
			UNIQUE(ctf_id, chal_name)
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS ctf_challenge_solves (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			challenge_id INTEGER NOT NULL,
			user_id TEXT NOT NULL,
			solved_at TEXT DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (challenge_id) REFERENCES ctf_challenges(id) ON DELETE CASCADE
		)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS pacts (
			user_id TEXT PRIMARY KEY,
			name TEXT,
			nrp TEXT
		)
	`);

	console.log('Database initialized successfully');

	const migrationsDir = require('path').join(process.cwd(), 'migrations');
	const result = runMigrations(db, migrationsDir);

	if (result.error) {
		console.error('❌ Migration error:', result.error);
	} else if (result.applied.length > 0) {
		console.log(`✅ Applied ${result.applied.length} migration(s): ${result.applied.join(', ')}`);
	} else {
		console.log('✅ All migrations up to date');
	}
}

module.exports = {
	db: getConnection,
	initDatabase,
	ctfOperations,
	registrationOperations,
	challengeOperations,
	pactOperations
};
