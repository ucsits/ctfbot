import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, copyFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';

// Use CJS require so the test holds the SAME connection and repository module
// instances that the src files get through their own require() calls. A dynamic
// ESM import can resolve to a separate instance with its own cached connection,
// which would make the failure-injection patch below miss its target.
const require = createRequire(import.meta.url);

// ── Strategy ───────────────────────────────────────────────────────────
// transferPendingSolves used to run a SELECT and then a loop of UPDATE/DELETE
// statements, each its own implicit transaction, so a non-UNIQUE failure
// partway through left a partially migrated solve set. /registerctf then ran
// the registration and the transfer as two separate operations, so a failure in
// the transfer left the user registered with orphaned ctfd: solves.
//
// Both are now wrapped in transactions. This suite proves the transfer moves
// every solve in one call and that a mid-transfer failure leaves the solve set
// untouched, then checks at source level that registration wraps both steps.

const repoRoot = process.cwd();

let tmpDir;
let db;
let challengeOperations;

beforeAll(async () => {
	const migrationsDir = join(repoRoot, 'migrations');
	tmpDir = mkdtempSync(join(tmpdir(), 'ctfbot-solvetransfer-'));
	copyFileSync(join(repoRoot, 'ctfbot.db'), join(tmpDir, 'ctfbot.db'));
	process.chdir(tmpDir);

	const { getConnection } = require('../../src/database/connection.js');
	const { runMigrations } = require('../../src/database/migrations.js');
	db = getConnection();
	const migration = runMigrations(db, migrationsDir);
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

let ctfCounter = 0;

/** Create a CTF with `challengeCount` challenges and a pending solve for each. */
function seedPendingSolves({ ctfdUserId, challengeCount }) {
	ctfCounter += 1;
	const ctfId = db
		.prepare('INSERT INTO ctfs (guild_id, channel_id, ctf_name, ctf_base_url, ctf_date, created_by) VALUES (?,?,?,?,?,?)')
		.run('g', `chan-${ctfCounter}`, `CTF ${ctfCounter}`, 'https://x.test', new Date().toISOString(), 'admin').lastInsertRowid;

	const challengeIds = [];
	for (let i = 0; i < challengeCount; i++) {
		challengeIds.push(
			db.prepare('INSERT INTO ctf_challenges (ctf_id, chal_name, chal_category, created_by) VALUES (?,?,?,?)')
				.run(ctfId, `chal-${ctfCounter}-${i}`, 'web', 'admin').lastInsertRowid
		);
	}

	for (const challengeId of challengeIds) {
		db.prepare('INSERT INTO ctf_challenge_solves (challenge_id, user_id, ctfd_username) VALUES (?,?,?)')
			.run(challengeId, `ctfd:${ctfdUserId}`, 'ctfdname');
	}

	return { ctfId, challengeIds };
}

const ownerOf = (challengeId, userId) =>
	db.prepare('SELECT user_id FROM ctf_challenge_solves WHERE challenge_id = ? AND user_id = ?')
		.get(challengeId, userId);

describe('transferPendingSolves', () => {
	it('moves every pending solve onto the discord user', () => {
		const { ctfId, challengeIds } = seedPendingSolves({ ctfdUserId: '9001', challengeCount: 3 });

		const result = challengeOperations.transferPendingSolves(ctfId, '9001', 'discord-1');

		expect(result.transferred).toBe(3);
		expect(result.dropped).toBe(0);

		for (const challengeId of challengeIds) {
			expect(ownerOf(challengeId, 'discord-1')).toBeTruthy();
			expect(ownerOf(challengeId, 'ctfd:9001')).toBeUndefined();
		}
	});

	it('drops a solve the discord user already has, without aborting the transfer', () => {
		const { ctfId, challengeIds } = seedPendingSolves({ ctfdUserId: '9002', challengeCount: 2 });

		// The discord user already solved the first challenge, so moving the
		// pending row onto them collides on UNIQUE(challenge_id, user_id).
		db.prepare('INSERT INTO ctf_challenge_solves (challenge_id, user_id) VALUES (?,?)')
			.run(challengeIds[0], 'discord-2');

		const result = challengeOperations.transferPendingSolves(ctfId, '9002', 'discord-2');

		expect(result.transferred).toBe(1);
		expect(result.dropped).toBe(1);
		// The pre-existing solve survives and the other pending one moved.
		expect(ownerOf(challengeIds[0], 'discord-2')).toBeTruthy();
		expect(ownerOf(challengeIds[1], 'discord-2')).toBeTruthy();
	});

	it('leaves the solve set untouched when the transfer fails partway', () => {
		const { ctfId, challengeIds } = seedPendingSolves({ ctfdUserId: '9003', challengeCount: 3 });

		// Force a mid-loop failure that is NOT a UNIQUE collision, which the
		// repository rethrows so the surrounding transaction must roll back.
		const originalPrepare = db.prepare.bind(db);
		let updateCount = 0;
		db.prepare = sql => {
			const stmt = originalPrepare(sql);
			if (typeof sql === 'string' && sql.startsWith('UPDATE ctf_challenge_solves')) {
				return {
					run: (...args) => {
						updateCount += 1;
						if (updateCount === 2) {
							throw new Error('simulated mid-transfer failure');
						}
						return stmt.run(...args);
					}
				};
			}
			return stmt;
		};

		let threw = false;
		try {
			challengeOperations.transferPendingSolves(ctfId, '9003', 'discord-3');
		} catch (error) {
			threw = true;
		} finally {
			db.prepare = originalPrepare;
		}

		expect(threw).toBe(true);

		// Nothing moved: all three solves still belong to the ctfd: user.
		for (const challengeId of challengeIds) {
			expect(ownerOf(challengeId, 'ctfd:9003')).toBeTruthy();
			expect(ownerOf(challengeId, 'discord-3')).toBeUndefined();
		}
	});

	it('returns zeroes when there is nothing to transfer', () => {
		const { ctfId } = seedPendingSolves({ ctfdUserId: '9004', challengeCount: 1 });
		const result = challengeOperations.transferPendingSolves(ctfId, '99999', 'discord-x');
		expect(result).toEqual({ transferred: 0, dropped: 0 });
	});
});

describe('registerctf transaction wiring', () => {
	it('wraps registration and solve claiming in a single transaction', () => {
		const src = readFileSync(join(repoRoot, 'src/commands/registerctf.js'), 'utf8');

		const txAt = src.indexOf('runInTransaction(');
		const registerAt = src.indexOf('registrationOperations.registerUser(');
		const transferAt = src.indexOf('challengeOperations.transferPendingSolves(');

		expect(txAt).toBeGreaterThan(-1);
		expect(registerAt).toBeGreaterThan(-1);
		expect(transferAt).toBeGreaterThan(-1);

		// Both writes must sit inside the transaction opened before either runs.
		expect(txAt).toBeLessThan(registerAt);
		expect(registerAt).toBeLessThan(transferAt);
	});
});
