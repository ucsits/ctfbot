import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, copyFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Swap the process cwd to a temp dir so that getConnection() (which resolves
 * cwd/ctfbot.db) targets an isolated database file, then import the DB modules.
 */
const repoRoot = process.cwd();

let tmpDir;
let conn;
let activityRepository;

beforeAll(async () => {
	tmpDir = mkdtempSync(join(tmpdir(), 'ctfbot-activity-'));
	const base = process.cwd();

	// Seed from the real ctfbot.db (base tables + migrations 001-011 already
	// applied) so the appending migrations 012/013/014 can run cleanly on top.
	const projectDb = join(base, 'ctfbot.db');
	copyFileSync(projectDb, join(tmpDir, 'ctfbot.db'));
	process.chdir(tmpDir);

	// Load connection fresh so it points at the temp cwd.
	const { getConnection } = await import('../../src/database/connection.js');
	const { runMigrations } = await import('../../src/database/migrations.js');
	const migrationsDir = join(base, 'migrations');

	conn = getConnection();
	const result = runMigrations(conn, migrationsDir);
	expect(result.error).toBeNull();

	activityRepository = (await import('../../src/database/repositories/activity.repository.js')).default;

	await sleep(20);
});

afterAll(() => {
	if (conn) {
		conn.close();
	}
	process.chdir(process.cwd()); // leave
	if (tmpDir) {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

describe('Activity Repository', () => {
	it('returns 0 balance for a user with no grants', () => {
		expect(activityRepository.getBalance('ghost-user')).toBe(0);
	});

	it('grants points and updates the balance', () => {
		const balance = activityRepository.grantPoints({
			userId: 'user-1',
			amount: 50,
			grantedBy: 'admin-1',
			note: 'first grant',
			blockHeight: 100
		});
		expect(balance).toBe(50);
		expect(activityRepository.getBalance('user-1')).toBe(50);
	});

	it('accumulates multiple grants', () => {
		activityRepository.grantPoints({ userId: 'user-1', amount: 30, grantedBy: 'admin-1', blockHeight: 101 });
		expect(activityRepository.getBalance('user-1')).toBe(80);
	});

	it('returns null and spends nothing when balance is insufficient', () => {
		const before = activityRepository.getBalance('user-1');
		const result = activityRepository.completeApPurchase({
			purchaseId: 'p-too-expensive',
			userId: 'user-1',
			itemId: 1,
			apCost: 100000,
			blockHeight: 102
		});
		expect(result).toBeNull();
		expect(activityRepository.getBalance('user-1')).toBe(before);
		expect(activityRepository.getPurchase('p-too-expensive')).toBeUndefined();
	});

	it('completes an AP purchase atomically (deducts + records)', () => {
		const nb = activityRepository.completeApPurchase({
			purchaseId: 'p-sticker',
			userId: 'user-1',
			itemId: 1, // sticker (10)
			apCost: 10,
			blockHeight: 103
		});
		expect(nb).toBe(70); // 80 - 10
		const purchase = activityRepository.getPurchase('p-sticker');
		expect(purchase.status).toBe('completed');
		expect(purchase.cost_ap).toBe(10);
	});

	it('lists store items with the seeded catalog', () => {
		const items = activityRepository.getStoreItems();
		expect(items.map(i => i.slug)).toEqual(['sticker', 'keychain', 'shirt', 'jacket']);
		expect(activityRepository.getStoreItemBySlug('sticker').ap_price).toBe(10);
		expect(activityRepository.getStoreItemBySlug('sticker').rp_price).toBe(1000);
		expect(activityRepository.getStoreItemBySlug('keychain').ap_price).toBe(50);
		expect(activityRepository.getStoreItemBySlug('keychain').rp_price).toBe(10000);
	});

	it('creates a pending Rp purchase and lets an admin confirm it', () => {
		activityRepository.createPurchase({
			id: 'p-jacket-rp',
			userId: 'user-2',
			itemId: 3, // jacket
			paymentMethod: 'rp',
			status: 'pending',
			costAp: 0,
			costRp: 200000,
			blockHeight: 110
		});

		const pending = activityRepository.listPendingPurchases();
		expect(pending.some(p => p.id === 'p-jacket-rp')).toBe(true);

		const confirmed = activityRepository.confirmPurchase({
			id: 'p-jacket-rp',
			confirmedBy: 'admin-1',
			blockHeight: 111
		});
		expect(confirmed).toBe(true);

		const purchase = activityRepository.getPurchase('p-jacket-rp');
		expect(purchase.status).toBe('completed');
		expect(purchase.block_height).toBe(111);
		expect(purchase.confirmed_by).toBe('admin-1');
	});

	it('returns true from getLeaderboard ranked highest-first', () => {
		// user-1 has 30, user-2 has 0 (no grant, only a pending-rp purchase).
		const lb = activityRepository.getLeaderboard();
		expect(Array.isArray(lb)).toBe(true);
		if (lb.length > 0) {
			expect(lb[0].balance).toBeGreaterThanOrEqual(lb[lb.length - 1].balance);
		}
	});
});

// ── Purchase confirmation claim (H4) ────────────────────────────────────
// Confirming a purchase used to read `pending`, append a blockchain block, and
// then discard the boolean from confirmPurchase. Two rapid invocations both
// anchored a confirmation block while only one row changed.
describe('purchase confirmation claim', () => {
	it('lets exactly one caller claim a pending purchase while the lease is live', () => {
		activityRepository.createPurchase({
			id: 'p-claim-1',
			userId: 'user-3',
			itemId: 1,
			paymentMethod: 'rp',
			status: 'pending',
			costAp: 0,
			costRp: 1000
		});

		expect(
			activityRepository.claimPurchaseConfirmation({ id: 'p-claim-1', claimedBy: 'admin-a' })
		).toBe(true);
		expect(
			activityRepository.claimPurchaseConfirmation({ id: 'p-claim-1', claimedBy: 'admin-b' })
		).toBe(false);

		const row = conn.prepare('SELECT * FROM purchases WHERE id = ?').get('p-claim-1');
		expect(row.confirm_claim_by).toBe('admin-a');
		expect(row.confirm_claim_until).toBeGreaterThan(Math.floor(Date.now() / 1000));
	});

	it('refuses to claim a purchase that is not pending', () => {
		activityRepository.createPurchase({
			id: 'p-claim-done',
			userId: 'user-3',
			itemId: 1,
			paymentMethod: 'rp',
			status: 'completed',
			costAp: 0,
			costRp: 1000
		});
		expect(
			activityRepository.claimPurchaseConfirmation({ id: 'p-claim-done', claimedBy: 'admin-a' })
		).toBe(false);
	});

	it('reclaim after the lease expires and clean up on release', () => {
		// Force the live claim from the previous test into the past, standing in
		// for a crashed process whose claim timed out.
		conn.prepare('UPDATE purchases SET confirm_claim_until = ? WHERE id = ?')
			.run(Math.floor(Date.now() / 1000) - 10, 'p-claim-1');

		expect(
			activityRepository.claimPurchaseConfirmation({ id: 'p-claim-1', claimedBy: 'admin-b' })
		).toBe(true);

		expect(
			activityRepository.releasePurchaseConfirmation({ id: 'p-claim-1', claimedBy: 'admin-b' })
		).toBe(true);		const released = conn.prepare('SELECT * FROM purchases WHERE id = ?').get('p-claim-1');
		expect(released.confirm_claim_by).toBeNull();
		expect(released.confirm_claim_until).toBeNull();

		// Released, so anyone may claim it again.
		expect(
			activityRepository.claimPurchaseConfirmation({ id: 'p-claim-1', claimedBy: 'admin-c' })
		).toBe(true);
	});

	it('confirmPurchase clears the claim and only succeeds once', () => {
		expect(
			activityRepository.confirmPurchase({
				id: 'p-claim-1',
				confirmedBy: 'admin-c',
				blockHeight: 777
			})
		).toBe(true);

		const row = conn.prepare('SELECT * FROM purchases WHERE id = ?').get('p-claim-1');
		expect(row.status).toBe('completed');
		expect(row.block_height).toBe(777);
		expect(row.confirmed_by).toBe('admin-c');
		expect(row.confirm_claim_by).toBeNull();

		// A second confirmation is a no-op and must report false, which is the
		// signal /store-confirm now checks before reporting success.
		expect(
			activityRepository.confirmPurchase({
				id: 'p-claim-1',
				confirmedBy: 'admin-c',
				blockHeight: 778
			})
		).toBe(false);
	});
});

// ── /store-confirm ordering (H4) ────────────────────────────────────────
describe('store-confirm command ordering', () => {
	it('claims before anchoring and honours the confirmPurchase result', () => {
		const src = readFileSync(join(repoRoot, 'src/commands/store-confirm.js'), 'utf8');

		const claimAt = src.indexOf('claimPurchaseConfirmation');
		const appendAt = src.indexOf('luce.appendBlock');
		const confirmAt = src.indexOf('confirmPurchase');

		expect(claimAt).toBeGreaterThan(-1);
		expect(appendAt).toBeGreaterThan(-1);
		// The claim must happen before the block is anchored.
		expect(claimAt).toBeLessThan(appendAt);
		expect(appendAt).toBeLessThan(confirmAt);
		// The boolean result of confirmPurchase must be checked, not discarded.
		expect(src).toContain('const confirmed = activityRepository.confirmPurchase(');
		expect(src).toContain('if (!confirmed)');
	});
});

// ── Debit guard inside the transaction (M6) ─────────────────────────────
// completeApPurchase and spendPoints used to call getBalance() before opening
// their transaction and then debit unconditionally. The guard is now part of the
// debit statement itself, so the check cannot go stale against the write.
describe('AP debit guard', () => {
	it('rejects an unaffordable debit and writes nothing', () => {
		activityRepository.grantPoints({ userId: 'guard-1', amount: 25, grantedBy: 'admin', blockHeight: 1 });

		const ledgerBefore = conn.prepare('SELECT COUNT(*) AS n FROM activity_ledger WHERE user_id = ?').get('guard-1').n;

		expect(
			activityRepository.completeApPurchase({
				purchaseId: 'guard-p1',
				userId: 'guard-1',
				itemId: 1,
				apCost: 26,
				blockHeight: 2
			})
		).toBeNull();

		expect(activityRepository.getBalance('guard-1')).toBe(25);
		expect(conn.prepare('SELECT COUNT(*) AS n FROM activity_ledger WHERE user_id = ?').get('guard-1').n).toBe(ledgerBefore);
		expect(activityRepository.getPurchase('guard-p1')).toBeUndefined();
	});

	it('allows a debit exactly equal to the balance and leaves zero', () => {
		activityRepository.grantPoints({ userId: 'guard-2', amount: 40, grantedBy: 'admin', blockHeight: 3 });

		const result = activityRepository.completeApPurchase({
			purchaseId: 'guard-p2',
			userId: 'guard-2',
			itemId: 1,
			apCost: 40,
			blockHeight: 4
		});

		expect(result).toBe(0);
		expect(activityRepository.getBalance('guard-2')).toBe(0);
		expect(activityRepository.getPurchase('guard-p2').status).toBe('completed');
	});

	it('spendPoints rejects an unaffordable spend and leaves the ledger alone', () => {
		activityRepository.grantPoints({ userId: 'guard-3', amount: 5, grantedBy: 'admin', blockHeight: 5 });
		const ledgerBefore = conn.prepare('SELECT COUNT(*) AS n FROM activity_ledger WHERE user_id = ?').get('guard-3').n;

		expect(
			activityRepository.spendPoints({ userId: 'guard-3', amount: 6, purchaseId: 'guard-sp1', blockHeight: 6 })
		).toBeNull();

		expect(activityRepository.getBalance('guard-3')).toBe(5);
		expect(conn.prepare('SELECT COUNT(*) AS n FROM activity_ledger WHERE user_id = ?').get('guard-3').n).toBe(ledgerBefore);
	});

	it('never reads the balance before opening the transaction', () => {
		const src = readFileSync(join(repoRoot, 'src/database/repositories/activity.repository.js'), 'utf8');

		for (const fn of ['function completeApPurchase', 'function spendPoints']) {
			const body = src.slice(src.indexOf(fn), src.indexOf('\n}', src.indexOf(fn)) + 2);
			const txAt = body.indexOf('db().transaction(');
			const balanceAt = body.indexOf('getBalance(');

			expect(txAt).toBeGreaterThan(-1);
			expect(body).toContain('balance >= ?');
			// If getBalance appears at all, it must be inside the transaction.
			if (balanceAt !== -1) {
				expect(balanceAt).toBeGreaterThan(txAt);
			}
		}
	});
});
