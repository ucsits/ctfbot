import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, copyFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';

// ── Strategy ───────────────────────────────────────────────────────────
// The one-solve-per-team rule used to be application-only: the commands checked
// every team member and then inserted, while the schema only guaranteed
// UNIQUE(challenge_id, user_id), which is per user. Team mode now stores the
// team name as team_key and a partial unique index enforces one solve per team.
//
// Require (not import) so the test shares the exact module instances the src
// files get through their own require() calls.
const require = createRequire(import.meta.url);

const repoRoot = process.cwd();

let tmpDir;
let db;
let challengeOperations;

beforeAll(async () => {
	tmpDir = mkdtempSync(join(tmpdir(), 'ctfbot-teamsolve-'));
	copyFileSync(join(repoRoot, 'ctfbot.db'), join(tmpDir, 'ctfbot.db'));
	process.chdir(tmpDir);

	const { getConnection } = require('../../src/database/connection.js');
	const { runMigrations } = require('../../src/database/migrations.js');
	db = getConnection();
	const migration = runMigrations(db, join(repoRoot, 'migrations'));
	expect(migration.error).toBeNull();

	challengeOperations = require('../../src/database/repositories/challenge.repository.js');
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

let counter = 0;

function seedChallenge() {
	counter += 1;
	const ctfId = db
		.prepare('INSERT INTO ctfs (guild_id, channel_id, ctf_name, ctf_base_url, ctf_date, created_by) VALUES (?,?,?,?,?,?)')
		.run('g', `chan-team-${counter}`, `TeamCTF ${counter}`, 'https://x.test', new Date().toISOString(), 'admin')
		.lastInsertRowid;
	const challengeId = db
		.prepare('INSERT INTO ctf_challenges (ctf_id, chal_name, chal_category, created_by) VALUES (?,?,?,?)')
		.run(ctfId, `chal-team-${counter}`, 'web', 'admin').lastInsertRowid;
	return challengeId;
}

const solvesFor = challengeId =>
	db.prepare('SELECT * FROM ctf_challenge_solves WHERE challenge_id = ? ORDER BY user_id').all(challengeId);

describe('team solve uniqueness', () => {
	it('rejects a second member of the same team on the same challenge', () => {
		const challengeId = seedChallenge();

		expect(challengeOperations.markChallengeSolved(challengeId, 'member-a', null, 'TeamAlpha')).toBeTruthy();

		let thrown = null;
		try {
			challengeOperations.markChallengeSolved(challengeId, 'member-b', null, 'TeamAlpha');
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeTruthy();
		expect(thrown.message).toContain('UNIQUE constraint failed');

		// Exactly one solve survives, and it is the first member's.
		const rows = solvesFor(challengeId);
		expect(rows.length).toBe(1);
		expect(rows[0].user_id).toBe('member-a');
		expect(rows[0].team_key).toBe('TeamAlpha');
	});

	it('allows two different teams on the same challenge', () => {
		const challengeId = seedChallenge();

		challengeOperations.markChallengeSolved(challengeId, 'alpha-1', null, 'TeamAlpha');
		challengeOperations.markChallengeSolved(challengeId, 'beta-1', null, 'TeamBeta');

		const rows = solvesFor(challengeId);
		expect(rows.length).toBe(2);
		expect(rows.map(r => r.team_key).sort()).toEqual(['TeamAlpha', 'TeamBeta']);
	});

	it('leaves individual solves unaffected (NULL team key)', () => {
		const challengeId = seedChallenge();

		// Two users, no team key: the partial index must not apply, so both are
		// recorded even though the challenge is identical.
		challengeOperations.markChallengeSolved(challengeId, 'solo-1');
		challengeOperations.markChallengeSolved(challengeId, 'solo-2');

		const rows = solvesFor(challengeId);
		expect(rows.length).toBe(2);
		expect(rows.every(r => r.team_key === null)).toBe(true);
	});

	it('still rejects a duplicate individual solve for the same user', () => {
		const challengeId = seedChallenge();

		challengeOperations.markChallengeSolved(challengeId, 'solo-again');

		expect(() => challengeOperations.markChallengeSolved(challengeId, 'solo-again')).toThrow(/UNIQUE constraint failed/);
		expect(solvesFor(challengeId).length).toBe(1);
	});

	it('stores the solve timestamp when one is supplied', () => {
		const challengeId = seedChallenge();
		challengeOperations.markChallengeSolved(challengeId, 'dated-user', '2026-01-02 03:04:05', 'TeamDated');
		const row = solvesFor(challengeId)[0];
		expect(row.solved_at).toBe('2026-01-02 03:04:05');
		expect(row.team_key).toBe('TeamDated');
	});
});

describe('command wiring', () => {
	it('passes team_name as the team key from solvectf', () => {
		const src = readFileSync(join(repoRoot, 'src/commands/solvectf.js'), 'utf8');
		expect(src).toContain('ctf.team_mode ? registration.team_name : null');
		expect(src).toContain('team_key');
	});

	it('passes team_name as the team key from both sync paths', () => {
		const src = readFileSync(join(repoRoot, 'src/commands/syncchallenges.js'), 'utf8');
		expect(src).toContain("userRegMap.get(discordUserId)?.team_name || null");
		expect(src).toContain('ctf.team_mode && reg.team_name ? reg.team_name : null');
		expect(src).toContain('_recordSolve(');
	});
});
