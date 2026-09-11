import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, cpSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';
import SyncChallengesCommand from '../../src/commands/syncchallenges.js';

// -- Strategy ---------------------------------------------------------------
// The real command runs against the real platform registry and the real noCTF /
// CTFd clients; only the HTTP boundary is faked. vitest's vi.mock cannot
// intercept the plain CommonJS `require()` inside src/commands/syncchallenges.js
// (documented in tests/unit/middleware/ensurePermission.test.js).
//
// The database is a real, isolated SQLite file in a temp directory, so the
// assertions read the rows the repositories actually wrote: the synthetic user
// id prefix, the team_key, and the one-solve-per-team skip are all observable
// there and nowhere else.

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const tempDir = mkdtempSync(join(tmpdir(), 'ctfbot-sync-'));

const API_BASE = 'https://api-k17ctf.secso.cc';

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

function makeInteraction({ source = null } = {}) {
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
		reply: async payload => {
			edits.push(payload);
			return payload;
		},
		edits
	};
}

function makeCommand() {
	const command = Object.create(SyncChallengesCommand.prototype);
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

let counter = 0;

function seedCtf(overrides = {}) {
	counter += 1;
	const channelId = `sync-chan-${counter}`;
	const id = ctfOperations.createCTF({
		guild_id: 'guild-1',
		channel_id: channelId,
		event_id: `sync-event-${counter}`,
		ctf_name: `Sync CTF ${counter}`,
		ctf_base_url: 'https://scoreboard.k17ctf.secso.cc',
		ctf_date: new Date(Date.now() + 86_400_000).toISOString(),
		description: 'test',
		banner_url: null,
		api_token: 'token',
		team_mode: 0,
		created_by: 'admin-1',
		...overrides
	});
	return ctfOperations.getCTFById(id);
}

function seedRegistration(ctf, { userId, username, teamName = null, platformUserId = null }) {
	registrationOperations.registerUser({
		ctf_id: ctf.id,
		user_id: userId,
		username,
		team_name: teamName,
		ctfd_user_id: platformUserId,
		ctfd_team_name: teamName
	});
}

/** Run the command for a seeded CTF and return { interaction, command }. */
async function runSync(ctf, source = null) {
	const interaction = makeInteraction({ source });
	interaction.channelId = ctf.channel_id;
	const command = makeCommand();
	await command.chatInputRun(interaction);
	return { interaction, command };
}

function lastReply(interaction) {
	return interaction.edits[interaction.edits.length - 1];
}

beforeEach(() => {
	process.env.CTF_CATEGORY_ID = 'test-category-id';
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('/syncchallenges noCTF integration', () => {
	it('upserts challenges using the normalized category and points', async () => {
		const ctf = seedCtf({ platform: 'noctf', api_base_url: API_BASE, platform_division_id: 2 });

		stubFetch([
			['/challenges/12/solves', { data: [] }],
			['/challenges', {
				data: {
					challenges: [
						{ id: 12, slug: 'driveone', title: 'DriveOne', tags: { categories: 'beginner,web', difficulty: 'hard' }, value: 500 },
						{ id: 13, slug: 'notags', title: 'NoTags', tags: {}, value: 0 }
					]
				}
			}]
		]);

		await runSync(ctf, 'direct');

		const first = challengeOperations.getChallengeByName(ctf.id, 'DriveOne');
		expect(first).toBeTruthy();
		// tags.categories is 'beginner,web': the first entry is the category.
		expect(first.chal_category).toBe('beginner');
		expect(first.points).toBe(500);

		const second = challengeOperations.getChallengeByName(ctf.id, 'NoTags');
		expect(second.chal_category).toBe('uncategorized');
		expect(second.points).toBe(0);
	});

	it('attributes a team-level noCTF solve to a registered member with the team key', async () => {
		const ctf = seedCtf({
			platform: 'noctf',
			api_base_url: API_BASE,
			platform_division_id: 2,
			team_mode: 1
		});
		seedRegistration(ctf, { userId: 'discord-a', username: 'Aiden', teamName: 'w larp', platformUserId: '1481' });
		seedRegistration(ctf, { userId: 'discord-b', username: 'Maverick', teamName: 'w larp', platformUserId: '1875' });

		const calls = stubFetch([
			['/challenges/12/solves', {
				data: [
					{ team_id: 869, created_at: '2026-09-11T10:41:28.840Z', value: 500 },
					{ team_id: 999, created_at: '2026-09-11T10:42:00.000Z', value: 500 }
				]
			}],
			['/teams/query', { data: { entries: [{ id: 869, name: 'w larp' }] } }],
			['/challenges', {
				data: { challenges: [{ id: 12, slug: 'driveone', title: 'DriveOne', tags: { categories: 'web' }, value: 500 }] }
			}]
		]);

		const { interaction } = await runSync(ctf, 'direct');

		// The team-level solve carries only a team id, so the command has to ask
		// the platform for the team name before it can match a registration.
		const teamQuery = calls.find(c => c.url.includes('/teams/query'));
		expect(teamQuery).toBeTruthy();
		expect(JSON.parse(teamQuery.body).ids).toEqual([869]);

		const challenge = challengeOperations.getChallengeByName(ctf.id, 'DriveOne');
		const solves = challengeOperations.getChallengeSolvers(challenge.id);
		expect(solves).toHaveLength(1);
		expect(solves[0].user_id).toBe('discord-a');
		expect(solves[0].team_key).toBe('w larp');
		expect(String(lastReply(interaction))).toMatch(/New solves recorded: 1/);
	});

	it('skips a second solve for a team that is already recorded', async () => {
		const ctf = seedCtf({
			platform: 'noctf',
			api_base_url: API_BASE,
			platform_division_id: 2,
			team_mode: 1
		});
		seedRegistration(ctf, { userId: 'discord-a', username: 'Aiden', teamName: 'w larp', platformUserId: '1481' });
		seedRegistration(ctf, { userId: 'discord-b', username: 'Maverick', teamName: 'w larp', platformUserId: '1875' });

		stubFetch([
			['/challenges/12/solves', { data: [{ team_id: 869, created_at: '2026-09-11T10:41:28.840Z', value: 500 }] }],
			['/teams/query', { data: { entries: [{ id: 869, name: 'w larp' }] } }],
			['/challenges', {
				data: { challenges: [{ id: 12, slug: 'driveone', title: 'DriveOne', tags: { categories: 'web' }, value: 500 }] }
			}]
		]);

		const first = await runSync(ctf, 'direct');
		const second = await runSync(ctf, 'direct');

		const challenge = challengeOperations.getChallengeByName(ctf.id, 'DriveOne');
		expect(challengeOperations.getChallengeSolvers(challenge.id)).toHaveLength(1);
		expect(String(lastReply(first.interaction))).toMatch(/New solves recorded: 1/);
		expect(String(lastReply(second.interaction))).toMatch(/New solves recorded: 0/);
	});

	it('uses the bulk listing for the users source when the platform supports it', async () => {
		const ctf = seedCtf({ platform: 'noctf', api_base_url: API_BASE, platform_division_id: 2 });
		seedRegistration(ctf, { userId: 'discord-a', username: 'Maverick', platformUserId: '1875' });

		const calls = stubFetch([
			['/scoreboard/divisions/2', {
				data: {
					entries: [
						{
							team_id: 869,
							rank: 1,
							score: 500,
							hidden: false,
							solves: [{ user_id: 1875, challenge_id: 12, hidden: false, value: 500, created_at: '2026-09-11T10:41:28.840Z' }]
						}
					],
					page_size: 100,
					total: 1
				}
			}],
			['/challenges', {
				data: { challenges: [{ id: 12, slug: 'driveone', title: 'DriveOne', tags: { categories: 'web' }, value: 500 }] }
			}]
		]);

		const { interaction } = await runSync(ctf, 'users');

		expect(calls.some(c => c.url.includes('/scoreboard/divisions/2'))).toBe(true);
		// The bulk path never needs the per-user endpoint.
		expect(calls.some(c => c.url.includes('/api/v1/'))).toBe(false);

		const challenge = challengeOperations.getChallengeByName(ctf.id, 'DriveOne');
		const solves = challengeOperations.getChallengeSolvers(challenge.id);
		expect(solves).toHaveLength(1);
		expect(solves[0].user_id).toBe('discord-a');
		expect(String(lastReply(interaction))).toMatch(/New solves recorded: 1/);
	});

	it('falls back to the per-user path when the platform has no bulk listing', async () => {
		const ctf = seedCtf({ platform: 'ctfd', api_base_url: null, api_token: 'ctfd-token' });
		seedRegistration(ctf, { userId: 'discord-a', username: 'alice', platformUserId: '42' });

		const calls = stubFetch([
			['/api/v1/challenges/1/solves', { success: true, data: [] }],
			['/api/v1/challenges', { success: true, data: [{ id: 1, name: 'DriveOne', category: 'web', value: 500 }] }],
			['/api/v1/users/42/solves', {
				success: true,
				data: [{ type: 'correct', date: '2026-09-11T10:41:28.840Z', challenge: { name: 'DriveOne', category: 'web', value: 500 } }]
			}]
		]);

		const { interaction } = await runSync(ctf, 'users');

		// CTFd's adapter rejects getAllSolves, so the per-user endpoint is used.
		expect(calls.some(c => c.url.includes('/api/v1/users/42/solves'))).toBe(true);
		expect(calls.some(c => c.url.includes('/scoreboard/'))).toBe(false);

		const challenge = challengeOperations.getChallengeByName(ctf.id, 'DriveOne');
		const solves = challengeOperations.getChallengeSolvers(challenge.id);
		expect(solves).toHaveLength(1);
		expect(solves[0].user_id).toBe('discord-a');
		expect(String(lastReply(interaction))).toMatch(/New solves recorded: 1/);
	});

	it('parks an unregistered noCTF solve under the noctf: prefix', async () => {
		const ctf = seedCtf({ platform: 'noctf', api_base_url: API_BASE, platform_division_id: 2 });

		stubFetch([
			['/scoreboard/divisions/2', {
				data: {
					entries: [
						{
							team_id: 869,
							rank: 1,
							score: 500,
							hidden: false,
							solves: [{ user_id: 1875, challenge_id: 12, hidden: false, value: 500, created_at: '2026-09-11T10:41:28.840Z' }]
						}
					],
					page_size: 100,
					total: 1
				}
			}],
			['/challenges', {
				data: { challenges: [{ id: 12, slug: 'driveone', title: 'DriveOne', tags: { categories: 'web' }, value: 500 }] }
			}]
		]);

		await runSync(ctf, 'users');

		const challenge = challengeOperations.getChallengeByName(ctf.id, 'DriveOne');
		const solves = challengeOperations.getChallengeSolvers(challenge.id);
		expect(solves).toHaveLength(1);
		expect(solves[0].user_id).toBe('noctf:1875');
	});

	it('keeps the ctfd: prefix for unregistered CTFd solves', async () => {
		const ctf = seedCtf({ platform: 'ctfd', api_base_url: null, api_token: 'ctfd-token' });

		stubFetch([
			['/api/v1/challenges/1/solves', {
				success: true,
				data: [{ user_id: 99, user: { name: 'ghost' }, date: '2026-09-11T10:41:28.840Z', value: 500 }]
			}],
			['/api/v1/challenges', { success: true, data: [{ id: 1, name: 'DriveOne', category: 'web', value: 500 }] }]
		]);

		await runSync(ctf, 'direct');

		const challenge = challengeOperations.getChallengeByName(ctf.id, 'DriveOne');
		const solves = challengeOperations.getChallengeSolvers(challenge.id);
		expect(solves).toHaveLength(1);
		expect(solves[0].user_id).toBe('ctfd:99');
		expect(solves[0].ctfd_username).toBe('ghost');
	});

	it('refuses to sync when no platform credential is configured', async () => {
		const ctf = seedCtf({ platform: 'noctf', api_base_url: API_BASE, api_token: null });
		const calls = stubFetch([]);

		const { interaction } = await runSync(ctf, 'direct');

		expect(calls).toHaveLength(0);
		expect(String(lastReply(interaction))).toMatch(/not configured/i);
		expect(String(lastReply(interaction))).toMatch(/setctfplatform/);
	});

	it('no longer references the CTFd client factory', async () => {
		const { readFileSync } = await import('fs');
		const source = readFileSync(join(repoRoot, 'src/commands/syncchallenges.js'), 'utf8');
		expect(source).not.toContain('createCTFdClient');
		expect(source).toContain('createPlatformClient(');
		expect(source).toContain('ctf.platform');
	});
});
