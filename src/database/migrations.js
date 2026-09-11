/**
 * Database migration system for CTFBot
 * @module migrations
 */

const fs = require('fs');
const path = require('path');
const { getConnection } = require('./connection');
const { logger } = require('../lib/logger');
const migrationLogger = logger.child('Migration');

/** Matches a single `ALTER TABLE <table> ADD COLUMN <column>` statement. */
const ALTER_ADD_COLUMN = /^ALTER\s+TABLE\s+["`[]?(\w+)["`\]]?\s+ADD\s+COLUMN\s+["`[]?(\w+)["`\]]?/i;

/**
 * Split a migration file into individual SQL statements. Strips `--` line
 * comments and `/* *\/` block comments, and keeps semicolons inside
 * single-quoted string literals from being treated as separators (including
 * the SQLite escaped-quote form `''`).
 *
 * @param {string} sql - Raw migration file contents
 * @returns {string[]} Statements, trimmed, without the trailing semicolon
 */
function splitSqlStatements(sql) {
	const statements = [];
	let current = '';
	let inSingleQuote = false;
	let inLineComment = false;
	let inBlockComment = false;

	for (let i = 0; i < sql.length; i++) {
		const char = sql[i];
		const next = sql[i + 1];

		if (inLineComment) {
			if (char === '\n') {
				inLineComment = false;
			}
			continue;
		}

		if (inBlockComment) {
			if (char === '*' && next === '/') {
				inBlockComment = false;
				i++;
			}
			continue;
		}

		if (inSingleQuote) {
			current += char;
			// `''` is an escaped quote, not the end of the literal
			if (char === "'" && next === "'") {
				current += next;
				i++;
				continue;
			}
			if (char === "'") {
				inSingleQuote = false;
			}
			continue;
		}

		if (char === '-' && next === '-') {
			inLineComment = true;
			i++;
			continue;
		}
		if (char === '/' && next === '*') {
			inBlockComment = true;
			i++;
			continue;
		}
		if (char === "'") {
			inSingleQuote = true;
			current += char;
			continue;
		}
		if (char === ';') {
			if (current.trim()) {
				statements.push(current.trim());
			}
			current = '';
			continue;
		}

		current += char;
	}

	if (current.trim()) {
		statements.push(current.trim());
	}

	return statements;
}

/** True when `table` already has a column named `column` (case-insensitive). */
function columnExists(db, table, column) {
	return db
		.prepare(`PRAGMA table_info(${table})`)
		.all()
		.some(info => info.name.toLowerCase() === column.toLowerCase());
}

/** True when a table (or view) named `table` exists. */
function tableExists(db, table) {
	return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

/**
 * Re-apply a migration that failed with `duplicate column name` by skipping the
 * `ALTER TABLE ... ADD COLUMN` statements whose column already exists and running
 * everything else. This lets a single already-present column stop aborting the
 * rest of the migration chain (and the columns the migration was supposed to add).
 *
 * @param {object} db - better-sqlite3 database handle
 * @param {string} sql - Raw migration SQL that failed
 * @returns {{ok: boolean, reason: string}}
 */
function recoverDuplicatedColumns(db, sql) {
	const statements = splitSqlStatements(sql);
	// Match against comment-stripped SQL so a table/column name mentioned in a
	// `--` comment cannot be mistaken for a declaration.
	const cleaned = statements.join(';\n');
	const alterColumns = [...cleaned.matchAll(/ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)/gi)];

	// Only column-add migrations are safe to replay: a partially applied
	// INSERT/SELECT migration could duplicate rows, so refuse to guess there.
	if (alterColumns.length === 0) {
		return { ok: false, reason: 'no ALTER TABLE ADD COLUMN statements to recover' };
	}

	const createTables = [...cleaned.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/gi)];

	try {
		db.transaction(() => {
			for (const statement of statements) {
				const match = statement.match(ALTER_ADD_COLUMN);
				if (match && columnExists(db, match[1], match[2])) {
					continue;
				}
				db.exec(statement);
			}

			const missing = [
				...alterColumns
					.filter(([, table, column]) => !columnExists(db, table, column))
					.map(([, table, column]) => `${table}.${column}`),
				...createTables.filter(([, table]) => !tableExists(db, table)).map(([, table]) => table)
			];

			if (missing.length > 0) {
				throw new Error(`recovery left schema incomplete: ${missing.join(', ')}`);
			}
		})();

		return { ok: true, reason: 'already-present columns skipped, remaining schema applied' };
	} catch (recoveryError) {
		return { ok: false, reason: recoveryError.message };
	}
}

/**
 * Run all pending migrations
 *
 * @param {Database.Database} db - Database instance
 * @param {string} [migrationsDir] - Directory containing migration files
 * @returns {Object} Migration results
 */
// eslint-disable-next-line no-unused-vars
function runMigrations(db = getConnection(), migrationsDir = path.join(process.cwd(), 'migrations')) {
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

	const migrationFiles = fs
		.readdirSync(migrationsDir)
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
			migrationLogger.info(`Applied migration: ${name}`);
		} catch (error) {
			// Recover from inline-schema duplicates. On a drifted database a
			// migration can fail on a column that already exists while other
			// columns it declares are still missing (e.g. migration 005 when
			// team_name exists but team_mode does not). Re-run the migration
			// with the already-present ALTER statements filtered out so the
			// remaining columns are still added and the chain never aborts.
			if (error.message && error.message.includes('duplicate column name')) {
				const migrationSql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
				const recovery = recoverDuplicatedColumns(db, migrationSql);
				if (recovery.ok) {
					migrationLogger.warn(`Migration ${name}: ${recovery.reason}`);
					db.prepare('INSERT OR IGNORE INTO migrations (name) VALUES (?)').run(name);
					applied.push(name);
					continue;
				}
				migrationLogger.error(`Migration ${name}: recovery failed (${recovery.reason})`);
				return { applied, skipped, error: recovery.reason };
			}
			migrationLogger.error(`Failed to apply migration ${name}`, error);
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
function createMigration(name, migrationsDir = path.join(process.cwd(), 'migrations')) {
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
	// Note: the migration runner automatically inserts the migration name into
	// the migrations table after execution. Do NOT add another INSERT here.
	const template = `-- Migration: ${paddedNumber}_${name}
-- Description: [Add description here]
-- Date: ${new Date().toISOString().split('T')[0]}

-- Add your SQL statements here
`;

	fs.writeFileSync(filepath, template);
	migrationLogger.info(`Created migration: ${filename}`);
	return filepath;
}

/**
 * List all migrations and their status
 *
 * @param {Database.Database} db - Database instance
 * @param {string} [migrationsDir] - Directory containing migration files
 * @returns {Object[]} List of migrations with status
 */
function listMigrations(db, migrationsDir = path.join(process.cwd(), 'migrations')) {
	// Get applied migrations
	const appliedMigrations = db.prepare('SELECT name, applied_at FROM migrations').all();
	const appliedMap = new Map(appliedMigrations.map(m => [m.name, m.applied_at]));

	// Get all migration files
	if (!fs.existsSync(migrationsDir)) {
		return [];
	}

	const migrationFiles = fs
		.readdirSync(migrationsDir)
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
