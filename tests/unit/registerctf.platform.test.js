import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, cpSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';
import { RegisterCTFCommand } from '../../src/commands/registerctf.js';

// -- Strategy ---------------------------------------------------------------
// The command is executed for real against the real platform registry and the
// real noCTF client; only the HTTP boundary is faked. vitest's vi.mock cannot
// intercept the plain CommonJS `require()` inside src/commands/registerctf.js
// (documented in tests/unit/middleware/ensurePermission.test.js), so a module
// mock would silently do nothing.
//
// The database is a real, isolated SQLite file in a temp directory, so the
// assertions read back the row the registration repository actually wrote
// rather than a spy's arguments.

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const tempDir = mkdtempSync(join(tmpdir(), 'ctfbot-registerctf-'));

const API_BASE = 'https://api-k17ctf.secso.cc';

/** URL-fragment keyed fetch stub. */
function stubFetch(routes) {
	const calls = [];
	globalThis.fetch = vi.fn(async url => {
		const target = String(url);
		calls.push(target);
		for (const [fragment, body] of Object.entries(routes)) {
			if (target.includes(fragment)) {
				return {
					ok: true,
					status: 200,
					statusText: 'OK',
					json: async () => body,
					text: async () => JSON.stringify(body)
				};
			}
		}
		throw new Error(`Unexpected fetch: ${target}`);
	});
	return calls;
}

function makeInteraction({ username = 'Maverick', teamName = null, channelId = 'chan-1' } = {}) {
	const edits = [];
	return {
		channelId,
		channel: { id: channelId, parentId: 'test-category-id', send: vi.fn(async () => ({})) },
		user: { id: 'discord-1', tag: 'player#0001' },
		member: { permissions: { has: () => true } },
		options: {
			getString: name => ({ username, team_name: teamName }[name] ?? null)
		},
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

function makeCommand(loggerOverrides = {}) {
	const command = Object.create(RegisterCTFCommand.prototype);
	Object.defineProperty(command, 'container', {
		value: {
			logger: {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				...loggerOverrides
			}
		},
		writable: true,
		configurable: true
	});
	return command;
}

let ctfOperations;
let registrationOperations;
let connection;

beforeAll(() => {
	cpSync(join(repoRoot, 'migrations'), join(tempDir, 'migrations'), { recursive: true });
	process.chdir(tempDir);
	connection = require('../../src/database/connection.js');
	connection.closeConnection();
	const { initDatabase } = require('../../src/database/index.js');
	initDatabase();
	const db = require('../../src/database/index.js');
	ctfOperations = db.ctfOperations;
	registrationOperations = db.registrationOperations;
});

afterAll(() => {
	connection.closeConnection();
	process.chdir(repoRoot);
	rmSync(tempDir, { recursive: true, force: true });
});

let counter = 0;

/** Insert a real ctfs row and return it. */
function seedCtf(overrides = {}) {
	counter += 1;
	const channelId = `chan-${counter}`;
	const id = ctfOperations.createCTF({
		guild_id: 'guild-1',
		channel_id: channelId,
		event_id: `event-${counter}`,
		ctf_name: `CTF ${counter}`,
		ctf_base_url: 'https://scoreboard.k17ctf.secso.cc',
		ctf_date: new Date(Date.now() + 86_400_000).toISOString(),
		description: 'test',
		banner_url: null,
		api_token: null,
		team_mode: 0,
		created_by: 'admin-1',
		...overrides
	});
	return ctfOperations.getCTFById(id);
}

beforeEach(() => {
	process.env.CTF_CATEGORY_ID = 'test-category-id';
	process.env.ADMIN_IDS = '999999999999999999';
});

afterEach(() => {
	delete process.env.ADMIN_IDS;
	vi.restoreAllMocks();
});

describe('/registerctf platform integration', () => {
	it('stores the platform user id and team name returned by the noCTF lookup', async () => {
		const ctf = seedCtf({
			platform: 'noctf',
			api_base_url: API_BASE,
			api_token: 'session-token'
		});

		stubFetch({
			'/users/query': { data: { entries: [{ id: 1875, name: 'Maverick', team_id: 869 }] } },
			'/teams/query': { data: { entries: [{ id: 869, name: 'w larp' }] } }
		});

		const interaction = makeInteraction({ username: 'Maverick', channelId: ctf.channel_id });

		await makeCommand().chatInputRun(interaction);

		const row = registrationOperations.getUserRegistration(ctf.id, 'discord-1');
		expect(row).toBeTruthy();
		expect(Number(row.ctfd_user_id)).toBe(1875);
		expect(row.ctfd_team_name).toBe('w larp');
		expect(row.team_name).toBe('w larp');
		expect(row.username).toBe('Maverick');
	});

	it('verifies against the CTFd adapter when the stored platform is ctfd', async () => {
		const ctf = seedCtf({
			platform: 'ctfd',
			api_base_url: null,
			api_token: 'ctfd-token'
		});

		stubFetch({
			'/api/v1/users': {
				success: true,
				data: [{ id: 42, name: 'alice', team_id: 7 }]
			},
			'/api/v1/teams/7': { success: true, data: { id: 7, name: 'Team Seven' } }
		});

		const interaction = makeInteraction({ username: 'alice', channelId: ctf.channel_id });

		await makeCommand().chatInputRun(interaction);

		const row = registrationOperations.getUserRegistration(ctf.id, 'discord-1');
		expect(row).toBeTruthy();
		expect(Number(row.ctfd_user_id)).toBe(42);
		expect(row.ctfd_team_name).toBe('Team Seven');
	});

	it('registers without verification when no API token is configured, and says so', async () => {
		const ctf = seedCtf({
			platform: 'noctf',
			api_base_url: API_BASE,
			api_token: null
		});

		const calls = stubFetch({});
		const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
		const interaction = makeInteraction({ username: 'Maverick', channelId: ctf.channel_id });

		await makeCommand(logger).chatInputRun(interaction);

		// No HTTP at all: there is nothing to verify against.
		expect(calls).toHaveLength(0);

		const row = registrationOperations.getUserRegistration(ctf.id, 'discord-1');
		expect(row).toBeTruthy();
		expect(row.ctfd_user_id).toBeNull();
		expect(row.ctfd_team_name).toBeNull();

		const logged = logger.info.mock.calls.map(args => String(args[0])).join('\n');
		expect(logged).toMatch(/Skipping platform verification/);
	});

	it('reports a verification failure instead of writing a registration', async () => {
		const ctf = seedCtf({
			platform: 'noctf',
			api_base_url: API_BASE,
			api_token: 'session-token'
		});

		stubFetch({ '/users/query': { data: { entries: [] } } });

		const interaction = makeInteraction({ username: 'nobody', channelId: ctf.channel_id });

		await makeCommand().chatInputRun(interaction);

		expect(registrationOperations.getUserRegistration(ctf.id, 'discord-1')).toBeUndefined();
		const payload = JSON.stringify(interaction.edits);
		expect(payload).toMatch(/Failed to verify user on the CTF platform/);
		expect(payload).toMatch(/not found/i);
	});

	it('exposes platform_url and no longer exposes ctfd_url', async () => {
		const { readFileSync } = await import('fs');
		const source = readFileSync(join(repoRoot, 'src/commands/registerctf.js'), 'utf8');
		expect(source).toMatch(/setName\('platform_url'\)/);
		expect(source).not.toMatch(/setName\('ctfd_url'\)/);
		expect(source).not.toContain('CTFdClient');
		expect(source).not.toContain('fetchCTFdUserData');
		expect(source).toContain('createPlatformClient(ctf.platform');
	});
});
