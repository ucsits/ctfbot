import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, cpSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';
import { SummarizeCTFCommand } from '../../src/commands/summarizectf.js';

// -- Strategy ---------------------------------------------------------------
// The real command runs against the real platform registry and the real noCTF
// client, with only the HTTP boundary faked. vitest's vi.mock cannot intercept
// the plain CommonJS `require()` inside src/commands/summarizectf.js (the same
// limitation documented in tests/unit/middleware/ensurePermission.test.js), so a
// module mock would silently do nothing and the test would pass while
// exercising nothing.
//
// The database is a real, isolated SQLite file in a temp directory, so the
// summary is produced from rows the repositories actually wrote. The rank in
// the embed can only come from the noCTF scoreboard endpoint, which is what
// proves the command went through the platform registry instead of hardcoding
// the CTFd client.

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const tempDir = mkdtempSync(join(tmpdir(), 'ctfbot-summarize-'));

const API_BASE = 'https://api-k17ctf.secso.cc';
const DIVISION_ID = 2;
const TEAM_NAME = 'Maverick';

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

function makeInteraction({ format = 'pretty' } = {}) {
	const edits = [];
	return {
		channelId: null,
		user: { id: 'operator-1', tag: 'operator#0001' },
		options: { getString: () => format },
		deferReply: async () => {},
		editReply: async payload => {
			edits.push(payload);
			return payload;
		},
		edits
	};
}

function makeCommand() {
	const command = Object.create(SummarizeCTFCommand.prototype);
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

function seedNoCTFCtf() {
	counter += 1;
	const channelId = `summary-chan-${counter}`;
	const id = ctfOperations.createCTF({
		guild_id: 'guild-1',
		channel_id: channelId,
		event_id: `summary-event-${counter}`,
		ctf_name: `Summary CTF ${counter}`,
		ctf_base_url: 'https://scoreboard.k17ctf.secso.cc',
		ctf_date: new Date(Date.now() + 86_400_000).toISOString(),
		description: 'test',
		banner_url: null,
		api_token: null,
		team_mode: 0,
		created_by: 'admin-1'
	});

	ctfOperations.setCTFPlatform(channelId, {
		platform: 'noctf',
		apiBaseUrl: API_BASE,
		apiToken: 'session-token',
		divisionId: DIVISION_ID
	});

	return ctfOperations.getCTFById(id);
}

function seedParticipant(ctf) {
	registrationOperations.registerUser({
		ctf_id: ctf.id,
		user_id: 'discord-1',
		username: 'maverick',
		team_name: TEAM_NAME,
		ctfd_user_id: '1875',
		ctfd_team_name: TEAM_NAME
	});

	challengeOperations.upsertChallenge({
		ctf_id: ctf.id,
		chal_name: 'DriveOne',
		chal_category: 'web',
		points: 253,
		created_by: 'admin-1'
	});

	const chal = challengeOperations.getChallengeByName(ctf.id, 'DriveOne');
	challengeOperations.markChallengeSolved(chal.id, 'discord-1', null, TEAM_NAME);
}

async function runSummary(ctf, format = 'pretty') {
	const interaction = makeInteraction({ format });
	interaction.channelId = ctf.channel_id;
	const command = makeCommand();
	await command.chatInputRun(interaction);
	return { interaction, command };
}

beforeEach(() => {
	process.env.CTF_CATEGORY_ID = 'test-category-id';
});

afterEach(() => {
	delete globalThis.fetch;
});

describe('summarizectf on a noCTF channel', () => {
	it('reads the leaderboard through the noCTF scoreboard endpoint', async () => {
		const ctf = seedNoCTFCtf();
		seedParticipant(ctf);

		const calls = stubFetch([
			['/scoreboard/divisions/2', { entries: [{ team_id: 42, rank: 7, score: 253, hidden: false }], total: 1, page_size: 100 }],
			['/teams/query', { entries: [{ id: 42, name: TEAM_NAME }] }]
		]);

		const { interaction } = await runSummary(ctf);

		const embed = interaction.edits[interaction.edits.length - 1].embeds[0];
		expect(embed.data.description).toContain('Leaderboard Position:** 7');
		expect(calls.some(c => c.url.includes('/scoreboard/divisions/2'))).toBe(true);
		expect(calls.some(c => c.url.includes('/api/v1/scoreboard'))).toBe(false);
	});

	it('still produces the summary when the platform is unreachable', async () => {
		const ctf = seedNoCTFCtf();
		seedParticipant(ctf);

		stubFetch([['/scoreboard/divisions/2', { __status: 500 }]]);

		const { interaction, command } = await runSummary(ctf);

		const embed = interaction.edits[interaction.edits.length - 1].embeds[0];
		expect(embed.data.description).toContain('Leaderboard Position:** N/A');
		expect(command.container.logger.error).toHaveBeenCalled();
	});

	it('skips the scoreboard entirely when no token is stored', async () => {
		const ctf = seedNoCTFCtf();
		seedParticipant(ctf);
		ctfOperations.setCTFPlatform(ctf.channel_id, { apiToken: null });

		const calls = stubFetch([]);

		const { interaction } = await runSummary(ctf);

		const embed = interaction.edits[interaction.edits.length - 1].embeds[0];
		expect(embed.data.description).toContain('Leaderboard Position:** N/A');
		expect(calls).toHaveLength(0);
	});

	it('falls back to the CTF URL when no API base URL is stored', async () => {
		const ctf = seedNoCTFCtf();
		seedParticipant(ctf);
		ctfOperations.setCTFPlatform(ctf.channel_id, { apiBaseUrl: null, apiToken: 'session-token' });

		const calls = stubFetch([
			['https://scoreboard.k17ctf.secso.cc/scoreboard/divisions/2', { entries: [], total: 0, page_size: 100 }]
		]);

		await runSummary(ctf);

		expect(calls[0].url.startsWith('https://scoreboard.k17ctf.secso.cc')).toBe(true);
	});

	it('renders the TSV export without touching the platform', async () => {
		const ctf = seedNoCTFCtf();
		seedParticipant(ctf);

		const calls = stubFetch([]);

		const { interaction } = await runSummary(ctf, 'tsv');

		expect(interaction.edits[interaction.edits.length - 1].files).toHaveLength(1);
		expect(calls).toHaveLength(0);
	});
});

describe('platform-neutral user-facing messages', () => {
	it('does not name CTFd in any message constant value', () => {
		const messages = require('../../src/lib/constants/messages.js');

		const values = [];
		const collect = (node) => {
			for (const value of Object.values(node)) {
				if (typeof value === 'string') {
					values.push(value);
				} else if (value && typeof value === 'object') {
					collect(value);
				}
			}
		};
		collect(messages);

		expect(values.length).toBeGreaterThan(0);
		expect(values.filter(value => /ctfd/i.test(value))).toEqual([]);
	});
});
