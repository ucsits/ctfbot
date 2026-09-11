import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, cpSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';
import SyncChallengesCommand from '../../src/commands/syncchallenges.js';
import { RegisterCTFCommand } from '../../src/commands/registerctf.js';

// -- Strategy ---------------------------------------------------------------
// This suite runs the two commands that have to agree about solve ownership,
// end to end, against a real SQLite database and the real noCTF client. Only
// globalThis.fetch is faked.
//
// The scenario is the one that motivated per-platform synthetic user ids: a
// player solves a challenge before running /registerctf, so the sync has nobody
// to attribute the solve to. The solve is parked under noctf:<platform user
// id>, and /registerctf has to claim exactly that row once the player registers.
// If the two commands disagreed about the prefix, the row would stay orphaned
// and the player would lose the solve.
//
// vitest's vi.mock cannot intercept the plain CommonJS `require()` inside the
// commands (documented in tests/unit/middleware/ensurePermission.test.js), so a
// module mock would silently do nothing.

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const tempDir = mkdtempSync(join(tmpdir(), 'ctfbot-noctf-e2e-'));

const API_BASE = 'https://api-k17ctf.secso.cc';
const PLATFORM_USER_ID = 1875;
const CHALLENGE_TITLE = 'DriveOne';

/** routes: Array<[string|RegExp, body|fn]>; first match wins. */
function stubFetch(routes) {
	const calls = [];
	globalThis.fetch = vi.fn(async (url, options = {}) => {
		const target = String(url);
		calls.push({ url: target, method: options.method || 'GET', body: options.body });
		for (const [matcher, body] of routes) {
			const hit = typeof matcher === 'string' ? target.includes(matcher) : matcher.test(target);
			if (hit) {
				const resolved = typeof body === 'function' ? body(target) : body;
				const status = resolved && resolved.__status ? resolved.__status : 200;
				return {
					ok: status < 300,
					status,
					statusText: status < 300 ? 'OK' : 'Error',
					json: async () => resolved,
					text: async () => JSON.stringify(resolved)
				};
			}
		}
		throw new Error(`Unexpected fetch: ${target}`);
	});
	return calls;
}

/** The scoreboard payload that makes a solve visible for one platform user. */
function scoreboardWithSolve() {
	return {
		data: {
			entries: [
				{
					team_id: 869,
					rank: 1,
					score: 500,
					hidden: false,
					solves: [
						{
							user_id: PLATFORM_USER_ID,
							challenge_id: 12,
							hidden: false,
							value: 500,
							created_at: '2026-09-11T10:41:28.840Z'
						}
					]
				}
			],
			page_size: 100,
			total: 1
		}
	};
}

function challengesPayload() {
	return {
		data: {
			challenges: [
				{ id: 12, slug: 'driveone', title: CHALLENGE_TITLE, tags: { categories: 'web' }, value: 500 }
			]
		}
	};
}

function makeSyncInteraction(source) {
	const edits = [];
	return {
		channelId: null,
		user: { id: 'operator-1', tag: 'operator#0001' },
		options: { getString: () => source },
		deferReply: async () => {},
		editReply: async payload => {
			edits.push(payload);
			return payload;
		},
		edits
	};
}

function makeRegisterInteraction(username, teamName = 'w larp') {
	const edits = [];
	const announcements = [];
	return {
		channelId: null,
		channel: {
			id: 'e2e-chan',
			parentId: 'test-category-id',
			send: async payload => {
				announcements.push(payload);
				return payload;
			}
		},
		user: { id: 'discord-1', tag: 'player#0001' },
		member: { permissions: { has: () => true } },
		options: {
			getString: name => ({ username, team_name: teamName, platform_url: null }[name] ?? null)
		},
		deferReply: async () => {},
		editReply: async payload => {
			edits.push(payload);
			return payload;
		},
		edits,
		announcements
	};
}

function makeCommand(CommandClass) {
	const command = Object.create(CommandClass.prototype);
	Object.defineProperty(command, 'container', {
		value: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
		writable: true,
		configurable: true
	});
	return command;
}

let ctfOperations;
let registrationOperations;
let challengeOperations;
let connection;

beforeAll(() => {
	cpSync(join(repoRoot, 'migrations'), join(tempDir, 'migrations'), { recursive: true });
	process.chdir(tempDir);
	connection = require('../../src/database/connection.js');
	connection.closeConnection();
	const db = require('../../src/database/index.js');
	db.initDatabase();
	ctfOperations = db.ctfOperations;
	registrationOperations = db.registrationOperations;
	challengeOperations = db.challengeOperations;
});

afterAll(() => {
	connection.closeConnection();
	process.chdir(repoRoot);
	rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
	process.env.CTF_CATEGORY_ID = 'test-category-id';
	process.env.ADMIN_IDS = '900000000000000999';
});

afterEach(() => {
	vi.restoreAllMocks();
	delete globalThis.fetch;
});

function seedNoCTFCtf() {
	const channelId = `e2e-chan-${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
	const id = ctfOperations.createCTF({
		guild_id: 'guild-1',
		channel_id: channelId,
		event_id: `e2e-event-${channelId}`,
		ctf_name: 'K17 CTF',
		ctf_base_url: 'https://scoreboard.k17ctf.secso.cc',
		ctf_date: new Date(Date.now() + 86_400_000).toISOString(),
		description: 'test',
		banner_url: null,
		api_token: null,
		team_mode: 1,
		created_by: 'admin-1'
	});

	ctfOperations.setCTFPlatform(channelId, {
		platform: 'noctf',
		apiBaseUrl: API_BASE,
		apiToken: 'session-token',
		divisionId: 2
	});

	return ctfOperations.getCTFById(id);
}

/**
 * Register a linked teammate, which is what puts their team in the sync's scope.
 *
 * The bulk solve listing is division-wide, so the sync only records solves from
 * teams the channel already has registrations for. Their platform user id never
 * appears in the stubbed scoreboard, so they never own the solve under test.
 */
function seedTeammate(ctf, { userId, username, platformUserId, teamName }) {
	registrationOperations.registerUser({
		ctf_id: ctf.id,
		user_id: userId,
		username,
		team_name: teamName,
		ctfd_user_id: String(platformUserId),
		ctfd_team_name: teamName
	});
}

describe('noCTF end to end: sync then register', () => {
	it('parks an unregistered solve under noctf: and lets /registerctf claim it', async () => {
		const ctf = seedNoCTFCtf();
		// The sync is scoped to the teams this channel has registrations for, so a
		// teammate is registered up front. Their solve is never in the scoreboard
		// below, which leaves the parked solve to be claimed by /registerctf.
		seedTeammate(ctf, { userId: 'discord-teammate', username: 'Teammate', platformUserId: 1481, teamName: 'w larp' });

		// 1. Sync before the solver registers. The bulk listing is the only source
		//    that attributes the solve to a user, so that is the path under test.
		//    The name lookup is what lets the report name the solver rather than
		//    print their numeric platform id.
		stubFetch([
			['/scoreboard/divisions/2', scoreboardWithSolve()],
			['/teams/query', { data: { entries: [{ id: 869, name: 'w larp' }] } }],
			['/users/query', { data: { entries: [{ id: PLATFORM_USER_ID, name: 'Maverick', team_id: 869 }] } }],
			['/challenges', challengesPayload()]
		]);

		const syncInteraction = makeSyncInteraction('users');
		syncInteraction.channelId = ctf.channel_id;
		await makeCommand(SyncChallengesCommand).chatInputRun(syncInteraction);

		const challenge = challengeOperations.getChallengeByName(ctf.id, CHALLENGE_TITLE);
		expect(challenge).toBeTruthy();

		const parked = challengeOperations.getChallengeSolvers(challenge.id);
		expect(parked).toHaveLength(1);
		expect(parked[0].user_id).toBe(`noctf:${PLATFORM_USER_ID}`);
		expect(String(syncInteraction.edits[syncInteraction.edits.length - 1])).toContain('Maverick (unregistered)');
		expect(registrationOperations.getUserRegistration(ctf.id, 'discord-1')).toBeFalsy();

		// 2. The player registers. The lookup has to return the same platform
		//    user id the sync parked the solve under.
		stubFetch([
			[
				'/users/query',
				{ data: { entries: [{ id: PLATFORM_USER_ID, name: 'Maverick', team_id: 869 }] } }
			],
			['/teams/query', { data: { entries: [{ id: 869, name: 'w larp' }] } }]
		]);

		const registerInteraction = makeRegisterInteraction('Maverick');
		registerInteraction.channelId = ctf.channel_id;
		registerInteraction.channel.id = ctf.channel_id;
		await makeCommand(RegisterCTFCommand).chatInputRun(registerInteraction);

		// 3. The solve now belongs to the Discord user, and nothing is left
		//    parked under the synthetic id.
		const claimed = challengeOperations.getChallengeSolvers(challenge.id);
		expect(claimed).toHaveLength(1);
		expect(claimed[0].user_id).toBe('discord-1');
		expect(challengeOperations.hasCtfdUserSolved(challenge.id, PLATFORM_USER_ID, 'noctf')).toBeFalsy();

		const registration = registrationOperations.getUserRegistration(ctf.id, 'discord-1');
		// SQLite stores the id with TEXT affinity, so it can come back as '1875.0'.
		// Every lookup normalises through parseInt, which is why that is asserted
		// rather than the raw string.
		expect(parseInt(registration.ctfd_user_id, 10)).toBe(PLATFORM_USER_ID);
		expect(registration.ctfd_team_name).toBe('w larp');

		const embed = registerInteraction.edits[registerInteraction.edits.length - 1].embeds[0];
		expect(embed.data.fields.map(f => f.name)).toContain('Solves Claimed');
	});

	it('does not let a CTFd registration claim a noCTF parked solve', async () => {
		const ctf = seedNoCTFCtf();
		seedTeammate(ctf, { userId: 'discord-teammate', username: 'Teammate', platformUserId: 1481, teamName: 'w larp' });

		stubFetch([
			['/scoreboard/divisions/2', scoreboardWithSolve()],
			['/teams/query', { data: { entries: [{ id: 869, name: 'w larp' }] } }],
			['/users/query', { data: { entries: [{ id: PLATFORM_USER_ID, name: 'Maverick', team_id: 869 }] } }],
			['/challenges', challengesPayload()]
		]);

		const syncInteraction = makeSyncInteraction('users');
		syncInteraction.channelId = ctf.channel_id;
		await makeCommand(SyncChallengesCommand).chatInputRun(syncInteraction);

		const challenge = challengeOperations.getChallengeByName(ctf.id, CHALLENGE_TITLE);

		// Same numeric platform user id, but the CTF is now bound to CTFd. The
		// prefixes differ, so the pending noCTF row must survive untouched.
		ctfOperations.setCTFPlatform(ctf.channel_id, { platform: 'ctfd' });

		const transfer = challengeOperations.transferPendingSolves(
			ctf.id,
			PLATFORM_USER_ID,
			'discord-2',
			'ctfd'
		);

		expect(transfer.transferred).toBe(0);
		const solves = challengeOperations.getChallengeSolvers(challenge.id);
		expect(solves).toHaveLength(1);
		expect(solves[0].user_id).toBe(`noctf:${PLATFORM_USER_ID}`);
	});
});
