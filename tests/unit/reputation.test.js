import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, copyFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ── Strategy ───────────────────────────────────────────────────────────
// The reputation daily limit used to be a read-check-then-write race across an
// awaited blockchain append. These tests hold the new atomic claim primitives
// to the behaviour that makes the race impossible:
//
//   * claimDailyReputation wins exactly once per (from_user, UTC date)
//   * awardReputation appends exactly one block and stamps its height
//   * a failed append releases the claim so a retry can succeed
//
// A real SQLite database is used (temp cwd copy of ctfbot.db) so the UNIQUE
// (from_user, date) index is genuinely exercised. The blockchain writer is
// injected, so no network call is made.

let tmpDir;
let originalCwd;
let db;
let repo;
let awardReputation;

const utcToday = () => new Date().toISOString().slice(0, 10);

beforeAll(async () => {
	originalCwd = process.cwd();
	const migrationsDir = join(originalCwd, 'migrations');
	tmpDir = mkdtempSync(join(tmpdir(), 'ctfbot-rep-'));
	copyFileSync(join(originalCwd, 'ctfbot.db'), join(tmpDir, 'ctfbot.db'));
	process.chdir(tmpDir);

	const { getConnection } = await import('../../src/database/connection.js');
	const { runMigrations } = await import('../../src/database/migrations.js');
	db = getConnection();
	const migration = runMigrations(db, migrationsDir);
	expect(migration.error).toBeNull();

	repo = (await import('../../src/database/repositories/reputation.repository.js')).default;
	const repService = await import('../../src/services/reputation.js');
	awardReputation = repService.awardReputation || repService.default.awardReputation;
});

afterAll(() => {
	if (db?.open) {
		db.close();
	}
	process.chdir(originalCwd);
	if (tmpDir) {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

describe('claimDailyReputation', () => {
	it('claims the day once and rejects the second claim, leaving one row', () => {
		const first = repo.claimDailyReputation({
			userId: 'recipient-claim',
			fromUser: 'giver-claim',
			amount: 1,
			reason: 'reaction'
		});
		expect(first.claimed).toBe(true);
		expect(first.date).toBe(utcToday());

		const second = repo.claimDailyReputation({
			userId: 'someone-else',
			fromUser: 'giver-claim',
			amount: 1,
			reason: 'reaction'
		});
		expect(second.claimed).toBe(false);

		const rows = db.prepare('SELECT * FROM reputations WHERE from_user = ?').all('giver-claim');
		expect(rows.length).toBe(1);
		// The first writer owns the row; the loser does not overwrite it.
		expect(rows[0].user_id).toBe('recipient-claim');
	});

	it('starts a claimed row at block height 0 until the chain confirms it', () => {
		const row = db.prepare('SELECT * FROM reputations WHERE from_user = ?').get('giver-claim');
		expect(row.block_height).toBe(0);
	});

	it('finalizeReputationBlock stamps the height and releaseReputationClaim removes the row', () => {
		repo.claimDailyReputation({
			userId: 'recipient-finalize',
			fromUser: 'giver-finalize',
			amount: -1,
			reason: 'reply'
		});
		repo.finalizeReputationBlock({
			fromUser: 'giver-finalize',
			date: utcToday(),
			blockHeight: 501
		});
		const finalized = db.prepare('SELECT * FROM reputations WHERE from_user = ?').get('giver-finalize');
		expect(finalized.block_height).toBe(501);
		expect(finalized.amount).toBe(-1);

		expect(repo.releaseReputationClaim({ fromUser: 'giver-finalize', date: utcToday() })).toBe(true);
		expect(db.prepare('SELECT * FROM reputations WHERE from_user = ?').all('giver-finalize').length).toBe(0);
		// Nothing left to release on a second call.
		expect(repo.releaseReputationClaim({ fromUser: 'giver-finalize', date: utcToday() })).toBe(false);
	});
});

describe('awardReputation', () => {
	it('appends exactly one block and finalizes the stored height', async () => {
		const calls = [];
		const appendBlock = async params => {
			calls.push(params);
			return { height: 42 };
		};

		const status = await awardReputation({
			toUser: 'recipient-a',
			fromUser: 'giver-a',
			amount: 1,
			reason: 'reaction',
			appendBlock
		});

		expect(status).toBe('awarded');
		expect(calls.length).toBe(1);

		const payload = JSON.parse(calls[0].data);
		expect(payload.type).toBe('rep');
		expect(payload.toUser).toBe('recipient-a');
		expect(payload.fromUser).toBe('giver-a');
		expect(payload.date).toBe(utcToday());

		const row = db.prepare('SELECT * FROM reputations WHERE from_user = ?').get('giver-a');
		expect(row.block_height).toBe(42);
		expect(row.user_id).toBe('recipient-a');
		expect(repo.getUserTotal('recipient-a')).toBe(1);
	});

	it('returns already-given on a second award the same day and appends no block', async () => {
		const calls = [];
		const appendBlock = async params => {
			calls.push(params);
			return { height: 43 };
		};

		const status = await awardReputation({
			toUser: 'recipient-b',
			fromUser: 'giver-a',
			amount: 1,
			reason: 'reaction',
			appendBlock
		});

		expect(status).toBe('already-given');
		expect(calls.length).toBe(0);
		// The original recipient keeps the point; the second target gets nothing.
		expect(repo.getUserTotal('recipient-b')).toBe(0);
		expect(repo.getUserTotal('recipient-a')).toBe(1);
	});

	it('releases the claim when the blockchain append fails so a retry succeeds', async () => {
		const failing = async () => {
			throw new Error('blockchain down');
		};

		const status = await awardReputation({
			toUser: 'recipient-c',
			fromUser: 'giver-c',
			amount: 1,
			reason: 'reply',
			appendBlock: failing
		});

		expect(status).toBe('failed');
		// The failed claim must not linger and block the day.
		expect(db.prepare('SELECT * FROM reputations WHERE from_user = ?').all('giver-c').length).toBe(0);
		expect(repo.getUserTotal('recipient-c')).toBe(0);

		const retryCalls = [];
		const retryAppend = async params => {
			retryCalls.push(params);
			return { height: 77 };
		};

		const retryStatus = await awardReputation({
			toUser: 'recipient-c',
			fromUser: 'giver-c',
			amount: 1,
			reason: 'reply',
			appendBlock: retryAppend
		});

		expect(retryStatus).toBe('awarded');
		expect(retryCalls.length).toBe(1);
		expect(repo.getUserTotal('recipient-c')).toBe(1);
	});
});

describe('listener wiring', () => {
	it('does not run a separate daily-limit check before appending a block', () => {
		const reactionListener = readFileSync(join(originalCwd, 'src/listeners/messageReactionAdd.js'), 'utf8');
		const messageListener = readFileSync(join(originalCwd, 'src/listeners/messageCreate.js'), 'utf8');

		expect(reactionListener).not.toContain('hasGivenRepToday');
		expect(messageListener).not.toContain('hasGivenRepToday');
		expect(reactionListener).toContain('awardReputation');
		expect(messageListener).toContain('awardReputation');
	});
});
