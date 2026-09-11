import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';

// -- Strategy ---------------------------------------------------------------
// The registry is exercised for real. Only globalThis.fetch is faked, so the
// CTFd adapter tests observe the requests the real CTFdClient puts on the wire
// and the shapes the adapter returns to commands.
//
// The migration file is asserted on its text because that is the artifact the
// migration runner consumes; a mocked SQLite database would not catch a typo in
// the file the bot actually ships.

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();

const { listPlatforms, getPlatform, createPlatformClient, isKnownPlatform } =
	require('../../src/lib/platform/index.js');
const { PLATFORMS, DEFAULT_PLATFORM, PLATFORM_CHOICES } =
	require('../../src/lib/constants/platforms.js');
const { platformUserPrefix, syntheticUserId } =
	require('../../src/lib/platform/syntheticUser.js');

const CTFD_BASE = 'https://ctf.example.com';

/** A queued fetch stub. Each entry is a response body, or a function of the request. */
function stubFetch(responses) {
	const calls = [];
	const queue = [...responses];
	globalThis.fetch = vi.fn(async (url, options = {}) => {
		calls.push({ url: String(url), method: options.method || 'GET', headers: options.headers, body: options.body });
		if (queue.length === 0) {
			throw new Error(`Unexpected fetch: ${url}`);
		}
		const next = queue.shift();
		const resolved = typeof next === 'function' ? next(calls[calls.length - 1]) : next;
		const status = resolved && resolved.__status ? resolved.__status : 200;
		const body = resolved && resolved.__body !== undefined ? resolved.__body : resolved;
		return {
			ok: status >= 200 && status < 300,
			status,
			statusText: status < 300 ? 'OK' : 'Error',
			json: async () => body,
			text: async () => JSON.stringify(body)
		};
	});
	return calls;
}

/** A CTFd adapter whose inner client never rate limits. */
function makeCTFdAdapter(token = 'ctfd-token') {
	const adapter = createPlatformClient('ctfd', CTFD_BASE, token);
	adapter.raw._minRequestInterval = 0;
	return adapter;
}

beforeEach(() => {
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	delete globalThis.fetch;
});

describe('platform registry', () => {
	it('lists every registered platform', () => {
		expect(listPlatforms().map(p => p.id).sort()).toEqual(['ctfd', 'noctf']);
	});

	it('keeps ctfd as the default so pre-existing rows behave unchanged', () => {
		expect(DEFAULT_PLATFORM).toBe('ctfd');
		expect(isKnownPlatform(DEFAULT_PLATFORM)).toBe(true);
	});

	it('falls back to the default for an unknown, empty or missing id', () => {
		for (const id of ['mystery', '', null, undefined]) {
			expect(getPlatform(id).id).toBe(DEFAULT_PLATFORM);
		}
	});

	it('returns the matching definition for a known id', () => {
		expect(getPlatform('noctf').label).toBe('noCTF');
		expect(getPlatform('ctfd').label).toBe('CTFd');
	});

	it('offers one Discord choice per platform', () => {
		expect(PLATFORM_CHOICES.map(c => c.value).sort()).toEqual(Object.keys(PLATFORMS).sort());
		for (const choice of PLATFORM_CHOICES) {
			expect(choice.name).toContain(PLATFORMS[choice.value].label);
		}
	});

	it('refuses to build a client for an unknown platform', () => {
		expect(() => createPlatformClient('mystery', CTFD_BASE)).toThrow(/Unknown CTF platform "mystery"/);
	});

	it('names the registered platforms in the unknown-platform error', () => {
		expect(() => createPlatformClient('mystery', CTFD_BASE)).toThrow(/ctfd, noctf/);
	});

	it('builds a noCTF client with the configured origin and division', () => {
		const client = createPlatformClient('noctf', 'https://api.example.com/', 'token', { divisionId: 2 });

		expect(client.platform).toBe('noctf');
		expect(client.apiBaseUrl).toBe('https://api.example.com');
		expect(client.divisionId).toBe(2);
	});

	it('exposes the normalized client interface on every adapter', () => {
		const expected = [
			'platform',
			'apiBaseUrl',
			'getChallenges',
			'getChallengeSolves',
			'getAllSolves',
			'findUser',
			'getScoreboard',
			'resolveTeamName',
			'testConnection'
		];

		for (const id of Object.keys(PLATFORMS)) {
			const client = createPlatformClient(id, 'https://example.com', 'token');
			for (const member of expected) {
				expect(client, `${id} is missing ${member}`).toHaveProperty(member);
			}
			for (const method of expected.filter(m => m.startsWith('get') || m.startsWith('find') || m.startsWith('resolve') || m.startsWith('test'))) {
				expect(typeof client[method], `${id}.${method} is not callable`).toBe('function');
			}
		}
	});

	it('exposes the wrapped CTFd client through raw for the per-user sync path', () => {
		const ctfd = createPlatformClient('ctfd', CTFD_BASE, 'token');
		const noctf = createPlatformClient('noctf', 'https://api.example.com', 'token');

		expect(typeof ctfd.raw.getUserSolves).toBe('function');
		// noCTF has no wrapped client, so callers guard before reaching for raw.
		expect(noctf.raw).toBeUndefined();
	});
});

describe('synthetic user ids', () => {
	it('namespaces the prefix per platform', () => {
		expect(platformUserPrefix('ctfd')).toBe('ctfd');
		expect(platformUserPrefix('noctf')).toBe('noctf');
	});

	it('falls back to the default prefix for an unknown platform', () => {
		expect(platformUserPrefix('mystery')).toBe('ctfd');
		expect(platformUserPrefix(undefined)).toBe('ctfd');
	});

	it('formats a synthetic id as prefix:platformUserId', () => {
		expect(syntheticUserId('noctf', 1875)).toBe('noctf:1875');
		expect(syntheticUserId('ctfd', '42')).toBe('ctfd:42');
	});

	it('keeps the two platforms in separate namespaces', () => {
		expect(syntheticUserId('noctf', 7)).not.toBe(syntheticUserId('ctfd', 7));
	});
});

describe('CTFd adapter', () => {
	it('normalizes the challenge list', async () => {
		stubFetch([
			{
				success: true,
				data: [
					{ id: 1, name: 'Welcome', category: 'misc', value: 100 },
					{ id: 2, name: 'No category', value: null }
				]
			}
		]);

		const challenges = await makeCTFdAdapter().getChallenges();

		expect(challenges).toEqual([
			{ id: 1, name: 'Welcome', slug: '1', category: 'misc', points: 100 },
			{ id: 2, name: 'No category', slug: '2', category: 'uncategorized', points: 0 }
		]);
	});

	it('stringifies the solver user id and keeps the team id', async () => {
		stubFetch([
			{
				success: true,
				data: [{ user_id: 1875, team_id: 42, user: { name: 'maverick' }, date: '2026-01-01T00:00:00Z', value: 253 }],
				meta: {}
			}
		]);

		const solves = await makeCTFdAdapter().getChallengeSolves(3);

		expect(solves).toEqual([
			{ teamId: 42, userId: '1875', username: 'maverick', solvedAt: '2026-01-01T00:00:00Z', value: 253 }
		]);
	});

	it('rejects the bulk solve listing so the caller uses the per-user walk', async () => {
		stubFetch([]);

		await expect(makeCTFdAdapter().getAllSolves()).rejects.toThrow(/does not support bulk solve listing/);
	});

	it('sends the CTFd token scheme', async () => {
		const calls = stubFetch([{ success: true, data: [] }]);

		await makeCTFdAdapter('ctfd-token').getChallenges();

		expect(calls[0].headers.Authorization).toBe('Token ctfd-token');
	});

	it('normalizes the scoreboard and resolves a team name', async () => {
		stubFetch([
			{ success: true, data: [{ name: 'Maverick', pos: 7, score: 253 }], meta: {} },
			{ success: true, data: { id: 42, name: 'Maverick' } }
		]);

		const adapter = makeCTFdAdapter();

		expect(await adapter.getScoreboard()).toEqual([{ name: 'Maverick', pos: 7, score: 253 }]);
		expect(await adapter.resolveTeamName(42)).toBe('Maverick');
	});

	it('reports a connection probe with the platform id', async () => {
		globalThis.fetch = vi.fn(async () => ({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({ success: true, data: [] }),
			text: async () => ''
		}));

		const connection = await makeCTFdAdapter().testConnection();

		expect(connection.ok).toBe(true);
		expect(connection.platform).toBe('ctfd');
		expect(connection.apiBaseUrl).toBe(CTFD_BASE);
	});
});

describe('migration 025', () => {
	const file = join(repoRoot, 'migrations', '025_add_platform_to_ctfs.sql');

	it('exists', () => {
		expect(existsSync(file)).toBe(true);
	});

	it('adds exactly the three platform columns to ctfs', () => {
		const sql = readFileSync(file, 'utf8');
		const statements = sql
			.split('\n')
			.filter(line => line.trim().toUpperCase().startsWith('ALTER TABLE'))
			.map(line => line.trim());

		expect(statements).toEqual([
			'ALTER TABLE ctfs ADD COLUMN platform TEXT DEFAULT \'ctfd\';',
			'ALTER TABLE ctfs ADD COLUMN api_base_url TEXT;',
			'ALTER TABLE ctfs ADD COLUMN platform_division_id INTEGER;'
		]);
	});

	it('explains why the API base URL and the division exist', () => {
		const sql = readFileSync(file, 'utf8');

		expect(sql).toMatch(/different origin|separate host/i);
		expect(sql).toMatch(/division/i);
	});
});
