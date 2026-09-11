import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, copyFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ── Strategy ───────────────────────────────────────────────────────────
// The store used to anchor the blockchain block BEFORE touching the balance, so
// a double click appended two "completed purchase" blocks while only one debit
// went through, and a crash between the two left a block with no purchase.
//
// The flow is now reserve -> anchor -> finalize, with release as the
// compensating action. These tests hold that state machine to account against a
// real SQLite database:
//
//   * reserve debits and creates the pending AP purchase
//   * finalize marks it completed and stamps the height on purchase AND ledger
//   * release restores the points and removes both rows
//   * an unaffordable reserve changes nothing
//   * an abandoned reservation is swept up on startup

const repoRoot = process.cwd();

let tmpDir;
let db;
let activityRepository;

beforeAll(async () => {
	const migrationsDir = join(repoRoot, 'migrations');
	tmpDir = mkdtempSync(join(tmpdir(), 'ctfbot-reserve-'));
	copyFileSync(join(repoRoot, 'ctfbot.db'), join(tmpDir, 'ctfbot.db'));
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
	process.chdir(repoRoot);
	if (tmpDir) {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

const ledgerFor = purchaseId =>
	db.prepare("SELECT * FROM activity_ledger WHERE reference_id = ? AND kind = 'purchase'").all(purchaseId);

describe('reserveApPurchase', () => {
	it('debits the balance and creates a pending AP purchase', () => {
		activityRepository.grantPoints({ userId: 'buyer-1', amount: 100, grantedBy: 'admin', blockHeight: 1 });

		const newBalance = activityRepository.reserveApPurchase({
			purchaseId: 'res-1',
			userId: 'buyer-1',
			itemId: 1,
			apCost: 30
		});

		expect(newBalance).toBe(70);
		expect(activityRepository.getBalance('buyer-1')).toBe(70);

		const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get('res-1');
		expect(purchase.status).toBe('pending');
		expect(purchase.payment_method).toBe('ap');
		expect(purchase.cost_ap).toBe(30);
		// Not anchored yet: the height stays null until finalize.
		expect(purchase.block_height).toBeNull();

		const ledger = ledgerFor('res-1');
		expect(ledger.length).toBe(1);
		expect(ledger[0].amount).toBe(-30);
		// The ledger row is an unconfirmed claim at height 0 until finalize.
		expect(ledger[0].block_height).toBe(0);
	});

	it('returns null and changes nothing when the balance is insufficient', () => {
		const before = activityRepository.getBalance('buyer-1');

		const result = activityRepository.reserveApPurchase({
			purchaseId: 'res-too-expensive',
			userId: 'buyer-1',
			itemId: 3,
			apCost: 100000
		});

		expect(result).toBeNull();
		expect(activityRepository.getBalance('buyer-1')).toBe(before);
		expect(db.prepare('SELECT * FROM purchases WHERE id = ?').get('res-too-expensive')).toBeUndefined();
		expect(ledgerFor('res-too-expensive').length).toBe(0);
	});

	it('returns null for a user who has no balance at all', () => {
		const result = activityRepository.reserveApPurchase({
			purchaseId: 'res-broke',
			userId: 'never-granted',
			itemId: 1,
			apCost: 10
		});
		expect(result).toBeNull();
		expect(db.prepare('SELECT * FROM purchases WHERE id = ?').get('res-broke')).toBeUndefined();
	});

	it('allows a debit exactly equal to the balance, leaving zero', () => {
		activityRepository.grantPoints({ userId: 'buyer-exact', amount: 40, grantedBy: 'admin', blockHeight: 2 });
		const result = activityRepository.reserveApPurchase({
			purchaseId: 'res-exact',
			userId: 'buyer-exact',
			itemId: 1,
			apCost: 40
		});
		expect(result).toBe(0);
		expect(activityRepository.getBalance('buyer-exact')).toBe(0);
	});
});

describe('finalizeApPurchase', () => {
	it('completes the purchase and stamps the height on purchase and ledger', () => {
		const ok = activityRepository.finalizeApPurchase({ purchaseId: 'res-1', blockHeight: 500 });

		expect(ok).toBe(true);

		const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get('res-1');
		expect(purchase.status).toBe('completed');
		expect(purchase.block_height).toBe(500);

		const ledger = ledgerFor('res-1');
		expect(ledger[0].block_height).toBe(500);
	});

	it('refuses to finalize twice', () => {
		expect(activityRepository.finalizeApPurchase({ purchaseId: 'res-1', blockHeight: 501 })).toBe(false);
		const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get('res-1');
		expect(purchase.block_height).toBe(500);
	});
});

describe('releaseApPurchase', () => {
	it('restores the points and removes a pending reservation', () => {
		activityRepository.grantPoints({ userId: 'buyer-2', amount: 50, grantedBy: 'admin', blockHeight: 3 });

		activityRepository.reserveApPurchase({
			purchaseId: 'res-release',
			userId: 'buyer-2',
			itemId: 2,
			apCost: 20
		});
		expect(activityRepository.getBalance('buyer-2')).toBe(30);

		expect(activityRepository.releaseApPurchase({ purchaseId: 'res-release' })).toBe(true);

		// Points are back and no trace of the reservation remains.
		expect(activityRepository.getBalance('buyer-2')).toBe(50);
		expect(db.prepare('SELECT * FROM purchases WHERE id = ?').get('res-release')).toBeUndefined();
		expect(ledgerFor('res-release').length).toBe(0);
	});

	it('refuses to release a completed purchase', () => {
		// res-1 was finalized above; releasing it must not undo a real purchase.
		const before = activityRepository.getBalance('buyer-1');
		expect(activityRepository.releaseApPurchase({ purchaseId: 'res-1' })).toBe(false);
		expect(activityRepository.getBalance('buyer-1')).toBe(before);
		expect(db.prepare('SELECT * FROM purchases WHERE id = ?').get('res-1')).toBeDefined();
	});
});

describe('pending purchase listing and stale sweep', () => {
	it('lists only Rp purchases, never AP reservations', () => {
		activityRepository.createPurchase({
			id: 'rp-listed',
			userId: 'buyer-3',
			itemId: 3,
			paymentMethod: 'rp',
			status: 'pending',
			costAp: 0,
			costRp: 200000,
			blockHeight: null
		});
		activityRepository.grantPoints({ userId: 'buyer-4', amount: 60, grantedBy: 'admin', blockHeight: 4 });
		activityRepository.reserveApPurchase({
			purchaseId: 'ap-hidden',
			userId: 'buyer-4',
			itemId: 1,
			apCost: 10
		});

		const pending = activityRepository.listPendingPurchases();
		const ids = pending.map(p => p.id);
		expect(ids).toContain('rp-listed');
		expect(ids).not.toContain('ap-hidden');
	});

	it('releases a reservation abandoned by a crash', () => {
		activityRepository.grantPoints({ userId: 'buyer-5', amount: 80, grantedBy: 'admin', blockHeight: 5 });
		activityRepository.reserveApPurchase({
			purchaseId: 'ap-abandoned',
			userId: 'buyer-5',
			itemId: 1,
			apCost: 15
		});
		expect(activityRepository.getBalance('buyer-5')).toBe(65);

		// Backdate the reservation so it looks like it was orphaned by a crash.
		db.prepare('UPDATE purchases SET created_at = ? WHERE id = ?')
			.run(Math.floor(Date.now() / 1000) - 3600, 'ap-abandoned');

		const released = activityRepository.releaseStaleApReservations({ olderThanSeconds: 900 });
		expect(released).toBe(1);
		expect(activityRepository.getBalance('buyer-5')).toBe(80);
		expect(db.prepare('SELECT * FROM purchases WHERE id = ?').get('ap-abandoned')).toBeUndefined();
	});

	it('leaves a fresh reservation alone', () => {
		activityRepository.grantPoints({ userId: 'buyer-6', amount: 80, grantedBy: 'admin', blockHeight: 6 });
		activityRepository.reserveApPurchase({
			purchaseId: 'ap-fresh',
			userId: 'buyer-6',
			itemId: 1,
			apCost: 15
		});

		// A reservation made moments ago could still be owned by an in-flight
		// request, so the sweep must not touch it.
		expect(activityRepository.releaseStaleApReservations({ olderThanSeconds: 900 })).toBe(0);
		expect(activityRepository.getBalance('buyer-6')).toBe(65);
		expect(db.prepare('SELECT * FROM purchases WHERE id = ?').get('ap-fresh')).toBeDefined();
	});
});

describe('buy flow ordering', () => {
	it('reserves before anchoring for AP, and creates the row before anchoring for Rp', () => {
		const src = readFileSync(join(repoRoot, 'src/listeners/interactionCreate.js'), 'utf8');

		const apStart = src.indexOf('async _buyWithAp');
		const rpStart = src.indexOf('async _buyWithRp');
		const ap = src.slice(apStart, rpStart);
		const rp = src.slice(rpStart);

		// AP: reserve -> append -> finalize
		const apReserve = ap.indexOf('reserveApPurchase');
		const apAppend = ap.indexOf('luce.appendBlock');
		const apFinalize = ap.indexOf('finalizeApPurchase');
		expect(apReserve).toBeGreaterThan(-1);
		expect(apReserve).toBeLessThan(apAppend);
		expect(apAppend).toBeLessThan(apFinalize);
		// Release is the compensating action on failure.
		expect(ap).toContain('releaseApPurchase');
		// No block may be anchored before the reservation succeeds.
		expect(ap.indexOf('completeApPurchase')).toBe(-1);

		// RP: create -> append -> stamp
		const rpCreate = rp.indexOf('createPurchase');
		const rpAppend = rp.indexOf('luce.appendBlock');
		const rpStamp = rp.indexOf('setPurchaseBlockHeight');
		expect(rpCreate).toBeGreaterThan(-1);
		expect(rpCreate).toBeLessThan(rpAppend);
		expect(rpAppend).toBeLessThan(rpStamp);
		expect(rp).toContain('deletePendingPurchase');
	});

	it('drops the one-shot payment buttons after handling', () => {
		const src = readFileSync(join(repoRoot, 'src/listeners/interactionCreate.js'), 'utf8');
		const ap = src.slice(src.indexOf('async _buyWithAp'), src.indexOf('async _buyWithRp'));
		const rp = src.slice(src.indexOf('async _buyWithRp'));
		expect(ap).toContain('components: []');
		expect(rp).toContain('components: []');
	});
});
