import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

// -- Strategy ---------------------------------------------------------------
// The real NoCTFClient runs with only the HTTP boundary faked, so every
// assertion observes what the client would actually put on the wire and what it
// would actually return to a command. No module mocking is involved, which
// matters because vitest's vi.mock cannot intercept plain CommonJS `require()`
// (documented in tests/unit/middleware/ensurePermission.test.js).
//
// The client rate limits itself to one request every 200ms, so tests shorten
// the interval; that is the only field they touch.

const require = createRequire(import.meta.url);
const { NoCTFClient, createNoCTFClient } = require('../../src/lib/noctf/index.js');
const { ExternalAPIError } = require('../../src/lib/errors/index.js');

const API_BASE = 'https://api-k17ctf.secso.cc';

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
			statusText: resolved && resolved.__statusText ? resolved.__statusText : (status < 300 ? 'OK' : 'Error'),
			json: async () => body,
			text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
		};
	});
	return calls;
}

/** A client whose rate limiter never sleeps, to keep the suite fast. */
function makeClient(token = null, options = {}) {
	const client = createNoCTFClient(API_BASE, token, options);
	client._minRequestInterval = 0;
	return client;
}

const CHALLENGE_ROUTE = '/challenges';
const CONFIG_ROUTE = '/site/config';
const DIVISIONS_ROUTE = '/divisions';

beforeEach(() => {
	// Silence the client's own warnings; the assertions are about behaviour.
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	delete globalThis.fetch;
});

describe('noCTF request plumbing', () => {
	it('sends the token as a Bearer authorization header', async () => {
		const calls = stubFetch([{ data: { ok: true } }]);

		await makeClient('  session-token  ').request('/healthz');

		expect(calls[0].headers.Authorization).toBe('Bearer session-token');
		expect(calls[0].url).toBe(`${API_BASE}/healthz`);
	});

	it('omits the authorization header when no token is configured', async () => {
		const calls = stubFetch([{ data: { ok: true } }]);

		await makeClient().request('/healthz');

		expect(calls[0].headers).not.toHaveProperty('Authorization');
	});

	it('unwraps the data envelope', async () => {
		stubFetch([{ data: { challenges: [] } }]);

		const result = await makeClient().request(CHALLENGE_ROUTE);

		expect(result).toEqual({ challenges: [] });
	});

	it('returns a bare body when there is no envelope', async () => {
		stubFetch([{ ok: true }]);

		const result = await makeClient().request('/healthz');

		expect(result).toEqual({ ok: true });
	});

	it('json encodes an object body and passes a string body through', async () => {
		const calls = stubFetch([{ data: null }, { data: null }]);

		await makeClient().request('/teams/query', { method: 'POST', body: { ids: [1, 2] } });
		await makeClient().request('/teams/query', { method: 'POST', body: '{"ids":[3]}' });

		expect(calls[0].body).toBe('{"ids":[1,2]}');
		expect(calls[1].body).toBe('{"ids":[3]}');
	});
});

describe('noCTF error handling', () => {
	it('retries transient 5xx responses and succeeds', async () => {
		const calls = stubFetch([
			{ __status: 503, __body: 'upstream down' },
			{ __status: 500, __body: 'still down' },
			{ data: { ok: true } }
		]);

		const result = await makeClient().request('/healthz');

		expect(result).toEqual({ ok: true });
		expect(calls).toHaveLength(3);
	});

	it('gives up after the retry budget and reports the status', async () => {
		const calls = stubFetch([
			{ __status: 500, __body: 'down' },
			{ __status: 500, __body: 'down' },
			{ __status: 500, __body: 'down' }
		]);

		await expect(makeClient().request('/healthz')).rejects.toBeInstanceOf(ExternalAPIError);
		expect(calls).toHaveLength(3);
	});

	it('does not retry a 4xx response', async () => {
		const calls = stubFetch([{ __status: 401, __body: { error: 'Unauthorized', message: 'Invalid token' } }]);

		await expect(makeClient().request(CHALLENGE_ROUTE)).rejects.toMatchObject({
			status: 401,
			message: expect.stringContaining('Invalid token')
		});
		expect(calls).toHaveLength(1);
	});

	it('flags the competition gate so callers can tell it apart from an outage', async () => {
		stubFetch([
			{
				__status: 403,
				__body: { error: 'Forbidden', message: 'The CTF is not currently active' }
			}
		]);

		await expect(makeClient().request(CHALLENGE_ROUTE)).rejects.toMatchObject({
			isGating: true,
			apiMessage: 'The CTF is not currently active'
		});
	});

	it('rejects a non-JSON body on a successful response', async () => {
		globalThis.fetch = vi.fn(async () => ({
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => {
				throw new Error('not json');
			},
			text: async () => '<html>proxy</html>'
		}));

		await expect(makeClient().request(CHALLENGE_ROUTE)).rejects.toThrow(/non-JSON response/);
	});

	it('wraps a transport failure in an ExternalAPIError', async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new Error('ECONNREFUSED');
		});

		await expect(makeClient().request(CHALLENGE_ROUTE)).rejects.toThrow(/noCTF request failed: ECONNREFUSED/);
	});
});

describe('noCTF challenge normalization', () => {
	it('derives the category from the first comma separated tag entry', async () => {
		stubFetch([
			{
				data: {
					challenges: [
						{ id: 3, slug: 'driveone', title: 'DriveOne', tags: { categories: 'web, pwn' }, value: 253 }
					]
				}
			}
		]);

		const [challenge] = await makeClient().getChallenges();

		expect(challenge).toEqual({
			id: 3,
			name: 'DriveOne',
			slug: 'driveone',
			category: 'web',
			points: 253
		});
	});

	it('falls back to uncategorized, the slug and zero', async () => {
		stubFetch([
			{ data: { challenges: [{ id: 9, slug: 'misc-one', tags: {}, value: null }] } }
		]);

		const [challenge] = await makeClient().getChallenges();

		expect(challenge.name).toBe('misc-one');
		expect(challenge.category).toBe('uncategorized');
		expect(challenge.points).toBe(0);
	});

	it('returns an empty list when the API reports none', async () => {
		stubFetch([{ data: {} }]);

		expect(await makeClient().getChallenges()).toEqual([]);
	});
});

describe('noCTF solve listing', () => {
	it('flattens scoreboard solves and keeps the per-user attribution', async () => {
		stubFetch([
			{
				data: {
					entries: [
						{
							team_id: 42,
							hidden: false,
							solves: [
								{ challenge_id: 3, user_id: 1875, created_at: '2026-01-01T00:00:00Z', value: 253 },
								{ challenge_id: 4, user_id: 1876, created_at: '2026-01-01T01:00:00Z', value: 262 }
							]
						}
					],
					total: 1,
					page_size: 100
				}
			}
		]);

		const solves = await makeClient(null, { divisionId: 2 }).getAllSolves();

		expect(solves).toEqual([
			{ challengeId: 3, teamId: 42, userId: 1875, solvedAt: '2026-01-01T00:00:00Z', value: 253 },
			{ challengeId: 4, teamId: 42, userId: 1876, solvedAt: '2026-01-01T01:00:00Z', value: 262 }
		]);
	});

	it('skips hidden entries and hidden solves', async () => {
		stubFetch([
			{
				data: {
					entries: [
						{ team_id: 1, hidden: true, solves: [{ challenge_id: 3, user_id: 1 }] },
						{
							team_id: 2,
							hidden: false,
							solves: [
								{ challenge_id: 3, user_id: 2, hidden: true },
								{ challenge_id: 3, user_id: 3, hidden: false }
							]
						}
					],
					total: 1,
					page_size: 100
				}
			}
		]);

		const solves = await makeClient(null, { divisionId: 2 }).getAllSolves();

		expect(solves).toHaveLength(1);
		expect(solves[0].userId).toBe(3);
	});

	it('paginates until the reported total is covered', async () => {
		const calls = stubFetch([
			{
				data: {
					entries: [
						{ team_id: 1, solves: [{ challenge_id: 1, user_id: 1 }] },
						{ team_id: 2, solves: [{ challenge_id: 1, user_id: 2 }] }
					],
					total: 3,
					page_size: 2
				}
			},
			{
				data: {
					entries: [{ team_id: 3, solves: [{ challenge_id: 2, user_id: 3 }] }],
					total: 3,
					page_size: 2
				}
			}
		]);

		const solves = await makeClient(null, { divisionId: 2, pageSize: 2 }).getAllSolves();

		expect(solves).toHaveLength(3);
		expect(calls.map(c => c.url)).toEqual([
			`${API_BASE}/scoreboard/divisions/2?page=1&page_size=2`,
			`${API_BASE}/scoreboard/divisions/2?page=2&page_size=2`
		]);
	});

	it('reports team-level rows only for a single challenge', async () => {
		const calls = stubFetch([
			{ data: [{ team_id: 42, created_at: '2026-01-01T00:00:00Z', value: 253 }] }
		]);

		const solves = await makeClient(null, { divisionId: 2 }).getChallengeSolves(3);

		expect(solves).toEqual([
			{ teamId: 42, userId: null, username: null, solvedAt: '2026-01-01T00:00:00Z', value: 253 }
		]);
		expect(calls[0].url).toBe(`${API_BASE}/challenges/3/solves?division_id=2`);
	});
});

describe('noCTF division resolution', () => {
	it('uses the configured division without asking the API', async () => {
		const calls = stubFetch([]);

		expect(await makeClient(null, { divisionId: 2 }).resolveDivisionId()).toBe(2);
		expect(calls).toHaveLength(0);
	});

	it('prefers the deployment default from site config', async () => {
		const calls = stubFetch([{ data: { default_division_id: 2 } }]);

		expect(await makeClient().resolveDivisionId()).toBe(2);
		expect(calls[0].url).toBe(`${API_BASE}${CONFIG_ROUTE}`);
	});

	it('falls back to the first visible division', async () => {
		stubFetch([
			{ data: {} },
			{ data: [{ id: 1, is_visible: false }, { id: 2, is_visible: true }] }
		]);

		expect(await makeClient().resolveDivisionId()).toBe(2);
	});

	it('falls back to division 1 without caching the guess', async () => {
		const calls = stubFetch([
			{ __status: 500, __body: 'down' },
			{ __status: 500, __body: 'down' },
			{ __status: 500, __body: 'down' },
			{ data: [] }
		]);

		const client = makeClient();

		expect(await client.resolveDivisionId()).toBe(1);
		expect(client._resolvedDivisionId).toBeNull();
		expect(calls.some(c => c.url.includes(DIVISIONS_ROUTE))).toBe(true);
	});
});

describe('noCTF user lookup', () => {
	it('prefers an exact case-insensitive match over the first result', async () => {
		stubFetch([
			{
				data: {
					entries: [
						{ id: 1, name: 'Maverick2', team_id: 42 },
						{ id: 2, name: 'maverick', team_id: 43 }
					]
				}
			},
			{ data: { entries: [{ id: 43, name: 'Rooster' }] } }
		]);

		const user = await makeClient(null, { divisionId: 2 }).findUser('Maverick');

		expect(user).toEqual({ userId: 2, username: 'maverick', teamName: 'Rooster', teamId: 43 });
	});

	it('throws a message that names the username when nothing matches', async () => {
		stubFetch([{ data: { entries: [] } }]);

		await expect(makeClient().findUser('ghost')).rejects.toThrow('User "ghost" not found');
	});

	it('reports a null team for an unassigned user', async () => {
		const calls = stubFetch([{ data: { entries: [{ id: 7, name: 'solo', team_id: null }] } }]);

		const user = await makeClient().findUser('solo');

		expect(user.teamName).toBeNull();
		expect(user.teamId).toBeNull();
		expect(calls).toHaveLength(1);
	});
});

describe('noCTF scoreboard', () => {
	it('maps rank and score, resolving team names in one query', async () => {
		const calls = stubFetch([
			{
				data: {
					entries: [
						{ team_id: 42, rank: 7, score: 253, hidden: false },
						{ team_id: 43, rank: 8, score: 200, hidden: false }
					],
					total: 2,
					page_size: 100
				}
			},
			{ data: { entries: [{ id: 42, name: 'Maverick' }, { id: 43, name: 'Rooster' }] } }
		]);

		const scoreboard = await makeClient(null, { divisionId: 2 }).getScoreboard();

		expect(scoreboard).toEqual([
			{ name: 'Maverick', pos: 7, score: 253 },
			{ name: 'Rooster', pos: 8, score: 200 }
		]);
		expect(calls[1].method).toBe('POST');
		expect(JSON.parse(calls[1].body)).toEqual({ ids: [42, 43], page_size: 2 });
	});

	it('keeps a placeholder name when the team lookup fails', async () => {
		stubFetch([
			{ data: { entries: [{ team_id: 99, rank: 1, score: 10, hidden: false }], total: 1, page_size: 100 } },
			{ __status: 500, __body: 'down' },
			{ __status: 500, __body: 'down' },
			{ __status: 500, __body: 'down' }
		]);

		const scoreboard = await makeClient(null, { divisionId: 2 }).getScoreboard();

		expect(scoreboard).toEqual([{ name: 'team-99', pos: 1, score: 10 }]);
	});

	it('drops hidden teams', async () => {
		stubFetch([
			{
				data: {
					entries: [
						{ team_id: 1, rank: 1, score: 10, hidden: true },
						{ team_id: 2, rank: 2, score: 5, hidden: false }
					],
					total: 2,
					page_size: 100
				}
			},
			{ data: { entries: [{ id: 2, name: 'Visible' }] } }
		]);

		const scoreboard = await makeClient(null, { divisionId: 2 }).getScoreboard();

		expect(scoreboard).toEqual([{ name: 'Visible', pos: 2, score: 5 }]);
	});
});

describe('noCTF connection probe', () => {
	it('reports the site state and the resolved division', async () => {
		stubFetch([
			{ data: { ok: true } },
			{ data: { active: true, start_time_s: 1767225600, end_time_s: 1767312000 } },
			{ data: { default_division_id: 2 } }
		]);

		const connection = await makeClient().testConnection();

		expect(connection).toEqual({
			ok: true,
			platform: 'noctf',
			apiBaseUrl: API_BASE,
			details: { active: true, startTime: 1767225600, endTime: 1767312000, divisionId: 2 }
		});
	});

	it('reports a failed probe without throwing', async () => {
		stubFetch([
			{ __status: 502, __body: 'bad gateway' },
			{ __status: 502, __body: 'bad gateway' },
			{ __status: 502, __body: 'bad gateway' },
			{ __status: 502, __body: 'bad gateway' },
			{ __status: 502, __body: 'bad gateway' },
			{ __status: 502, __body: 'bad gateway' },
			{ __status: 502, __body: 'bad gateway' },
			{ __status: 502, __body: 'bad gateway' },
			{ __status: 502, __body: 'bad gateway' }
		]);

		const connection = await makeClient(null, { divisionId: 2 }).testConnection();

		expect(connection.ok).toBe(false);
		expect(connection.details.divisionId).toBe(2);
	});
});

describe('noCTF client construction', () => {
	it('normalizes the base URL and exposes the platform id', () => {
		const client = createNoCTFClient('https://api-k17ctf.secso.cc/', null);

		expect(client.platform).toBe('noctf');
		expect(client.apiBaseUrl).toBe(API_BASE);
		expect(client).toBeInstanceOf(NoCTFClient);
	});
});
