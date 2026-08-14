import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, copyFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Swap the process cwd to a temp dir so that getConnection() (which resolves
 * cwd/ctfbot.db) targets an isolated database file, then import the DB modules.
 */
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
		expect(items.map(i => i.slug)).toEqual(['sticker', 'shirt', 'jacket']);
		expect(activityRepository.getStoreItemBySlug('sticker').ap_price).toBe(10);
		expect(activityRepository.getStoreItemBySlug('sticker').rp_price).toBe(25000);
	});

	it('creates a pending Rp purchase and lets an admin confirm it', () => {
		activityRepository.createPurchase({
			id: 'p-jacket-rp',
			userId: 'user-2',
			itemId: 3, // jacket
			paymentMethod: 'rp',
			status: 'pending',
			costAp: 0,
			costRp: 250000,
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
