import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, copyFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ── Strategy ───────────────────────────────────────────────────────────
// A role grant or CSV bulk grant is anchored by ONE blockchain block, so the
// database half must be all-or-nothing and safe to retry. These tests run
// against a real SQLite database to prove:
//
//   * every recipient is credited in a single call
//   * a mid-batch failure rolls the whole batch back
//   * replaying the same batch key applies nothing a second time
//
// The commands themselves are asserted at source level, because the repository
// behaviour is what makes the atomicity guarantee real.

let tmpDir;
let originalCwd;
let db;
let activityRepository;

beforeAll(async () => {
	originalCwd = process.cwd();
	const migrationsDir = join(originalCwd, 'migrations');
	tmpDir = mkdtempSync(join(tmpdir(), 'ctfbot-grantbatch-'));
	copyFileSync(join(originalCwd, 'ctfbot.db'), join(tmpDir, 'ctfbot.db'));
	process.chdir(tmpDir);

	const { getConnection } = await import('../../src/database/connection.js');
	const { runMigrations } = await import('../../src/database/migrations.js');
	db = getConnection();
	const migration = runMigrations(db, migrationsDir);
	expect(migration.error).toBeNull();

	activityRepository = (await import('../../src/database/repositories/activity.repository.js')).default;
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

const ledgerCount = userId =>
	db.prepare('SELECT COUNT(*) AS n FROM activity_ledger WHERE user_id = ?').get(userId).n;

describe('grantPointsMany', () => {
	it('credits every recipient in one call', () => {
		const result = activityRepository.grantPointsMany({
			batchKey: 'batch-happy',
			entries: [
				{ discord_id: 'bulk-a', points: 10 },
				{ discord_id: 'bulk-b', points: 20 },
				{ discord_id: 'bulk-c', points: 30 }
			],
			grantedBy: 'admin-1',
			note: 'role grant',
			blockHeight: 900
		});

		expect(result.applied).toBe(true);
		expect(result.balances.map(b => b.balance)).toEqual([10, 20, 30]);

		expect(activityRepository.getBalance('bulk-a')).toBe(10);
		expect(activityRepository.getBalance('bulk-b')).toBe(20);
		expect(activityRepository.getBalance('bulk-c')).toBe(30);

		expect(ledgerCount('bulk-a')).toBe(1);
		expect(ledgerCount('bulk-b')).toBe(1);
		expect(ledgerCount('bulk-c')).toBe(1);

		// Every ledger row must carry the single anchoring block height.
		const heights = db
			.prepare('SELECT DISTINCT block_height FROM activity_ledger WHERE user_id LIKE ?')
			.all('bulk-%')
			.map(r => r.block_height);
		expect(heights).toEqual([900]);
	});

	it('rolls the whole batch back when one entry fails mid-batch', () => {
		// A NULL user_id violates the NOT NULL constraint on activity_ledger and
		// must abort every other entry in the same transaction.
		expect(() =>
			activityRepository.grantPointsMany({
				batchKey: 'batch-atomic',
				entries: [
					{ discord_id: 'atomic-a', points: 5 },
					{ discord_id: null, points: 5 },
					{ discord_id: 'atomic-c', points: 5 }
				],
				grantedBy: 'admin-1',
				blockHeight: 901
			})
		).toThrow();

		// Nothing was applied, and the batch key was not consumed, so a corrected
		// retry can still succeed.
		expect(activityRepository.getBalance('atomic-a')).toBe(0);
		expect(activityRepository.getBalance('atomic-c')).toBe(0);
		expect(ledgerCount('atomic-a')).toBe(0);
		expect(ledgerCount('atomic-c')).toBe(0);
		expect(db.prepare('SELECT COUNT(*) AS n FROM ap_grant_batches WHERE batch_key = ?').get('batch-atomic').n).toBe(0);

		const retry = activityRepository.grantPointsMany({
			batchKey: 'batch-atomic',
			entries: [
				{ discord_id: 'atomic-a', points: 5 },
				{ discord_id: 'atomic-c', points: 5 }
			],
			grantedBy: 'admin-1',
			blockHeight: 902
		});
		expect(retry.applied).toBe(true);
		expect(activityRepository.getBalance('atomic-a')).toBe(5);
		expect(activityRepository.getBalance('atomic-c')).toBe(5);
	});

	it('applies a batch only once, so a retry cannot double-credit', () => {
		const entries = [
			{ discord_id: 'idem-a', points: 7 },
			{ discord_id: 'idem-b', points: 7 }
		];

		const first = activityRepository.grantPointsMany({
			batchKey: 'batch-idempotent',
			entries,
			grantedBy: 'admin-1',
			blockHeight: 910
		});
		expect(first.applied).toBe(true);
		expect(activityRepository.getBalance('idem-a')).toBe(7);
		expect(activityRepository.getBalance('idem-b')).toBe(7);

		const second = activityRepository.grantPointsMany({
			batchKey: 'batch-idempotent',
			entries,
			grantedBy: 'admin-1',
			blockHeight: 911
		});
		expect(second.applied).toBe(false);
		expect(second.balances).toEqual([]);

		// Balances and ledger are untouched by the replayed batch.
		expect(activityRepository.getBalance('idem-a')).toBe(7);
		expect(activityRepository.getBalance('idem-b')).toBe(7);
		expect(ledgerCount('idem-a')).toBe(1);
		expect(ledgerCount('idem-b')).toBe(1);
	});

	it('accumulates onto an existing balance', () => {
		activityRepository.grantPoints({ userId: 'acc-a', amount: 100, grantedBy: 'admin-1', blockHeight: 920 });
		activityRepository.grantPointsMany({
			batchKey: 'batch-accumulate',
			entries: [{ discord_id: 'acc-a', points: 25 }],
			grantedBy: 'admin-1',
			blockHeight: 921
		});
		expect(activityRepository.getBalance('acc-a')).toBe(125);
	});
});

describe('command wiring', () => {
	it('grants through a single idempotent batch instead of a per-entry loop', () => {
		const combined = [
			readFileSync(join(originalCwd, 'src/commands/giveap.js'), 'utf8'),
			readFileSync(join(originalCwd, 'src/commands/giveapbulk.js'), 'utf8')
		].join('\n');

		expect(combined).toContain('grantPointsMany');
		expect(combined).toContain('batchKey: interaction.id');
		// No per-entry grantPoints call may remain in either command.
		expect(combined).not.toMatch(/for \(const \w+ of (entries|valid)\)\s*\{[^}]*grantPoints\(/);
	});
});
