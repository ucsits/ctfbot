import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, cpSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';
import Database from 'better-sqlite3';

// ── Strategy ───────────────────────────────────────────────────────────
// This suite exercises the real migration runner against isolated SQLite
// databases so the createCTF regression can never silently return:
//
//   * a "pre-CTFd" database (ctfs without api_token/team_mode/archived)
//     must come out of the migration chain with api_token present, and
//     createCTF must succeed with a non-CTFd payload.
//   * a partially drifted database (team_name already present but
//     team_mode missing) must not abort the chain; the duplicate-column
//     recovery has to add the column that is still missing.
//   * a fresh database must end up with the full inline-schema column set.
//
// getConnection() resolves cwd/ctfbot.db, so each scenario chdirs into a temp
// dir and calls closeConnection() to drop the cached handle before rebooting.
// This mirrors tests/integration/activity.repository.test.js.

const repoRoot = process.cwd();
const sourceMigrationsDir = join(repoRoot, 'migrations');

// Use a CJS require so we load the exact same module instances the src files
// load through their own `require('./connection')`. A dynamic ESM import can
// resolve to a separate instance with its own cached DB handle.
const require = createRequire(import.meta.url);

const tempDirs = [];

function makeTempDir(prefix) {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cpSync(sourceMigrationsDir, join(dir, 'migrations'), { recursive: true });
	tempDirs.push(dir);
	return dir;
}

/** Point cwd at `dir` and hand back a fresh connection to its ctfbot.db. */
function connectIn(dir) {
	process.chdir(dir);
	const { closeConnection, getConnection } = require('../../src/database/connection.js');
	closeConnection();
	return getConnection();
}

function columnsOf(db, table) {
	return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}

function migrationFileNames(dir) {
	return readdirSync(join(dir, 'migrations'))
		.filter(f => f.endsWith('.sql'))
		.map(f => f.replace(/\.sql$/, ''))
		.sort();
}

/** Every migration file name, in order, read back from the migrations table. */
function appliedMigrations(db) {
	return db.prepare('SELECT name FROM migrations ORDER BY id').all().map(r => r.name);
}

/**
 * A plausible pre-CTFd database: ctfs and ctf_registrations in their original
 * shape (no api_token, team_mode, team_name, or ctfd_* columns) plus the
 * inline-created ctf_challenges table that migration 003 indexes.
 */
function seedLegacySchema(dir) {
	const db = new Database(join(dir, 'ctfbot.db'));
	db.exec(`
		CREATE TABLE ctfs (
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
		);
		CREATE TABLE ctf_registrations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			ctf_id INTEGER NOT NULL,
			user_id TEXT NOT NULL,
			username TEXT NOT NULL,
			registered_at TEXT DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE ctf_challenges (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			ctf_id INTEGER NOT NULL,
			chal_name TEXT NOT NULL,
			chal_category TEXT,
			points INTEGER,
			created_by TEXT,
			UNIQUE(ctf_id, chal_name)
		);
		CREATE TABLE migrations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL UNIQUE,
			applied_at TEXT DEFAULT CURRENT_TIMESTAMP
		);
	`);
	db.close();
}

/**
 * A drifted database where ctf_registrations.team_name already exists but
 * ctfs.team_mode does not. Migration 005 therefore fails on the team_name
 * ALTER and, without recovery, would roll back and never add team_mode.
 */
function seedPartialDriftSchema(dir) {
	const db = new Database(join(dir, 'ctfbot.db'));
	db.exec(`
		CREATE TABLE ctfs (
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
		);
		CREATE TABLE ctf_registrations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			ctf_id INTEGER NOT NULL,
			user_id TEXT NOT NULL,
			username TEXT NOT NULL,
			team_name TEXT,
			registered_at TEXT DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE ctf_challenges (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			ctf_id INTEGER NOT NULL,
			chal_name TEXT NOT NULL,
			chal_category TEXT,
			points INTEGER,
			created_by TEXT,
			UNIQUE(ctf_id, chal_name)
		);
		CREATE TABLE migrations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL UNIQUE,
			applied_at TEXT DEFAULT CURRENT_TIMESTAMP
		);
	`);
	db.close();
}

afterAll(() => {
	const { closeConnection } = require('../../src/database/connection.js');
	closeConnection();
	process.chdir(repoRoot);
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe('migration runner resilience', () => {
	it('adds api_token and applies every migration on a pre-CTFd database', async () => {
		const dir = makeTempDir('ctfbot-legacy-');
		seedLegacySchema(dir);

		const conn = connectIn(dir);
		const { runMigrations } = require('../../src/database/migrations.js');
		const result = runMigrations(conn, join(dir, 'migrations'));

		expect(result.error).toBeNull();

		const expected = migrationFileNames(dir);
		const applied = appliedMigrations(conn);
		for (const name of expected) {
			expect(applied).toContain(name);
		}
		expect(result.applied.length + result.skipped.length).toBe(expected.length);

		const ctfsColumns = columnsOf(conn, 'ctfs');
		expect(ctfsColumns).toContain('api_token');
		expect(ctfsColumns).toContain('team_mode');
		expect(ctfsColumns).toContain('archived');
		expect(ctfsColumns).toContain('platform');
		expect(ctfsColumns).toContain('api_base_url');
		expect(ctfsColumns).toContain('platform_division_id');
		expect(columnsOf(conn, 'ctf_registrations')).toContain('team_name');

		// A row that predates multi-platform support must come out bound to the
		// default platform, otherwise every legacy channel would need a manual
		// /setctfplatform before it could sync again. The default lives on the
		// column itself, so ALTER TABLE backfills existing rows with it.
		const platformColumn = conn
			.prepare('SELECT dflt_value FROM pragma_table_info(\'ctfs\') WHERE name = \'platform\'')
			.get();
		expect(platformColumn.dflt_value).toBe('\'ctfd\'');

		// The regression: createCTF binds @api_token even for a non-CTFd
		// organizer (api_token: null, no banner).
		const { ctfOperations } = require('../../src/database/index.js');
		const id = ctfOperations.createCTF({
			guild_id: 'guild-1',
			channel_id: 'chan-legacy',
			event_id: 'event-1',
			ctf_name: 'Non-CTFd Open',
			ctf_base_url: 'https://example-organizer.test/',
			ctf_date: new Date(Date.now() + 86_400_000).toISOString(),
			description: 'An organizer that does not use CTFd',
			banner_url: undefined,
			api_token: null,
			team_mode: 0,
			created_by: 'admin-1'
		});

		expect(typeof id).toBe('number');

		const row = ctfOperations.getCTFByChannelId('chan-legacy');
		expect(row).toBeTruthy();
		expect(row.ctf_name).toBe('Non-CTFd Open');
		expect(row.api_token).toBeNull();
		// createCTF never binds platform, so the column default is what keeps a
		// CTFd-era deployment working without any operator action.
		expect(row.platform).toBe('ctfd');
	});

	it('recovers from partial drift instead of aborting the migration chain', async () => {
		const dir = makeTempDir('ctfbot-drift-');
		seedPartialDriftSchema(dir);

		const conn = connectIn(dir);
		const { runMigrations } = require('../../src/database/migrations.js');
		const result = runMigrations(conn, join(dir, 'migrations'));

		expect(result.error).toBeNull();

		const applied = appliedMigrations(conn);
		for (const name of migrationFileNames(dir)) {
			expect(applied).toContain(name);
		}

		// team_name already existed; team_mode did not. Both must be present,
		// which only happens if the duplicate-column recovery replayed the
		// migration with the already-present ALTER filtered out.
		expect(columnsOf(conn, 'ctfs')).toContain('team_mode');
		expect(columnsOf(conn, 'ctf_registrations')).toContain('team_name');
	});

	it('leaves a fresh database with the complete ctfs column set', async () => {
		const dir = makeTempDir('ctfbot-fresh-');

		process.chdir(dir);
		const { closeConnection, getConnection } = require('../../src/database/connection.js');
		closeConnection();
		const { initDatabase } = require('../../src/database/index.js');
		initDatabase();
		const conn = getConnection();

		const ctfsColumns = columnsOf(conn, 'ctfs');
		const expected = [
			'id',
			'guild_id',
			'channel_id',
			'event_id',
			'ctf_name',
			'ctf_base_url',
			'ctf_date',
			'description',
			'banner_url',
			'api_token',
			'team_mode',
			'archived',
			'platform',
			'api_base_url',
			'platform_division_id',
			'created_at',
			'created_by'
		];
		for (const column of expected) {
			expect(ctfsColumns).toContain(column);
		}

		const applied = appliedMigrations(conn);
		for (const name of migrationFileNames(dir)) {
			expect(applied).toContain(name);
		}
	});
});
