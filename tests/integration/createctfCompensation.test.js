import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, copyFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ── Strategy ───────────────────────────────────────────────────────────
// /createctf runs its side effects in order: create the channel, create the
// scheduled event, post the welcome message, then persist the ctfs row via
// saveToDatabase. The success reply comes after the persist step, so a failure
// in sendConfirmation (which is exactly what the scheduledStartTime bug caused)
// landed in the catch and ran _compensateCreate.
//
// _compensateCreate deleted the scheduled event and the channel but never the
// database row, so every failure left a permanent ctfs row pointing at a
// channel and an event that had just been rolled back.
//
// These tests run against a real database to prove the row is now removed, that
// it is removed BEFORE the Discord objects, and that the helper stays tolerant
// of a missing id or a failing Discord delete.
//
// Note: the repository is deliberately NOT monkeypatched. Vitest's ESM interop
// hands out a wrapper object as `default`, which is a different object from the
// one `require('../database')` gives createctf.js, so property patches would be
// invisible to the command. Ordering is therefore observed through the real
// database state at the moment each Discord delete runs.

const repoRoot = process.cwd();

let tmpDir;
let conn;
let ctfOperations;
let CreateCTFCommand;

beforeAll(async () => {
	tmpDir = mkdtempSync(join(tmpdir(), 'ctfbot-compensate-'));
	const base = repoRoot;

	// Seed from the project database so the base schema and already-applied
	// migrations are present, then run the migrations that remain.
	copyFileSync(join(base, 'ctfbot.db'), join(tmpDir, 'ctfbot.db'));
	process.chdir(tmpDir);

	const { getConnection } = await import('../../src/database/connection.js');
	const { runMigrations } = await import('../../src/database/migrations.js');

	conn = getConnection();
	const result = runMigrations(conn, join(base, 'migrations'));
	expect(result.error).toBeNull();

	ctfOperations = (await import('../../src/database/repositories/ctf.repository.js')).default;
	({ CreateCTFCommand } = await import('../../src/commands/createctf.js'));
});

afterAll(() => {
	if (conn) {
		conn.close();
	}
	process.chdir(repoRoot);
	if (tmpDir) {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

/** Instantiate the command without running the Sapphire constructor. */
function makeCommand(logger = { info() {}, warn() {}, error() {} }) {
	const command = Object.create(CreateCTFCommand.prototype);
	// `container` is a getter on the Sapphire Piece prototype, so it has to be
	// shadowed with an own property rather than assigned.
	Object.defineProperty(command, 'container', { value: { logger }, writable: true, configurable: true });
	return command;
}

let channelCounter = 0;

/** Insert a real ctfs row and return its id. */
function seedCtf(overrides = {}) {
	channelCounter += 1;
	return ctfOperations.createCTF({
		guild_id: '111111111111111111',
		channel_id: `9000000000000000${String(channelCounter).padStart(2, '0')}`,
		event_id: `8000000000000000${String(channelCounter).padStart(2, '0')}`,
		ctf_name: 'K17 CTF 2026',
		ctf_base_url: 'https://k17ctf.secso.cc/',
		ctf_date: '2026-09-11T10:00:00.000Z',
		description: 'Join us for K17 CTF 2026!',
		banner_url: null,
		api_token: null,
		team_mode: 0,
		created_by: '333333333333333333',
		...overrides
	});
}

/**
 * Minimal stand-ins for the Discord objects _compensateCreate touches.
 * `observe` is called right before each delete resolves, so the caller can
 * inspect database state at that exact moment.
 */
function makeFakes({ observe } = {}) {
	const calls = [];
	const scheduledEvent = { id: '800000000000000099' };
	const ctfChannel = { id: '900000000000000099' };

	const interaction = {
		guild: {
			scheduledEvents: {
				delete: (id) => {
					calls.push('event');
					observe?.('event', id);
					return Promise.resolve();
				}
			}
		}
	};

	ctfChannel.delete = (reason) => {
		calls.push('channel');
		observe?.('channel', reason);
		return Promise.resolve();
	};

	return { interaction, ctfChannel, scheduledEvent, calls };
}

describe('createctf _compensateCreate database rollback', () => {
	it('deletes the persisted ctfs row so it cannot outlive the Discord objects', async () => {
		const id = seedCtf();
		expect(ctfOperations.getCTFById(id)).toBeTruthy();

		const command = makeCommand();
		const { interaction, ctfChannel, scheduledEvent } = makeFakes();

		await command._compensateCreate(interaction, ctfChannel, scheduledEvent, id);

		expect(ctfOperations.getCTFById(id)).toBeUndefined();
	});

	it('removes the database row before deleting the event and the channel', async () => {
		const id = seedCtf();
		const observations = [];

		const command = makeCommand();
		const { interaction, ctfChannel, scheduledEvent } = makeFakes({
			observe: (step) => {
				observations.push({ step, rowPresent: ctfOperations.getCTFById(id) !== undefined });
			}
		});

		await command._compensateCreate(interaction, ctfChannel, scheduledEvent, id);

		// The row was already gone by the time either Discord object was removed,
		// so the database can never outlive the objects it references.
		expect(observations).toEqual([
			{ step: 'event', rowPresent: false },
			{ step: 'channel', rowPresent: false }
		]);
		expect(ctfOperations.getCTFById(id)).toBeUndefined();
	});

	it('still deletes the event and the channel', async () => {
		const id = seedCtf();
		const command = makeCommand();
		const { interaction, ctfChannel, scheduledEvent, calls } = makeFakes();

		await command._compensateCreate(interaction, ctfChannel, scheduledEvent, id);

		expect(calls).toEqual(['event', 'channel']);
	});

	it('resolves when ctfId is null', async () => {
		const command = makeCommand();
		const { interaction, ctfChannel, scheduledEvent, calls } = makeFakes();

		await expect(
			command._compensateCreate(interaction, ctfChannel, scheduledEvent, null)
		).resolves.toBeUndefined();

		expect(calls).toEqual(['event', 'channel']);
	});

	it('resolves when ctfId is omitted entirely', async () => {
		const command = makeCommand();
		const { interaction, ctfChannel, scheduledEvent } = makeFakes();

		await expect(
			command._compensateCreate(interaction, ctfChannel, scheduledEvent)
		).resolves.toBeUndefined();
	});

	it('tolerates a failing Discord delete without masking the original failure', async () => {
		const id = seedCtf();
		const warnings = [];
		const command = makeCommand({ info() {}, warn: (m) => warnings.push(m), error() {} });
		const { interaction, ctfChannel, scheduledEvent } = makeFakes();

		interaction.guild.scheduledEvents.delete = () => Promise.reject(new Error('Unknown Event'));
		ctfChannel.delete = () => Promise.reject(new Error('Unknown Channel'));

		await expect(
			command._compensateCreate(interaction, ctfChannel, scheduledEvent, id)
		).resolves.toBeUndefined();

		// The row is still gone even though both Discord deletes failed.
		expect(ctfOperations.getCTFById(id)).toBeUndefined();
		expect(warnings).toHaveLength(2);
	});
});
