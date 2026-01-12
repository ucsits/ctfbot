/**
 * Database migration system for CTFBot
 * @module migrations
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

/**
 * Run all pending migrations
 *
 * @param {Database.Database} db - Database instance
 * @param {string} [migrationsDir] - Directory containing migration files
 * @returns {Object} Migration results
 */
function runMigrations(db, migrationsDir = path.join(__dirname, '../migrations')) {
	// Ensure migrations table exists
	db.exec(`
		CREATE TABLE IF NOT EXISTS migrations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL UNIQUE,
			applied_at TEXT DEFAULT CURRENT_TIMESTAMP
		)
	`);

	// Get applied migrations
	const appliedMigrations = db.prepare('SELECT name FROM migrations').all();
	const appliedNames = new Set(appliedMigrations.map(m => m.name));

	// Get migration files
	if (!fs.existsSync(migrationsDir)) {
		return { applied: [], skipped: [], error: null };
	}

	const migrationFiles = fs.readdirSync(migrationsDir)
		.filter(f => f.endsWith('.sql'))
		.sort();

	const applied = [];
	const skipped = [];

	// Run each migration
	for (const file of migrationFiles) {
		const name = path.basename(file, '.sql');

		if (appliedNames.has(name)) {
			skipped.push(name);
			continue;
		}

		try {
			const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

			// Execute in a transaction
			db.transaction(() => {
				db.exec(sql);
				db.prepare('INSERT INTO migrations (name) VALUES (?)').run(name);
			})();

			applied.push(name);
			console.log(`✅ Applied migration: ${name}`);
		} catch (error) {
			console.error(`❌ Failed to apply migration ${name}:`, error);
			return { applied, skipped, error: error.message };
		}
	}

	return { applied, skipped, error: null };
}

/**
 * Create a new migration file
 *
 * @param {string} name - Migration name (e.g., 'add_user_preferences')
 * @param {string} [migrationsDir] - Directory to create migration in
 * @returns {string} Path to created migration file
 */
function createMigration(name, migrationsDir = path.join(__dirname, '../migrations')) {
	// Ensure migrations directory exists
	if (!fs.existsSync(migrationsDir)) {
		fs.mkdirSync(migrationsDir, { recursive: true });
	}

	// Get next migration number
	const existingMigrations = fs.existsSync(migrationsDir)
		? fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql'))
		: [];

	const nextNumber = existingMigrations.length + 1;
	const paddedNumber = String(nextNumber).padStart(3, '0');
	const filename = `${paddedNumber}_${name}.sql`;
	const filepath = path.join(migrationsDir, filename);

	// Create template
	const template = `-- Migration: ${paddedNumber}_${name}
-- Description: [Add description here]
-- Date: ${new Date().toISOString().split('T')[0]}

-- Add your SQL statements here

-- Record this migration
INSERT OR IGNORE INTO migrations (name) VALUES ('${paddedNumber}_${name}');
`;

	fs.writeFileSync(filepath, template);
	console.log(`✅ Created migration: ${filename}`);
	return filepath;
}

/**
 * List all migrations and their status
 *
 * @param {Database.Database} db - Database instance
 * @param {string} [migrationsDir] - Directory containing migration files
 * @returns {Object[]} List of migrations with status
 */
function listMigrations(db, migrationsDir = path.join(__dirname, '../migrations')) {
	// Get applied migrations
	const appliedMigrations = db.prepare('SELECT name, applied_at FROM migrations').all();
	const appliedMap = new Map(appliedMigrations.map(m => [m.name, m.applied_at]));

	// Get all migration files
	if (!fs.existsSync(migrationsDir)) {
		return [];
	}

	const migrationFiles = fs.readdirSync(migrationsDir)
		.filter(f => f.endsWith('.sql'))
		.sort();

	return migrationFiles.map(file => {
		const name = path.basename(file, '.sql');
		const appliedAt = appliedMap.get(name);
		return {
			name,
			file,
			applied: !!appliedAt,
			appliedAt: appliedAt || null
		};
	});
}

module.exports = {
	runMigrations,
	createMigration,
	listMigrations
};
