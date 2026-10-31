import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DateTime } from 'luxon';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dirname, '../..');

const fresh = [
	{ id: '111', authorId: 'u1', content: 'ok kita kirim proposal sponsor jumat ya', createdAt: Date.now(), analyzed: false },
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
		expect(p.deadline).toBe(DateTime.fromFormat(future, 'yyyy-MM-dd HH:mm', { zone: 'Asia/Jakarta' }).toUnixInteger());
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
		expect(taskSuggest._normalizeProposals({ proposals: 'nope' }, { fresh, people, proposedSources: new Set() })).toEqual(
			[]
		);
		const many = Array.from({ length: 6 }, (_, i) => ({ id: String(i), authorId: 'u1', content: 'x', createdAt: 0 }));
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

describe('taskSuggest proposal claiming', () => {
	it('lets only one interaction claim a proposal until it is released', async () => {
		vi.resetModules();
		const taskSuggest = await import('../../src/services/taskSuggest.js');
		taskSuggest._reset();
		taskSuggest._proposals.set('p1', { id: 'p1', status: 'open', createdAt: Date.now() });

		expect(taskSuggest.claimProposal('p1')).not.toBeNull();
		expect(taskSuggest.claimProposal('p1')).toBeNull();
		taskSuggest.releaseProposal('p1');
		expect(taskSuggest.claimProposal('p1')).not.toBeNull();
		taskSuggest.finishProposal('p1');
		expect(taskSuggest.getProposal('p1')).toBeNull();
	});

	it('treats proposals older than a day as expired', async () => {
		const taskSuggest = await import('../../src/services/taskSuggest.js');
		taskSuggest._proposals.set('old', { id: 'old', status: 'open', createdAt: Date.now() - 25 * 60 * 60 * 1000 });
		expect(taskSuggest.claimProposal('old')).toBeNull();
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
		globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve('bad key') });
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
