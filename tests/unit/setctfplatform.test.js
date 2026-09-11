import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SetCTFPlatformCommand } from '../../src/commands/setctfplatform.js';
import { ctfOperations } from '../../src/database/index.js';

// -- Strategy ---------------------------------------------------------------
// These tests execute the real command, through the real platform registry and
// the real noCTF client, with only the network boundary faked. That matters
// because vitest's vi.mock cannot intercept the plain CommonJS `require()` calls
// inside src/commands/setctfplatform.js (the same limitation documented in
// tests/unit/middleware/ensurePermission.test.js), so a module-level mock would
// silently do nothing and the test would pass while exercising nothing.
//
// ctfOperations is stubbed by replacing properties on the shared module object,
// which works because the command reads `ctfOperations.x` at call time rather
// than destructuring the individual functions.
//
// ADMIN_IDS is pointed at an unrelated id so isAdmin short-circuits without
// opening a database.

const CHANNEL_ID = '900000000000000001';

function makeCtf(overrides = {}) {
	return {
		id: 1,
		channel_id: CHANNEL_ID,
		ctf_name: 'K17 CTF 2026',
		ctf_base_url: 'https://scoreboard.k17ctf.secso.cc',
		platform: 'ctfd',
		api_base_url: null,
		api_token: null,
		platform_division_id: null,
		...overrides
	};
}

/** A fetch stub keyed by URL fragment. */
function stubFetch(routes) {
	const calls = [];
	globalThis.fetch = vi.fn(async (url, options = {}) => {
		const target = String(url);
		calls.push({ url: target, method: options.method || 'GET', body: options.body });
		for (const [fragment, respond] of Object.entries(routes)) {
			if (target.includes(fragment)) {
				const body = typeof respond === 'function' ? respond(target) : respond;
				const status = body.__status || 200;
				return {
					ok: status >= 200 && status < 300,
					status,
					statusText: status === 200 ? 'OK' : 'Error',
					json: async () => body,
					text: async () => JSON.stringify(body)
				};
			}
		}
		throw new Error(`Unexpected fetch: ${target}`);
	});
	return calls;
}

const NOCTF_ROUTES = {
	'/healthz': { status: 'OK' },
	'/site/config': {
		data: {
			active: true,
			start_time_s: 1789120800,
			end_time_s: 1789207200,
			default_division_id: 2
		}
	}
};

function makeInteraction({ platform = null, apiBaseUrl = null, apiToken = null, divisionId = null, show = false } = {}) {
	const edits = [];
	const replies = [];
	return {
		channelId: CHANNEL_ID,
		channel: { parentId: 'test-category-id' },
		user: { id: 'u1', tag: 'operator#0001' },
		member: { permissions: { has: () => true } },
		options: {
			getString: name => ({ platform, api_base_url: apiBaseUrl, api_token: apiToken }[name] ?? null),
			getInteger: () => divisionId,
			getBoolean: () => show
		},
		deferReply: async () => {},
		editReply: async payload => {
			edits.push(payload);
			return payload;
		},
		reply: async payload => {
			replies.push(payload);
			return payload;
		},
		edits,
		replies
	};
}

function makeCommand() {
	const command = Object.create(SetCTFPlatformCommand.prototype);
	Object.defineProperty(command, 'container', {
		value: { logger: { info() {}, warn() {}, error() {} } },
		writable: true,
		configurable: true
	});
	return command;
}

const original = {
	getCTFByChannelId: ctfOperations.getCTFByChannelId,
	setCTFPlatform: ctfOperations.setCTFPlatform
};

let setPlatformSpy;

beforeEach(() => {
	process.env.CTF_CATEGORY_ID = 'test-category-id';
	process.env.ADMIN_IDS = '999999999999999999';
	ctfOperations.getCTFByChannelId = vi.fn().mockReturnValue(makeCtf());
	setPlatformSpy = vi.fn().mockReturnValue(1);
	ctfOperations.setCTFPlatform = setPlatformSpy;
});

afterEach(() => {
	ctfOperations.getCTFByChannelId = original.getCTFByChannelId;
	ctfOperations.setCTFPlatform = original.setCTFPlatform;
	delete process.env.ADMIN_IDS;
	vi.restoreAllMocks();
});

describe('/setctfplatform', () => {
	it('reports an error and writes nothing when the channel is not a CTF channel', async () => {
		ctfOperations.getCTFByChannelId = vi.fn().mockReturnValue(undefined);
		const interaction = makeInteraction({ platform: 'noctf' });

		await makeCommand().chatInputRun(interaction);

		expect(setPlatformSpy).not.toHaveBeenCalled();
		expect(interaction.edits).toHaveLength(1);
		expect(interaction.edits[0]).toMatch(/not registered as a CTF channel/i);
	});

	it('persists the selected platform, the resolved API base URL and the division', async () => {
		const calls = stubFetch(NOCTF_ROUTES);
		const interaction = makeInteraction({
			platform: 'noctf',
			apiBaseUrl: 'https://api-k17ctf.secso.cc',
			apiToken: 'session-token-value',
			divisionId: 5
		});

		await makeCommand().chatInputRun(interaction);

		expect(setPlatformSpy).toHaveBeenCalledTimes(1);
		expect(setPlatformSpy).toHaveBeenCalledWith(CHANNEL_ID, {
			platform: 'noctf',
			apiBaseUrl: 'https://api-k17ctf.secso.cc',
			apiToken: 'session-token-value',
			divisionId: 5
		});

		// The probe really ran against the chosen platform.
		expect(calls.some(c => c.url.includes('/healthz'))).toBe(true);
		expect(interaction.edits[0].embeds[0].data.title).toBe('CTF Platform Updated');
	});

	it('defaults the API base URL to the CTF URL when none is supplied', async () => {
		stubFetch({ '/api/v1/': { success: true, data: [] } });
		const interaction = makeInteraction({ platform: 'ctfd' });

		await makeCommand().chatInputRun(interaction);

		expect(setPlatformSpy).toHaveBeenCalledWith(CHANNEL_ID, {
			platform: 'ctfd',
			apiBaseUrl: 'https://scoreboard.k17ctf.secso.cc',
			apiToken: null,
			divisionId: null
		});
	});

	it('rejects an invalid API base URL without writing anything', async () => {
		const calls = stubFetch(NOCTF_ROUTES);
		const interaction = makeInteraction({
			platform: 'noctf',
			apiBaseUrl: 'not-a-url'
		});

		await makeCommand().chatInputRun(interaction);

		expect(setPlatformSpy).not.toHaveBeenCalled();
		expect(calls).toHaveLength(0);
		expect(String(interaction.edits[0])).toMatch(/Invalid URL/i);
	});

	it('warns that a tokenless noCTF setup cannot sync early, and never echoes the token', async () => {
		stubFetch(NOCTF_ROUTES);
		const interaction = makeInteraction({ platform: 'noctf' });

		await makeCommand().chatInputRun(interaction);

		const serialized = JSON.stringify(interaction.edits);
		expect(serialized).toMatch(/start time/i);
		expect(serialized).toMatch(/hidden challenges/i);
		expect(serialized).toContain('Not set');
	});

	it('never puts a supplied token in the reply payload', async () => {
		stubFetch(NOCTF_ROUTES);
		const interaction = makeInteraction({
			platform: 'noctf',
			apiToken: 'super-secret-bearer-token'
		});

		await makeCommand().chatInputRun(interaction);

		const serialized = JSON.stringify(interaction.edits);
		expect(serialized).not.toContain('super-secret-bearer-token');
		expect(serialized).toContain('Set');
	});

	it('show probes the platform but never writes', async () => {
		ctfOperations.getCTFByChannelId = vi.fn().mockReturnValue(makeCtf({
			platform: 'noctf',
			api_base_url: 'https://api-k17ctf.secso.cc',
			api_token: null,
			platform_division_id: null
		}));
		const calls = stubFetch(NOCTF_ROUTES);
		const interaction = makeInteraction({ show: true });

		await makeCommand().chatInputRun(interaction);

		expect(setPlatformSpy).not.toHaveBeenCalled();
		expect(calls.some(c => c.url.includes('/healthz'))).toBe(true);
		expect(calls.some(c => c.url.includes('/site/config'))).toBe(true);
		expect(interaction.edits[0].embeds[0].data.title).toContain('CTF Platform for');

		// A tokenless noCTF configuration is flagged in the read-only view too.
		const serialized = JSON.stringify(interaction.edits);
		expect(serialized).toMatch(/start time/i);
	});

	it('show falls back to the default platform for an unrecognised stored value', async () => {
		ctfOperations.getCTFByChannelId = vi.fn().mockReturnValue(makeCtf({ platform: 'something-else' }));
		stubFetch({ '/api/v1/': { success: true, data: [] } });
		const interaction = makeInteraction({ show: true });

		await makeCommand().chatInputRun(interaction);

		expect(setPlatformSpy).not.toHaveBeenCalled();
		const fields = interaction.edits[0].embeds[0].data.fields;
		expect(fields.find(f => f.name === 'Platform').value).toBe('CTFd');
	});

	it('asks for a platform when neither platform nor show is provided', async () => {
		const interaction = makeInteraction({});

		await makeCommand().chatInputRun(interaction);

		expect(setPlatformSpy).not.toHaveBeenCalled();
		expect(String(interaction.edits[0])).toMatch(/Provide a `platform`/);
	});
});
