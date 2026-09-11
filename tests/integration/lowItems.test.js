import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, copyFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';

// Small hardening items from the audit:
//   * SQLite runs with WAL + a busy_timeout so a concurrent writer waits instead
//     of failing immediately.
//   * adminRepository.add is a single INSERT OR IGNORE that reports whether it
//     actually inserted, so /admin add needs no racy exists() pre-check.
//
// Require (not import) so this test shares the module instances src files use.
const require = createRequire(import.meta.url);

const repoRoot = process.cwd();

let tmpDir;
let db;
let adminRepository;

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'ctfbot-low-'));
	copyFileSync(join(repoRoot, 'ctfbot.db'), join(tmpDir, 'ctfbot.db'));
	process.chdir(tmpDir);

	const { getConnection } = require('../../src/database/connection.js');
	const { runMigrations } = require('../../src/database/migrations.js');
	db = getConnection();
	const migration = runMigrations(db, join(repoRoot, 'migrations'));
	expect(migration.error).toBeNull();

	adminRepository = require('../../src/database/repositories/admin.repository.js');
});

afterAll(() => {
	if (db?.open) {
		db.close();
	}
	process.chdir(repoRoot);
	if (tmpDir) {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

describe('sqlite durability pragmas', () => {
	it('enables WAL journaling', () => {
		const mode = db.pragma('journal_mode', { simple: true });
		expect(String(mode).toLowerCase()).toBe('wal');
	});

	it('sets a busy timeout so concurrent writers wait', () => {
		const timeout = db.pragma('busy_timeout', { simple: true });
		expect(timeout).toBe(5000);
	});

	it('keeps foreign keys enabled', () => {
		expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
	});
});

describe('adminRepository.add atomicity', () => {
	it('reports 1 on the first add and 0 on a duplicate', () => {
		expect(adminRepository.add('admin-new', 'adder')).toBe(1);
		expect(adminRepository.add('admin-new', 'adder')).toBe(0);
		expect(adminRepository.add('admin-new', 'someone-else')).toBe(0);

		// Exactly one row, and the original added_by is preserved.
		const rows = db.prepare('SELECT * FROM admins WHERE user_id = ?').all('admin-new');
		expect(rows.length).toBe(1);
		expect(rows[0].added_by).toBe('adder');
	});

	it('still reports 1 for a genuinely new admin', () => {
		expect(adminRepository.add('admin-second', 'adder')).toBe(1);
		const count = db.prepare('SELECT COUNT(*) AS n FROM admins WHERE user_id = ?').get('admin-second').n;
		expect(count).toBe(1);
	});

	it('does not rely on an exists() pre-check in /admin add', () => {
		const src = readFileSync(join(repoRoot, 'src/commands/admin.js'), 'utf8');
		const addAdmin = src.slice(src.indexOf('async addAdmin'), src.indexOf('async removeAdmin'));
		expect(addAdmin).toContain('adminRepository.add(user.id, interaction.user.id) === 0');
		expect(addAdmin).not.toContain('adminRepository.exists(');
	});
});
