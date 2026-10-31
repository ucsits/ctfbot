import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { DateTime } from 'luxon';
import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';

const root = join(import.meta.dirname, '../..');

// The service persists suggestions through the real repository, which opens
// ctfbot.db in the working directory. Run the whole file in a scratch
// directory holding a fresh database with just the task_suggestions table.
let tmpDir;
let originalCwd;

beforeAll(() => {
	originalCwd = process.cwd();
	tmpDir = mkdtempSync(join(tmpdir(), 'ctfbot-task-suggest-'));
	const db = new Database(join(tmpDir, 'ctfbot.db'));
	db.exec(readFileSync(join(root, 'migrations/026_add_task_suggestions.sql'), 'utf8'));
	db.close();
	process.chdir(tmpDir);
});

afterAll(async () => {
	const { closeConnection } = await import('../../src/database/connection.js');
	closeConnection();
	process.chdir(originalCwd);
	rmSync(tmpDir, { recursive: true, force: true });
});

const fresh = [
	{
		id: '111',
		authorId: 'u1',
		content: 'ok kita kirim proposal sponsor jumat ya',
		createdAt: Date.now(),
		analyzed: false
	},
	{ id: '222', authorId: 'u2', content: 'siap, aku yang kirim', createdAt: Date.now(), analyzed: false }
];
const people = new Map([
	['u1', 'Alice'],
	['u2', 'Budi']
]);
const future = DateTime.now().setZone('Asia/Jakarta').plus({ days: 3 }).toFormat('yyyy-MM-dd HH:mm');

describe('taskSuggest._normalizeProposals', () => {
	let taskSuggest;

	beforeEach(async () => {
		vi.resetModules();
		taskSuggest = await import('../../src/services/taskSuggest.js');
	});

	const normalize = (proposals, proposedSources = new Set()) =>
		taskSuggest._normalizeProposals({ proposals }, { fresh, people, proposedSources });

	it('keeps a well-formed proposal and converts the deadline to unix seconds in Jakarta time', () => {
		const [p] = normalize([
			{
				title: 'Kirim proposal sponsor',
				description: '',
				assignee_id: 'u2',
				deadline: future,
				source_message_id: '222',
				confidence: 0.9
			}
		]);
		expect(p.title).toBe('Kirim proposal sponsor');
		expect(p.assigneeId).toBe('u2');
		expect(p.description).toBeNull();
		expect(p.deadline).toBe(
			DateTime.fromFormat(future, 'yyyy-MM-dd HH:mm', { zone: 'Asia/Jakarta' }).toUnixInteger()
		);
	});

	it('drops proposals pointing at messages that were not in the new batch', () => {
		expect(normalize([{ title: 'X', source_message_id: '999', deadline: future }])).toEqual([]);
	});

	it('drops low-confidence proposals and ones already suggested for that message', () => {
		expect(normalize([{ title: 'X', source_message_id: '111', confidence: 0.4 }])).toEqual([]);
		expect(normalize([{ title: 'X', source_message_id: '111' }], new Set(['111']))).toEqual([]);
	});

	it('falls back to the source author when the assignee is unknown', () => {
		const [p] = normalize([{ title: 'X', assignee_id: 'stranger', source_message_id: '111' }]);
		expect(p.assigneeId).toBe('u1');
	});

	it('leaves the deadline empty when it is missing, malformed or in the past', () => {
		const past = DateTime.now().setZone('Asia/Jakarta').minus({ days: 1 }).toFormat('yyyy-MM-dd HH:mm');
		for (const deadline of [null, 'next friday', past]) {
			const [p] = normalize([{ title: 'X', source_message_id: '111', deadline }]);
			expect(p.deadline).toBeNull();
		}
	});

	it('ignores malformed replies and caps the number of proposals', () => {
		expect(taskSuggest._normalizeProposals(null, { fresh, people, proposedSources: new Set() })).toEqual([]);
		expect(
			taskSuggest._normalizeProposals({ proposals: 'nope' }, { fresh, people, proposedSources: new Set() })
		).toEqual([]);
		const many = Array.from({ length: 6 }, (_, i) => ({
			id: String(i),
			authorId: 'u1',
			content: 'x',
			createdAt: 0
		}));
		const out = taskSuggest._normalizeProposals(
			{ proposals: many.map(m => ({ title: `T${m.id}`, source_message_id: m.id })) },
			{ fresh: many, people, proposedSources: new Set() }
		);
		expect(out).toHaveLength(3);
	});
});

describe('taskSuggest._buildPrompt', () => {
	it('labels new messages, lists participants and anchors relative dates to Jakarta time', async () => {
		const taskSuggest = await import('../../src/services/taskSuggest.js');
		const now = DateTime.fromISO('2026-10-30T16:00:00Z');
		const [system, user] = taskSuggest._buildPrompt({
			context: [],
			fresh,
			people,
			proposedTitles: ['Book venue'],
			now
		});
		expect(system.role).toBe('system');
		expect(system.content).toContain('JSON');
		expect(user.content).toContain('Current local time: 2026-10-30 23:00 Friday (Asia/Jakarta)');
		expect(user.content).toContain('- Budi (u2)');
		expect(user.content).toContain('"Book venue"');
		expect(user.content).toContain('id=222');
		expect(user.content.indexOf('NEW messages:')).toBeLessThan(user.content.indexOf('id=111'));
	});
});

describe('taskSuggest._analyze', () => {
	const originalEnv = { ...process.env };
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		process.env = { ...originalEnv };
		globalThis.fetch = originalFetch;
	});

	it('puts messages back for the next pass when the model call fails', async () => {
		vi.resetModules();
		vi.useFakeTimers();
		process.env.TASK_SUGGESTIONS_ENABLED = 'true';
		process.env.OPENAI_API_KEY = 'sk-test';
		process.env.OPENAI_MODEL = 'test-model';
		globalThis.fetch = vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));

		const taskSuggest = await import('../../src/services/taskSuggest.js');
		const constants = (await import('../../src/lib/constants/config.js')).default;
		taskSuggest._reset();

		const channel = { id: 'c1', parentId: constants.GOVERNANCE_CATEGORIES[0], messages: { fetch: vi.fn() } };
		const message = {
			id: 'm1',
			channelId: 'c1',
			channel,
			guild: {},
			author: { id: 'u1', bot: false, username: 'alice' },
			member: { displayName: 'Alice' },
			mentions: { users: new Map() },
			content: 'we will submit the report next friday',
			createdTimestamp: Date.now()
		};

		taskSuggest.observe(message);
		await expect(taskSuggest._analyze('c1')).rejects.toThrow('within 300s');

		// The retry sends the same message again rather than dropping it.
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ choices: [{ message: { content: '{"proposals":[]}' } }] })
		});
		await taskSuggest._analyze('c1');
		const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
		expect(body.messages[1].content).toContain('id=m1');

		taskSuggest._reset();
		vi.useRealTimers();
	});
});

describe('task suggestion persistence', () => {
	let taskSuggest;
	let repo;
	let channel;
	let n = 0;

	beforeEach(async () => {
		taskSuggest = await import('../../src/services/taskSuggest.js');
		repo = await import('../../src/database/repositories/taskSuggestion.repository.js');
		n++;
		channel = {
			id: `chan-${n}`,
			messages: { fetch: vi.fn().mockResolvedValue(null) },
			send: vi.fn().mockResolvedValue({ id: `card-${n}` })
		};
	});

	const found = (overrides = {}) => ({
		title: 'Kirim proposal sponsor',
		description: null,
		assigneeId: 'u2',
		deadline: Math.floor(Date.now() / 1000) + 86_400,
		sourceMessageId: `src-${n}`,
		...overrides
	});

	const postedId = () => channel.send.mock.calls[0][0].components[0].toJSON().components[0].custom_id.split(':')[1];

	it('stores the suggestion and its card, with no expiry', async () => {
		expect(await taskSuggest._postProposal(channel, found())).toBe(true);
		const id = postedId();

		const row = repo.getSuggestion(id);
		expect(row.status).toBe('open');
		expect(row.card_message_id).toBe(`card-${n}`);

		// A week later (or after a restart) the card is still actionable.
		vi.useFakeTimers();
		vi.setSystemTime(Date.now() + 7 * 24 * 60 * 60 * 1000);
		expect(taskSuggest.getProposal(id)).toMatchObject({ title: 'Kirim proposal sponsor', assigneeId: 'u2' });
		vi.useRealTimers();
	});

	it('never suggests the same source message twice', async () => {
		expect(await taskSuggest._postProposal(channel, found())).toBe(true);
		expect(await taskSuggest._postProposal(channel, found({ title: 'Again' }))).toBe(false);
		expect(channel.send).toHaveBeenCalledTimes(1);
		expect(repo.suggestedSourceIds(channel.id, [`src-${n}`, 'other'])).toEqual(new Set([`src-${n}`]));
		expect(repo.recentTitles(channel.id)).toEqual(['Kirim proposal sponsor']);
	});

	it('drops the row when the card cannot be posted, so it can be suggested later', async () => {
		channel.send.mockRejectedValue(new Error('Missing Access'));
		await expect(taskSuggest._postProposal(channel, found())).rejects.toThrow('Missing Access');
		expect(repo.suggestedSourceIds(channel.id, [`src-${n}`]).size).toBe(0);
	});

	it('lets only one click claim a suggestion, and frees it again after release or a stale lease', async () => {
		await taskSuggest._postProposal(channel, found());
		const id = postedId();

		expect(taskSuggest.claimProposal(id)).not.toBeNull();
		expect(taskSuggest.claimProposal(id)).toBeNull();
		expect(taskSuggest.unavailableMessage(id)).toContain('handling this suggestion right now');

		taskSuggest.releaseProposal(id);
		expect(taskSuggest.claimProposal(id)).not.toBeNull();

		// A crash mid-creation leaves the lease behind; it lapses after 2 minutes.
		vi.useFakeTimers();
		vi.setSystemTime(Date.now() + 3 * 60 * 1000);
		expect(taskSuggest.claimProposal(id)).not.toBeNull();
		vi.useRealTimers();
	});

	it('closes created and dismissed suggestions with a message saying who handled them', async () => {
		await taskSuggest._postProposal(channel, found());
		const created = postedId();
		taskSuggest.claimProposal(created);
		taskSuggest.finishProposal(created, { status: 'created', handledBy: 'u9', taskId: 'task-1' });
		expect(taskSuggest.claimProposal(created)).toBeNull();
		expect(taskSuggest.unavailableMessage(created)).toBe('✅ <@u9> already created this task (`task-1`).');

		channel.send.mockClear();
		await taskSuggest._postProposal(channel, found({ sourceMessageId: `src-${n}-b` }));
		const dismissed = postedId();
		taskSuggest.finishProposal(dismissed, { status: 'dismissed', handledBy: 'u8' });
		expect(taskSuggest.getProposal(dismissed)).toBeNull();
		expect(taskSuggest.unavailableMessage(dismissed)).toContain('dismissed by <@u8>');

		expect(taskSuggest.unavailableMessage('unknown-id')).toContain('could not be found');
	});
});

describe('lib/llm/openai', () => {
	const originalEnv = { ...process.env };
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		vi.resetModules();
		process.env.OPENAI_BASE_URL = 'https://llm.example.com/v1/';
		process.env.OPENAI_API_KEY = 'sk-test';
		process.env.OPENAI_MODEL = 'test-model';
	});

	afterEach(() => {
		process.env = { ...originalEnv };
		globalThis.fetch = originalFetch;
	});

	it('posts to {base}/chat/completions with the key, model and JSON mode', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ choices: [{ message: { content: '{"proposals":[]}' } }] })
		});
		const { chatCompletion } = await import('../../src/lib/llm/openai.js');

		const reply = await chatCompletion({ messages: [{ role: 'user', content: 'hi' }], json: true });

		expect(reply).toBe('{"proposals":[]}');
		const [url, init] = globalThis.fetch.mock.calls[0];
		expect(url).toBe('https://llm.example.com/v1/chat/completions');
		expect(init.headers.Authorization).toBe('Bearer sk-test');
		const body = JSON.parse(init.body);
		expect(body.model).toBe('test-model');
		expect(body.response_format).toEqual({ type: 'json_object' });
	});

	it('throws on a non-2xx response', async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve('bad key') });
		const { chatCompletion } = await import('../../src/lib/llm/openai.js');
		await expect(chatCompletion({ messages: [] })).rejects.toThrow('401');
	});

	it('refuses to call out when the key or model is missing', async () => {
		delete process.env.OPENAI_MODEL;
		globalThis.fetch = vi.fn();
		const { chatCompletion } = await import('../../src/lib/llm/openai.js');
		await expect(chatCompletion({ messages: [] })).rejects.toThrow('OPENAI_MODEL');
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('parseJsonReply tolerates code fences and surrounding prose', async () => {
		const { parseJsonReply } = await import('../../src/lib/llm/openai.js');
		expect(parseJsonReply('Sure:\n```json\n{"proposals":[{"title":"A"}]}\n```')).toEqual({
			proposals: [{ title: 'A' }]
		});
		expect(() => parseJsonReply('no json here')).toThrow();
	});

	it('parseJsonReply ignores inline <think> reasoning that contains braces', async () => {
		const { parseJsonReply } = await import('../../src/lib/llm/openai.js');
		const reply = '<think>maybe {"proposals":[{"title":"wrong"}]}? no.</think>\n{"proposals":[]}';
		expect(parseJsonReply(reply)).toEqual({ proposals: [] });
	});

	it('waits 5 minutes by default so reasoning models can finish, and honours OPENAI_TIMEOUT_MS', async () => {
		const timeout = vi.spyOn(AbortSignal, 'timeout');
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ choices: [{ message: { content: '{}' } }] })
		});
		const { chatCompletion } = await import('../../src/lib/llm/openai.js');

		await chatCompletion({ messages: [] });
		expect(timeout).toHaveBeenLastCalledWith(300_000);

		process.env.OPENAI_TIMEOUT_MS = '600000';
		await chatCompletion({ messages: [] });
		expect(timeout).toHaveBeenLastCalledWith(600_000);
		timeout.mockRestore();
	});

	it('names the endpoint, model and limit when the model does not reply in time', async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
		const { chatCompletion } = await import('../../src/lib/llm/openai.js');
		await expect(chatCompletion({ messages: [] })).rejects.toThrow(
			'No reply from https://llm.example.com/v1/chat/completions (model test-model) within 300s'
		);
	});
});

describe('task suggestion wiring (source level)', () => {
	const listener = readFileSync(join(root, 'src/listeners/taskSuggestInteraction.js'), 'utf8');
	const messageCreate = readFileSync(join(root, 'src/listeners/messageCreate.js'), 'utf8');

	it('creates suggested tasks through the same path as /task add', () => {
		expect(listener).toContain('taskCommand.createTaskRecord');
		expect(listener).not.toContain('luce.appendBlock');
		expect(listener).not.toContain('createTaskWithReminders');
	});

	it('claims a proposal before acting on it and checks permissions on every action', () => {
		expect(listener.match(/claimProposal\(/g).length).toBeGreaterThanOrEqual(3);
		expect(listener.match(/await this\._denied\(interaction\)/g)).toHaveLength(4);
	});

	it('feeds every non-bot message to the suggestion service', () => {
		expect(messageCreate).toContain('taskSuggest.observe(message)');
	});
});
