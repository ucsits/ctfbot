const { getConnection } = require('./connection');
const { runMigrations } = require('./migrations');
const { logger } = require('../lib/logger');
const dbLogger = logger.child('DB');
const ctfOperations = require('./repositories/ctf.repository');
const registrationOperations = require('./repositories/registration.repository');
const challengeOperations = require('./repositories/challenge.repository');
const pactOperations = require('./repositories/pact.repository');
const adminRepository = require('./repositories/admin.repository');
const taskRepository = require('./repositories/task.repository');
const reputationRepository = require('./repositories/reputation.repository');
const documentRepository = require('./repositories/document.repository');
const activityRepository = require('./repositories/activity.repository');
const calendarRepository = require('./repositories/calendar.repository');

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
			platform TEXT DEFAULT 'ctfd',
			api_base_url TEXT,
			platform_division_id INTEGER,
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
			FOREIGN KEY (challenge_id) REFERENCES ctf_challenges(id) ON DELETE CASCADE,
			UNIQUE(challenge_id, user_id)
		)
	`);

	db.exec('CREATE INDEX IF NOT EXISTS idx_challenge_solves_challenge_id ON ctf_challenge_solves(challenge_id)');
	db.exec('CREATE INDEX IF NOT EXISTS idx_challenge_solves_user_id ON ctf_challenge_solves(user_id)');

	db.exec(`
		CREATE TABLE IF NOT EXISTS pacts (
			user_id TEXT PRIMARY KEY,
			name TEXT,
			nrp TEXT
		)
	`);

	dbLogger.info('Database initialized successfully');

	const migrationsDir = require('path').join(process.cwd(), 'migrations');
	const result = runMigrations(getConnection(), migrationsDir);

	if (result.error) {
		dbLogger.error('Migration error', result.error);
	} else if (result.applied.length > 0) {
		dbLogger.info(`Applied ${result.applied.length} migration(s): ${result.applied.join(', ')}`);
	} else {
		dbLogger.info('All migrations up to date');
	}

	// Crash recovery, run after migrations so the purchases table exists. An AP
	// purchase reservation is written before its block is anchored, so if the
	// process died in between the points are still debited and the purchase is
	// still pending. Release any reservation old enough that no in-flight
	// request could still own it.
	const releasedReservations = activityRepository.releaseStaleApReservations();
	if (releasedReservations > 0) {
		dbLogger.warn(`Released ${releasedReservations} stale AP purchase reservation(s) on startup`);
	}
}

module.exports = {
	db: getConnection,
	initDatabase,
	ctfOperations,
	registrationOperations,
	challengeOperations,
	pactOperations,
	adminRepository,
	taskRepository,
	reputationRepository,
	documentRepository,
	activityRepository,
	calendarRepository
};
