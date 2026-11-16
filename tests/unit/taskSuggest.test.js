import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { DateTime } from 'luxon';
import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import constants from '../../src/lib/constants/config.js';

const root = join(import.meta.dirname, '../..');

// The service persists suggestions through the real repository, which opens
// ctfbot.db in the working directory. Run the whole file in a scratch
// directory holding a fresh database with just the tables it uses.
let tmpDir;
let originalCwd;

beforeAll(() => {
	originalCwd = process.cwd();
	tmpDir = mkdtempSync(join(tmpdir(), 'ctfbot-task-suggest-'));
	const db = new Database(join(tmpDir, 'ctfbot.db'));
	for (const migration of [
		'011_add_tasks_reps_docs.sql',
		'013_add_task_cancelled.sql',
		'018_add_task_transition_claim.sql',
		'023_add_task_transition_blocks.sql',
		'026_add_task_suggestions.sql',
		'027_add_actor_memory.sql',
		'029_task_suggestions_tools.sql'
	]) {
		db.exec(readFileSync(join(root, 'migrations', migration), 'utf8'));
	}
	db.close();
	process.chdir(tmpDir);
});

afterAll(async () => {
	const { closeConnection } = await import('../../src/database/connection.js');
	closeConnection();
	process.chdir(originalCwd);
	rmSync(tmpDir, { recursive: true, force: true });
});

const zone = 'Asia/Jakarta';
const BOT_ID = 'bot-1';
const future = DateTime.now().setZone(zone).plus({ days: 3 }).toFormat('yyyy-MM-dd HH:mm');
const tomorrow = DateTime.now().setZone(zone).plus({ days: 1 }).toFormat('yyyy-MM-dd HH:mm');

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

const llmReply = message => ({
	ok: true,
	json: () => Promise.resolve({ choices: [{ message, finish_reason: 'stop' }] })
});
const text = content => llmReply({ role: 'assistant', content });
const toolCall = (name, args, id = 'call-1') =>
	llmReply({
		role: 'assistant',
		content: null,
		tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
	});
const toolCalls = calls =>
	llmReply({
		role: 'assistant',
		content: null,
		tool_calls: calls.map((c, i) => ({
			id: `call-${i}`,
			type: 'function',
			function: { name: c.name, arguments: JSON.stringify(c.args) }
		}))
	});

const makeChannel = ({ id, fetch = () => Promise.resolve(null), send } = {}) => ({
	id: id ?? 'chan-1',
	guildId: 'g1',
	parentId: constants.GOVERNANCE_CATEGORIES[0],
	sendTyping: vi.fn().mockResolvedValue(undefined),
	messages: { fetch: vi.fn(fetch) },
	send: send ?? vi.fn().mockResolvedValue({ id: 'card-1' })
});

const makeMessage = ({ channel, id, content, authorId = 'u1', mentionBot = false }) => ({
	id,
	channelId: channel.id,
	channel,
	guild: {},
	client: { user: { id: BOT_ID } },
	author: { id: authorId, bot: false, username: authorId },
	member: { displayName: authorId === 'u1' ? 'Alice' : 'Budi' },
	mentions: {
		users: new Map(mentionBot ? [[BOT_ID, { id: BOT_ID, bot: true }]] : []),
		members: new Map()
	},
	content,
	createdTimestamp: Date.now(),
	reply: vi.fn().mockResolvedValue({ id: `reply-${id}` })
});

const createPendingTask = (taskId, overrides = {}) => {
	const db = new Database(join(process.cwd(), 'ctfbot.db'));
	db.prepare(
		`
		INSERT INTO tasks (task_id, title, description, assigned_to, created_by, deadline, block_height, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`
	).run(
		taskId,
		overrides.title ?? 'Pengecekan LPJ',
		overrides.description ?? null,
		overrides.assignedTo ?? 'u1',
		overrides.createdBy ?? 'u1',
		overrides.deadline ?? DateTime.now().setZone(zone).plus({ days: 1 }).toUnixInteger(),
		overrides.blockHeight ?? 1,
		Math.floor(Date.now() / 1000)
	);
	db.close();
};

describe('taskSuggest._createToolkit', () => {
	let taskSuggest;
	let suggestions;
	let taskRepository;
	let queue;
	let toolkit;
	let channel;

	const build = (overrides = {}) => {
		queue = { creates: [], cancels: [], updates: [], memories: [] };
		toolkit = taskSuggest._createToolkit({
			channelId: channel.id,
			channel,
			people,
			profiles: new Map(),
			open: [],
			pending: [],
			fresh,
			trigger: null,
			minConfidence: 0.7,
			queue,
			...overrides
		});
		return toolkit;
	};

	beforeEach(async () => {
		vi.resetModules();
		taskSuggest = await import('../../src/services/taskSuggest.js');
		suggestions = await import('../../src/database/repositories/taskSuggestion.repository.js');
		taskRepository = await import('../../src/database/repositories/task.repository.js');
		channel = makeChannel({ id: `toolkit-${Date.now()}-${Math.random()}` });
		build();
	});

	it('queues a create card and reports it to the model', async () => {
		const reply = await toolkit.dispatch('create_task_card', {
			title: 'Kirim proposal sponsor',
			deadline: future,
			assignee_id: 'u2',
			confidence: 0.9
		});
		expect(reply).toContain('queued "Kirim proposal sponsor" for Budi');
		expect(queue.creates).toHaveLength(1);
		expect(queue.creates[0]).toMatchObject({
			kind: 'create',
			title: 'Kirim proposal sponsor',
			assigneeId: 'u2',
			sourceMessageId: '222'
		});
	});

	it('allows several cards from one source message, even with the same title but a different deadline', async () => {
		const args = { title: 'Cek LPJ', confidence: 0.9 };
		expect(await toolkit.dispatch('create_task_card', { ...args, deadline: future })).toContain('queued');
		expect(await toolkit.dispatch('create_task_card', { ...args, deadline: tomorrow })).toContain('queued');
		expect(queue.creates).toHaveLength(2);
		expect(queue.creates[0].sourceMessageId).toBe(queue.creates[1].sourceMessageId);
	});

	it('refuses the exact same title and deadline twice in one pass', async () => {
		const args = { title: 'Cek LPJ', deadline: future, confidence: 0.9 };
		await toolkit.dispatch('create_task_card', args);
		expect(await toolkit.dispatch('create_task_card', args)).toContain('already queued this pass');
		expect(queue.creates).toHaveLength(1);
	});

	it('links the existing card instead of pretending a duplicate is missing', async () => {
		suggestions.createSuggestion({
			id: 'existing-1',
			channelId: channel.id,
			sourceMessageId: '222',
			title: 'Cek LPJ',
			assigneeId: 'u1',
			deadline: DateTime.fromFormat(future, 'yyyy-MM-dd HH:mm', { zone }).toUnixInteger()
		});
		suggestions.setCardMessage('existing-1', 'card-existing');

		const reply = await toolkit.dispatch('create_task_card', {
			title: 'Cek LPJ',
			deadline: future,
			confidence: 0.9
		});
		expect(reply).toContain('already exists');
		expect(reply).toContain(`/g1/${channel.id}/card-existing`);
		expect(queue.creates).toHaveLength(0);
	});

	it('rejects an explicit source that is not one of the NEW messages', async () => {
		const reply = await toolkit.dispatch('create_task_card', {
			title: 'X',
			deadline: future,
			source_message_id: 'old-message',
			confidence: 0.9
		});
		expect(reply).toContain('is not a NEW message');
		expect(queue.creates).toHaveLength(0);
	});

	it('enforces the confidence bar and a future deadline', async () => {
		expect(await toolkit.dispatch('create_task_card', { title: 'X', deadline: future, confidence: 0.4 })).toContain(
			'below 0.7'
		);
		expect(
			await toolkit.dispatch('create_task_card', {
				title: 'X',
				deadline: DateTime.now().minus({ days: 1 }).toFormat('yyyy-MM-dd HH:mm'),
				confidence: 0.9
			})
		).toContain('deadline must be');
		expect(queue.creates).toHaveLength(0);
	});

	it('falls back to the source author when the assignee is unknown', async () => {
		await toolkit.dispatch('create_task_card', {
			title: 'X',
			deadline: future,
			assignee_id: 'stranger',
			source_message_id: '111',
			confidence: 0.9
		});
		expect(queue.creates[0].assigneeId).toBe('u1');
	});

	it('queues a card with no deadline so Edit & create can set one', async () => {
		const reply = await toolkit.dispatch('create_task_card', { title: 'Rapikan dokumentasi', confidence: 0.9 });
		expect(reply).toContain('no deadline yet');
		expect(queue.creates[0].deadline).toBeNull();
	});

	it('cancels only a pending task assigned to someone in the conversation', async () => {
		createPendingTask('task-1');
		createPendingTask('task-2', { assignedTo: 'stranger' });
		build({ pending: [taskRepository.getTask('task-1')] });

		expect(await toolkit.dispatch('cancel_task_card', { task_id: 'task-2' })).toContain('No pending task');
		const reply = await toolkit.dispatch('cancel_task_card', { task_id: 'task-1', confidence: 0.9 });
		expect(reply).toContain('queued a cancellation card');
		expect(queue.cancels).toHaveLength(1);
		expect(queue.cancels[0].task.task_id).toBe('task-1');
	});

	it('updates only an open card, and only when something changed', async () => {
		const open = [
			{
				id: 'sug-1',
				title: 'Book venue',
				description: null,
				assignee_id: 'u1',
				deadline: DateTime.now().setZone(zone).plus({ days: 3 }).toUnixInteger(),
				kind: 'create'
			}
		];
		build({ open });

		expect(await toolkit.dispatch('update_task_card', { suggestion_id: 'nope', title: 'X' })).toContain(
			'not an open card'
		);
		expect(await toolkit.dispatch('update_task_card', { suggestion_id: 'sug-1', title: 'Book venue' })).toContain(
			'Nothing changed'
		);
		expect(await toolkit.dispatch('update_task_card', { suggestion_id: 'sug-1', assignee_id: 'u2' })).toContain(
			'queued an update'
		);
		expect(queue.updates).toEqual([{ id: 'sug-1', changes: { assigneeId: 'u2' }, sourceMessageId: '222' }]);
	});

	it('validates memory changes against the participants and their notes', async () => {
		const profiles = new Map([['u1', { language: null, notes: [{ id: 3, note: 'Works evenings' }] }]]);
		build({ profiles });

		expect(await toolkit.dispatch('remember_person', { user_id: 'stranger', remember: 'x' })).toContain(
			'not in this conversation'
		);
		expect(
			await toolkit.dispatch('remember_person', { user_id: 'u1', forget: 3, remember: 'Works mornings' })
		).toContain('remembered for Alice');
		expect(queue.memories[0]).toMatchObject({
			userId: 'u1',
			forget: { id: 3, note: 'Works evenings' },
			remember: 'Works mornings'
		});
		// Someone else cannot change Budi's language.
		expect(
			await toolkit.dispatch('remember_person', {
				user_id: 'u2',
				language: 'English',
				source_message_id: '111'
			})
		).toContain('Nothing new');
	});

	it('allows stay_silent only on an unprompted pass', async () => {
		expect(await toolkit.dispatch('stay_silent', { reason: 'nothing' })).toEqual({
			content: 'staying silent',
			stop: true
		});
		build({ trigger: { id: '222', client: { user: { id: BOT_ID } } } });
		expect(await toolkit.dispatch('stay_silent', { reason: 'nothing' })).toContain('you were mentioned');
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
		expect(system.content).toContain('You work through tools');
		expect(user.content).toContain('Current local time is 2026-10-30 23:00 Friday (Asia/Jakarta)');
		expect(user.content).toContain('- Budi (u2)');
		expect(user.content).toContain('"Book venue"');
		expect(user.content).toContain('id=222');
		expect(user.content.indexOf('NEW messages:')).toBeLessThan(user.content.indexOf('id=111'));
	});

	it('shows the real pending tasks as authoritative', async () => {
		const taskSuggest = await import('../../src/services/taskSuggest.js');
		const pending = [
			{
				task_id: 'task-9',
				title: 'Pengecekan LPJ',
				assigned_to: 'u1',
				deadline: DateTime.now().setZone(zone).plus({ days: 2 }).toUnixInteger()
			}
		];
		const [system, user] = taskSuggest._buildPrompt({
			context: [],
			fresh,
			people,
			proposedTitles: [],
			pending
		});
		expect(user.content).toContain('PENDING tasks of the people here');
		expect(user.content).toContain('task_id=task-9 "Pengecekan LPJ"');
		expect(system.content).toContain('If a task is listed here it exists');
		expect(system.content).toContain('call cancel_task_card');
	});

	it('tells the model one message can become several cards', () => {
		return import('../../src/services/taskSuggest.js').then(taskSuggest => {
			const [system] = taskSuggest._buildPrompt({ context: [], fresh, people, proposedTitles: [] });
			expect(system.content).toContain('Call create_task_card once for each of them, in the same turn');
			expect(system.content).toContain('"ganti LPJ ke hari ini dan esok" means two cards');
		});
	});
});

describe('taskSuggest._analyze', () => {
	const originalEnv = { ...process.env };
	const originalFetch = globalThis.fetch;
	let taskSuggest;
	let suggestions;
	let n = 0;

	beforeEach(async () => {
		vi.resetModules();
		process.env.TASK_SUGGESTIONS_ENABLED = 'true';
		process.env.OPENAI_API_KEY = 'sk-test';
		process.env.OPENAI_MODEL = 'test-model';
		taskSuggest = await import('../../src/services/taskSuggest.js');
		suggestions = await import('../../src/database/repositories/taskSuggestion.repository.js');
		taskSuggest._reset();
		n++;
	});

	afterEach(() => {
		taskSuggest._reset();
		process.env = { ...originalEnv };
		globalThis.fetch = originalFetch;
	});

	it('puts messages back for the next pass when the model call fails', async () => {
		vi.useFakeTimers();
		globalThis.fetch = vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));

		const constants = (await import('../../src/lib/constants/config.js')).default;
		const channel = makeChannel({ id: `fail-${n}` });
		channel.parentId = constants.GOVERNANCE_CATEGORIES[0];
		const message = makeMessage({ channel, id: 'm1', content: 'we will submit the report next friday' });

		taskSuggest.observe(message);
		await expect(taskSuggest._analyze(channel.id)).rejects.toThrow('within 300s');

		// The retry sends the same message again rather than dropping it.
		globalThis.fetch = vi.fn().mockResolvedValue(text(''));
		await taskSuggest._analyze(channel.id);
		const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
		expect(body.messages[1].content).toContain('id=m1');
		expect(body.reasoning_effort).toBe('low');

		vi.useRealTimers();
	});

	it('posts the chat first, then every card from one parallel tool turn', async () => {
		const channel = makeChannel({ id: `multi-${n}` });
		const order = [];
		channel.send = vi.fn(payload => {
			order.push(payload.embeds ? 'card' : payload.content);
			return Promise.resolve({ id: `sent-${order.length}` });
		});
		globalThis.fetch = vi
			.fn()
			.mockResolvedValueOnce(
				toolCalls([
					{
						name: 'create_task_card',
						args: { title: 'Cek LPJ hari ini', deadline: tomorrow, confidence: 0.9 }
					},
					{ name: 'create_task_card', args: { title: 'Cek LPJ besok', deadline: future, confidence: 0.9 } }
				])
			)
			.mockResolvedValueOnce(text('wait\noke ini ya'));

		const message = makeMessage({
			channel,
			id: 'm1',
			content: '<@bot-1> ganti LPJ ke hari ini dan esok hari',
			mentionBot: true
		});
		message.reply = vi.fn(payload => {
			order.push(`reply:${payload.content}`);
			return Promise.resolve({});
		});

		taskSuggest.observe(message);
		await vi.waitFor(() => expect(order).toHaveLength(4));

		expect(order).toEqual(['reply:wait', 'oke ini ya', 'card', 'card']);
		const rows = suggestions.recentHandled(channel.id);
		expect(rows.filter(r => r.kind === 'create')).toHaveLength(2);
	});

	it('cancels the old task and creates the replacements in one pass', async () => {
		const channel = makeChannel({ id: `resched-${n}` });
		const taskRepository = await import('../../src/database/repositories/task.repository.js');
		const deadline = DateTime.now().setZone(zone).plus({ days: 1 }).toUnixInteger();
		taskRepository.createTask({
			taskId: 'old-task',
			title: 'Pengecekan LPJ',
			description: 'cek berkas',
			assignedTo: 'u1',
			createdBy: 'u1',
			deadline,
			blockHeight: 1
		});

		globalThis.fetch = vi
			.fn()
			.mockResolvedValueOnce(
				toolCalls([
					{ name: 'cancel_task_card', args: { task_id: 'old-task', confidence: 0.9 } },
					{
						name: 'create_task_card',
						args: { title: 'Pengecekan LPJ hari ini', deadline: tomorrow, confidence: 0.9 }
					},
					{
						name: 'create_task_card',
						args: { title: 'Pengumpulan LPJ besok', deadline: future, confidence: 0.9 }
					}
				])
			)
			.mockResolvedValueOnce(text('oke ini ya'));

		const message = makeMessage({
			channel,
			id: 'm1',
			content: '<@bot-1> cancel pengecekan dan pengumpulan LPJ, ganti hari ini dan esok',
			mentionBot: true
		});
		taskSuggest.observe(message);
		await vi.waitFor(() => expect(channel.send).toHaveBeenCalledTimes(3));

		// The cancellation card is posted before the replacement cards.
		const titles = channel.send.mock.calls.map(([payload]) => payload.embeds[0].toJSON().title);
		expect(titles).toEqual(['Cancel this task?', 'Set a task reminder?', 'Set a task reminder?']);

		// The model saw the real task, not only the open cards.
		const prompt = JSON.parse(globalThis.fetch.mock.calls[0][1].body).messages[1].content;
		expect(prompt).toContain('task_id=old-task "Pengecekan LPJ"');

		const rows = suggestions.recentHandled(channel.id);
		expect(rows.find(r => r.kind === 'cancel')).toMatchObject({
			title: 'Pengecekan LPJ',
			target_task_id: 'old-task'
		});
	});

	it('does not claim a card was posted when a tool refused it', async () => {
		const channel = makeChannel({ id: `refused-${n}` });
		globalThis.fetch = vi
			.fn()
			.mockResolvedValueOnce(toolCall('create_task_card', { title: 'Day 3', deadline: future, confidence: 0.2 }))
			.mockResolvedValueOnce(text('hmm kartunya nggak jadi, confidence-nya kurang'));

		const message = makeMessage({ channel, id: 'm1', content: '<@bot-1> day 3', mentionBot: true });
		taskSuggest.observe(message);
		await vi.waitFor(() => expect(message.reply).toHaveBeenCalledTimes(1));

		expect(channel.send).not.toHaveBeenCalled();
		// No bogus "card failed" message. The model explained itself.
		expect(message.reply.mock.calls[0][0].content).toContain('nggak jadi');
	});

	it('names only the card that actually failed to post', async () => {
		const channel = makeChannel({ id: `failpost-${n}` });
		channel.send = vi
			.fn()
			.mockResolvedValueOnce({ id: 'card-1' })
			.mockRejectedValueOnce(new Error('Missing Access'));
		globalThis.fetch = vi
			.fn()
			.mockResolvedValueOnce(
				toolCalls([
					{ name: 'create_task_card', args: { title: 'Card satu', deadline: tomorrow, confidence: 0.9 } },
					{ name: 'create_task_card', args: { title: 'Card dua', deadline: future, confidence: 0.9 } }
				])
			)
			.mockResolvedValueOnce(text('oke ini ya'));

		const message = makeMessage({ channel, id: 'm1', content: '<@bot-1> buatin dua task', mentionBot: true });
		taskSuggest.observe(message);
		await vi.waitFor(() => expect(message.reply).toHaveBeenCalledTimes(2));

		const correction = message.reply.mock.calls[1][0].content;
		expect(correction).toContain('"Card dua"');
		expect(correction).not.toContain('"Card satu"');
		expect(channel.send).toHaveBeenCalledTimes(2);
		// The first card and its row stay.
		expect(suggestions.recentHandled(channel.id).filter(r => r.kind === 'create')).toHaveLength(1);
	});

	it('needs more confidence for an unprompted card than for an answer to a mention', async () => {
		const passive = makeChannel({ id: `passive-${n}` });
		globalThis.fetch = vi
			.fn()
			.mockResolvedValueOnce(
				toolCall('create_task_card', { title: 'Latihan', deadline: future, confidence: 0.8 })
			)
			.mockResolvedValueOnce(text(''));
		taskSuggest.observe(makeMessage({ channel: passive, id: 'p1', content: 'siapp mass' }));
		await taskSuggest._analyze(passive.id);
		expect(passive.send).not.toHaveBeenCalled();

		n++;
		const asked = makeChannel({ id: `asked-${n}` });
		globalThis.fetch = vi
			.fn()
			.mockResolvedValueOnce(
				toolCall('create_task_card', { title: 'Latihan', deadline: future, confidence: 0.8 })
			)
			.mockResolvedValueOnce(text('oke'));
		taskSuggest.observe(
			makeMessage({
				channel: asked,
				id: 'a1',
				content: '<@bot-1> ingetin aku minggu jam 12 siang',
				mentionBot: true
			})
		);
		await vi.waitFor(() => expect(asked.send).toHaveBeenCalledTimes(1));
	});

	it('answers the mention when the model call fails', async () => {
		const channel = makeChannel({ id: `mentfail-${n}` });
		globalThis.fetch = vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
		const message = makeMessage({ channel, id: 'm1', content: '<@bot-1> check this', mentionBot: true });
		taskSuggest.observe(message);

		await vi.waitFor(() => expect(message.reply).toHaveBeenCalledTimes(1));
		const error = message.reply.mock.calls[0][0].content;
		expect(error).toContain('lagi nggak nyaut');
		expect(error).toContain('within 300s');
	});

	it('runs a mention that arrives mid-pass right after the current pass', async () => {
		const channel = makeChannel({ id: `midpass-${n}` });
		let resolveFirst;
		globalThis.fetch = vi
			.fn()
			.mockImplementationOnce(() => new Promise(resolve => (resolveFirst = resolve)))
			.mockResolvedValueOnce(text('oke'));

		const first = makeMessage({ channel, id: 'm1', content: '<@bot-1> look', mentionBot: true });
		taskSuggest.observe(first);
		const second = makeMessage({ channel, id: 'm2', content: '<@bot-1> and this', mentionBot: true });
		taskSuggest.observe(second);
		await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));

		resolveFirst(text('oke'));
		await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
		const body = JSON.parse(globalThis.fetch.mock.calls[1][1].body);
		expect(body.messages[1].content).toContain('id=m2');
		await vi.waitFor(() => expect(second.reply).toHaveBeenCalledTimes(1));
	});

	it("treats a mention of the bot's own role as a mention, but not other roles", async () => {
		const channel = makeChannel({ id: `role-${n}` });
		globalThis.fetch = vi.fn().mockResolvedValue(text(''));

		const withRole = (id, content, role) => {
			const message = makeMessage({ channel, id, content });
			message.mentions.roles = new Map([[role.id, role]]);
			return message;
		};

		taskSuggest.observe(withRole('m1', '<@&admins> rapat jumat', { id: 'admins', tags: null }));
		expect(globalThis.fetch).not.toHaveBeenCalled();

		taskSuggest.observe(withRole('m2', '<@&bot-role> tolong cek', { id: 'bot-role', tags: { botId: BOT_ID } }));
		await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
		const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
		expect(body.messages[1].content).toContain('<@bot-1> tolong cek');
		expect(body.messages[0].content).toContain('You were mentioned directly as <@bot-1>');
	});

	it('answers the mention and logs the raw reply when the model returns no text and no cards', async () => {
		const channel = makeChannel({ id: `empty-${n}` });
		globalThis.fetch = vi.fn().mockResolvedValue(text(''));
		const message = makeMessage({ channel, id: 'm1', content: '<@bot-1> cek dong', mentionBot: true });
		taskSuggest.observe(message);
		await vi.waitFor(() => expect(message.reply).toHaveBeenCalledTimes(1));
		expect(message.reply.mock.calls[0][0].content).toContain('nggak nemu keputusan baru');
	});
});

describe('banned punctuation and chat splitting', () => {
	it('replaces em and en dashes in chat, titles and descriptions', async () => {
		const taskSuggest = await import('../../src/services/taskSuggest.js');
		expect(taskSuggest._plain('kartunya ilang — nanti aku ingetin')).toBe('kartunya ilang, nanti aku ingetin');
		expect(taskSuggest._plain('jam 9–10 pagi')).toBe('jam 9-10 pagi');
		expect(taskSuggest._plain('oke—')).toBe('oke');
		expect(taskSuggest._chatMessages('a — b\nc')).toEqual(['a, b', 'c']);
	});

	it('removes emojis and splits one message per line', async () => {
		const taskSuggest = await import('../../src/services/taskSuggest.js');
		expect(taskSuggest._chatMessages('oke 🚀 ini ya')).toEqual(['oke ini ya']);
		expect(taskSuggest._chatMessages('wait\noke ini ya\n\ncardnya nyusul')).toEqual([
			'wait',
			'oke ini ya',
			'cardnya nyusul'
		]);
		expect(taskSuggest._chatMessages('')).toEqual([]);
		expect(taskSuggest._chatMessages('{"proposals":[]}')).toEqual([]);
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
		channel = makeChannel({ id: `persist-${n}`, send: vi.fn().mockResolvedValue({ id: `card-${n}` }) });
	});

	const found = (overrides = {}) => ({
		title: 'Kirim proposal sponsor',
		description: null,
		assigneeId: 'u2',
		deadline: Math.floor(Date.now() / 1000) + 86_400,
		sourceMessageId: `src-${n}`,
		...overrides
	});

	const postedId = index =>
		channel.send.mock.calls[index][0].components[0].toJSON().components[0].custom_id.split(':')[1];

	it('stores the suggestion and its card, with no expiry', async () => {
		expect(await taskSuggest._postProposal(channel, found())).toBe(true);
		const id = postedId(0);

		const row = repo.getSuggestion(id);
		expect(row.status).toBe('open');
		expect(row.kind).toBe('create');
		expect(row.card_message_id).toBe(`card-${n}`);

		// A week later (or after a restart) the card is still actionable.
		vi.useFakeTimers();
		vi.setSystemTime(Date.now() + 7 * 24 * 60 * 60 * 1000);
		expect(taskSuggest.getProposal(id)).toMatchObject({ title: 'Kirim proposal sponsor', assigneeId: 'u2' });
		vi.useRealTimers();
	});

	it('stores several cards from one source message', async () => {
		expect(await taskSuggest._postProposal(channel, found())).toBe(true);
		expect(await taskSuggest._postProposal(channel, found({ title: 'Kirim proposal sponsor besok' }))).toBe(true);
		expect(channel.send).toHaveBeenCalledTimes(2);
		expect(repo.recentTitles(channel.id)).toEqual(['Kirim proposal sponsor', 'Kirim proposal sponsor besok']);
	});

	it('finds a duplicate only while the card is still open', async () => {
		expect(await taskSuggest._postProposal(channel, found())).toBe(true);
		const id = postedId(0);
		const deadline = found().deadline;

		expect(
			repo.findSuggestionByTitle({
				channelId: channel.id,
				kind: 'create',
				targetTaskId: null,
				title: 'kirim PROPOSAL sponsor',
				deadline
			})
		).toMatchObject({ id });

		repo.finishSuggestion(id, { status: 'dismissed', handledBy: 'u1' });
		expect(
			repo.findSuggestionByTitle({
				channelId: channel.id,
				kind: 'create',
				targetTaskId: null,
				title: 'Kirim proposal sponsor',
				deadline
			})
		).toBeUndefined();
	});

	it('drops the row when the card cannot be posted, letting a later pass suggest it', async () => {
		channel.send.mockRejectedValue(new Error('Missing Access'));
		await expect(taskSuggest._postProposal(channel, found())).rejects.toThrow('Missing Access');
		expect(repo.recentTitles(channel.id)).toEqual([]);
	});

	it('lets only one click claim a suggestion, and frees it again after release or a stale lease', async () => {
		await taskSuggest._postProposal(channel, found());
		const id = postedId(0);

		expect(taskSuggest.claimProposal(id)).not.toBeNull();
		expect(taskSuggest.claimProposal(id)).toBeNull();
		expect(taskSuggest.unavailableMessage(id)).toContain('handling this suggestion right now');

		taskSuggest.releaseProposal(id);
		expect(taskSuggest.claimProposal(id)).not.toBeNull();

		// A crash mid-creation leaves the lease behind. It lapses after 2 minutes.
		vi.useFakeTimers();
		vi.setSystemTime(Date.now() + 3 * 60 * 1000);
		expect(taskSuggest.claimProposal(id)).not.toBeNull();
		vi.useRealTimers();
	});

	it('closes created, cancelled, kept and dismissed suggestions with who handled them', async () => {
		await taskSuggest._postProposal(channel, found());
		const created = postedId(0);
		taskSuggest.claimProposal(created);
		taskSuggest.finishProposal(created, { status: 'created', handledBy: 'u9', taskId: 'task-1' });
		expect(taskSuggest.claimProposal(created)).toBeNull();
		expect(taskSuggest.unavailableMessage(created)).toBe('<@u9> already created this task (`task-1`).');

		channel.send.mockClear();
		await taskSuggest._postProposal(channel, found({ sourceMessageId: `src-${n}-b` }));
		const cancelled = postedId(0);
		taskSuggest.finishProposal(cancelled, { status: 'cancelled', handledBy: 'u8', taskId: 'task-2' });
		expect(taskSuggest.unavailableMessage(cancelled)).toContain('already cancelled this task');

		channel.send.mockClear();
		await taskSuggest._postProposal(channel, found({ sourceMessageId: `src-${n}-c` }));
		const kept = postedId(0);
		taskSuggest.finishProposal(kept, { status: 'kept', handledBy: 'u7' });
		expect(taskSuggest.unavailableMessage(kept)).toBe('<@u7> kept this task.');

		channel.send.mockClear();
		await taskSuggest._postProposal(channel, found({ sourceMessageId: `src-${n}-d` }));
		const dismissed = postedId(0);
		taskSuggest.finishProposal(dismissed, { status: 'dismissed', handledBy: 'u6' });
		expect(taskSuggest.getProposal(dismissed)).toBeNull();
		expect(taskSuggest.unavailableMessage(dismissed)).toContain('dismissed by <@u6>');

		expect(taskSuggest.unavailableMessage('unknown-id')).toContain('could not be found');
	});
});

describe('actor memory', () => {
	const originalEnv = { ...process.env };
	const originalFetch = globalThis.fetch;
	let taskSuggest;
	let memory;
	let n = 0;

	beforeEach(async () => {
		vi.resetModules();
		process.env.TASK_SUGGESTIONS_ENABLED = 'true';
		process.env.OPENAI_API_KEY = 'sk-test';
		process.env.OPENAI_MODEL = 'test-model';
		taskSuggest = await import('../../src/services/taskSuggest.js');
		memory = await import('../../src/database/repositories/actorMemory.repository.js');
		taskSuggest._reset();
		n++;
	});

	afterEach(() => {
		taskSuggest._reset();
		process.env = { ...originalEnv };
		globalThis.fetch = originalFetch;
	});

	it('stores language and notes per user, newest kept within the cap', () => {
		const user = `mem-user-${n}`;
		expect(memory.getLanguage(user)).toBeNull();
		memory.setLanguage(user, 'English');
		expect(memory.getLanguage(user)).toBe('English');

		const first = memory.addNote(user, 'Pegang urusan sponsor');
		expect(memory.addNote(user, 'Pegang urusan sponsor')).toBeNull();
		for (let i = 0; i < memory.MAX_NOTES_PER_USER; i++) {
			memory.addNote(user, `note ${i}`);
		}
		const notes = memory.listNotes(user);
		expect(notes).toHaveLength(memory.MAX_NOTES_PER_USER);
		expect(notes.some(x => x.id === first)).toBe(false);

		expect(memory.removeNote('someone-else', notes[0].id)).toBeNull();
		expect(memory.removeNote(user, notes[0].id)).toBe('note 0');

		memory.clearUser(user);
		expect(memory.getProfiles([user]).get(user)).toEqual({ language: null, notes: [] });
	});

	it('tells the model to write in Indonesian by default and shows what it remembers', () => {
		const profiles = new Map([
			['u1', { language: null, notes: [{ id: 7, note: 'Prefers reminders at 20:00' }] }],
			['u2', { language: 'English', notes: [] }]
		]);
		const [system, user] = taskSuggest._buildPrompt({
			context: [],
			fresh,
			people,
			proposedTitles: [],
			profiles
		});
		expect(system.content).toContain('in Indonesian (Bahasa Indonesia) by default');
		expect(system.content).toContain('remember_person');
		expect(user.content).toContain(
			'- Alice (u1). language=default (Indonesian). Notes [7] Prefers reminders at 20:00'
		);
		expect(user.content).toContain('- Budi (u2). language=English. Notes none');
	});

	it('saves queued memory changes and reacts on the source message', async () => {
		const user = `learner-${n}`;
		const source = { react: vi.fn().mockResolvedValue(undefined) };
		const channel = makeChannel({ id: `mem-${n}`, fetch: id => Promise.resolve(id === 'm1' ? source : null) });

		const saved = await taskSuggest._applyMemories(channel, [
			{
				userId: user,
				authorId: user,
				sourceMessageId: 'm1',
				remember: 'Usually only available in the evening',
				language: 'English'
			}
		]);

		expect(saved).toBe(1);
		expect(source.react).toHaveBeenCalledWith('🧠');
		expect(memory.getLanguage(user)).toBe('English');
		expect(memory.listNotes(user).map(x => x.note)).toEqual(['Usually only available in the evening']);
	});

	it('learns from a mention through the remember_person tool', async () => {
		const user = `mention-learner-${n}`;
		const source = { react: vi.fn().mockResolvedValue(undefined) };
		const channel = makeChannel({
			id: `mem-mention-${n}`,
			fetch: id => Promise.resolve(id === 'm1' ? source : null)
		});
		globalThis.fetch = vi
			.fn()
			.mockResolvedValueOnce(
				toolCall('remember_person', {
					user_id: user,
					remember: 'Usually only available in the evening',
					language: 'English'
				})
			)
			.mockResolvedValueOnce(text("got it, I'll remember that"));

		const message = makeMessage({
			channel,
			id: 'm1',
			authorId: user,
			content: '<@bot-1> ingat ya, aku biasanya baru bisa malam, dan pakai bahasa inggris aja',
			mentionBot: true
		});
		message.member = { displayName: 'Hanz' };
		taskSuggest.observe(message);
		await vi.waitFor(() => expect(message.reply).toHaveBeenCalledTimes(1));

		expect(message.reply.mock.calls[0][0].content).toBe("got it, I'll remember that");
		expect(source.react).toHaveBeenCalledWith('🧠');
		expect(memory.getLanguage(user)).toBe('English');
		expect(memory.listNotes(user).map(x => x.note)).toEqual(['Usually only available in the evening']);
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
		globalThis.fetch = vi.fn().mockResolvedValue(text('{"proposals":[]}'));
		const { chatCompletion } = await import('../../src/lib/llm/openai.js');

		const reply = await chatCompletion({ messages: [{ role: 'user', content: 'hi' }], json: true });

		expect(reply).toBe('{"proposals":[]}');
		const [url, init] = globalThis.fetch.mock.calls[0];
		expect(url).toBe('https://llm.example.com/v1/chat/completions');
		expect(init.headers.Authorization).toBe('Bearer sk-test');
		const body = JSON.parse(init.body);
		expect(body.model).toBe('test-model');
		expect(body.response_format).toEqual({ type: 'json_object' });
		expect(body).not.toHaveProperty('reasoning_effort');
		expect(body).not.toHaveProperty('thinking');
	});

	it('sends reasoning_effort only when one is given', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(text('{}'));
		const { chatCompletion } = await import('../../src/lib/llm/openai.js');

		await chatCompletion({ messages: [], reasoningEffort: 'low' });
		const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
		expect(body.reasoning_effort).toBe('low');
		expect(body).not.toHaveProperty('thinking');
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
		globalThis.fetch = vi.fn().mockResolvedValue(text('{}'));
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

describe('deleted messages', () => {
	const originalEnv = { ...process.env };
	const originalFetch = globalThis.fetch;
	let taskSuggest;
	let suggestions;
	let memory;
	let n = 0;

	beforeEach(async () => {
		vi.resetModules();
		process.env.TASK_SUGGESTIONS_ENABLED = 'true';
		process.env.OPENAI_API_KEY = 'sk-test';
		process.env.OPENAI_MODEL = 'test-model';
		taskSuggest = await import('../../src/services/taskSuggest.js');
		suggestions = await import('../../src/database/repositories/taskSuggestion.repository.js');
		memory = await import('../../src/database/repositories/actorMemory.repository.js');
		taskSuggest._reset();
		n++;
	});

	afterEach(() => {
		taskSuggest._reset();
		process.env = { ...originalEnv };
		globalThis.fetch = originalFetch;
	});

	const promptOf = call => JSON.parse(call[1].body).messages[1].content;

	it('never sends a deleted buffered message to the model', async () => {
		const channel = makeChannel({ id: `del-${n}`, fetch: () => Promise.resolve(new Map()) });
		globalThis.fetch = vi.fn().mockResolvedValue(text(''));
		taskSuggest.observe(makeMessage({ channel, id: `a-${n}`, content: 'pesan yang nanti dihapus' }));
		taskSuggest.observe(makeMessage({ channel, id: `b-${n}`, content: 'pesan yang tetap ada' }));

		taskSuggest.forgetMessage(channel.id, `a-${n}`);
		await taskSuggest._analyze(channel.id);

		const prompt = promptOf(globalThis.fetch.mock.calls[0]);
		expect(prompt).toContain('pesan yang tetap ada');
		expect(prompt).not.toContain('pesan yang nanti dihapus');
	});

	it('drops a deleted open card and the notes learned from a deleted message, but keeps handled ones', () => {
		const channelId = `del-chan-${n}`;
		const add = (id, card) => {
			suggestions.createSuggestion({
				id,
				channelId,
				sourceMessageId: `src-${id}`,
				title: id,
				assigneeId: 'u1',
				deadline: null
			});
			suggestions.setCardMessage(id, card);
		};
		add(`open-${n}`, `card-open-${n}`);
		add(`made-${n}`, `card-made-${n}`);
		suggestions.finishSuggestion(`made-${n}`, { status: 'created', handledBy: 'u1', taskId: 't1' });
		add(`nope-${n}`, `card-nope-${n}`);
		suggestions.finishSuggestion(`nope-${n}`, { status: 'dismissed', handledBy: 'u1' });
		memory.addNote('u1', `note-${n}`, { sourceMessageId: `said-${n}` });

		taskSuggest.forgetMessage(channelId, `card-open-${n}`);
		taskSuggest.forgetMessage(channelId, `card-made-${n}`);
		taskSuggest.forgetMessage(channelId, `card-nope-${n}`);
		taskSuggest.forgetMessage(channelId, `said-${n}`);

		expect(suggestions.getSuggestion(`open-${n}`)).toBeUndefined();
		expect(suggestions.getSuggestion(`made-${n}`).status).toBe('created');
		// Dismiss deletes the card itself. The model should still know it was not
		// wanted.
		expect(suggestions.getSuggestion(`nope-${n}`).status).toBe('dismissed');
		expect(memory.listNotes('u1').map(x => x.note)).not.toContain(`note-${n}`);
	});

	it('drops open suggestions whose card was deleted while the bot was offline', async () => {
		const channelId = `del-offline-${n}`;
		for (const id of ['gone', 'kept', 'flaky']) {
			suggestions.createSuggestion({
				id: `${id}-${n}`,
				channelId,
				sourceMessageId: `src-${id}-${n}`,
				title: `Card ${id}`,
				assigneeId: 'u1',
				deadline: null
			});
			suggestions.setCardMessage(`${id}-${n}`, `card-${id}-${n}`);
		}
		const channel = makeChannel({
			id: channelId,
			fetch: arg => {
				if (arg === `card-gone-${n}`) {
					return Promise.reject(Object.assign(new Error('Unknown Message'), { code: 10008 }));
				}
				if (arg === `card-flaky-${n}`) {
					return Promise.reject(new Error('socket hang up'));
				}
				return Promise.resolve(typeof arg === 'string' ? { id: arg } : new Map());
			}
		});
		globalThis.fetch = vi.fn().mockResolvedValue(text(''));

		taskSuggest.observe(makeMessage({ channel, id: `m-${n}`, content: 'ada update?' }));
		await taskSuggest._analyze(channel.id);

		const prompt = promptOf(globalThis.fetch.mock.calls[0]);
		expect(prompt).not.toContain('Card gone');
		expect(prompt).toContain('Card kept');
		// A network error is not proof the card is gone.
		expect(prompt).toContain('Card flaky');
		expect(suggestions.getSuggestion(`gone-${n}`)).toBeUndefined();
	});

	it('asks the model to chat like a classmate, with humor at 10%', () => {
		const [system] = taskSuggest._buildPrompt({ context: [], fresh, people, proposedTitles: [] });
		expect(system.content).toContain('temen sekelas');
		expect(system.content).toContain('Humor setting 10%, kayak TARS di Interstellar');
		expect(system.content).toContain('"Jam 12 malam" on a day means the end of that day');
	});
});

describe('what counts as a task', () => {
	const originalEnv = { ...process.env };
	const originalFetch = globalThis.fetch;
	let taskSuggest;
	let suggestions;
	let n = 0;

	beforeEach(async () => {
		vi.resetModules();
		process.env.TASK_SUGGESTIONS_ENABLED = 'true';
		process.env.OPENAI_API_KEY = 'sk-test';
		process.env.OPENAI_MODEL = 'test-model';
		taskSuggest = await import('../../src/services/taskSuggest.js');
		suggestions = await import('../../src/database/repositories/taskSuggestion.repository.js');
		taskSuggest._reset();
		n++;
	});

	afterEach(() => {
		taskSuggest._reset();
		process.env = { ...originalEnv };
		globalThis.fetch = originalFetch;
	});

	it('tells the model that assignments to members are not admin tasks, with the counter-example', () => {
		const [system, user] = taskSuggest._buildPrompt({
			context: [],
			fresh,
			people,
			proposedTitles: [],
			dismissedTitles: ['Latihan personal finance: catat pengeluaran & laporan PDF']
		});
		expect(system.content).toContain('follow-up work the administrators themselves have to do');
		expect(system.content).toContain('assignments, homework, exercises or instructions');
		expect(system.content).toContain('"siap mas" → nothing');
		expect(system.content).toContain('When unsure, propose nothing');
		expect(user.content).toContain(
			'Dismissed by the team, who did not want these tracked. "Latihan personal finance: catat pengeluaran & laporan PDF"'
		);
	});

	it('shows the model which cards were dismissed and which became tasks', async () => {
		const channel = makeChannel({ id: `kind-${n}` });
		for (const [id, status] of [
			[`kind-made-${n}`, 'created'],
			[`kind-nope-${n}`, 'dismissed'],
			[`kind-open-${n}`, 'open']
		]) {
			suggestions.createSuggestion({
				id,
				channelId: channel.id,
				sourceMessageId: `src-${id}`,
				title: `Title ${status}`,
				assigneeId: 'u1',
				deadline: null
			});
			if (status !== 'open') {
				suggestions.finishSuggestion(id, { status, handledBy: 'u1' });
			}
		}
		globalThis.fetch = vi.fn().mockResolvedValue(text(''));

		taskSuggest.observe(makeMessage({ channel, id: `m-${n}`, content: 'oke lanjut' }));
		await taskSuggest._analyze(channel.id);

		const prompt = JSON.parse(globalThis.fetch.mock.calls[0][1].body).messages[1].content;
		expect(prompt).toContain('Already suggested and handled. "Title created"');
		expect(prompt).toContain('Dismissed by the team, who did not want these tracked. "Title dismissed"');
	});
});

describe('suggestion card actions', () => {
	let suggestions;
	let Listener;
	let n = 0;

	beforeEach(async () => {
		suggestions = await import('../../src/database/repositories/taskSuggestion.repository.js');
		({ TaskSuggestInteractionListener: Listener } = await import('../../src/listeners/taskSuggestInteraction.js'));
		n++;
	});

	const interaction = ({ message = {}, ...rest } = {}) => ({
		user: { id: 'u9', username: 'hanz' },
		member: { displayName: 'Hanz' },
		message: { delete: vi.fn().mockResolvedValue(undefined), ...message },
		reply: vi.fn().mockResolvedValue(undefined),
		followUp: vi.fn().mockResolvedValue(undefined),
		deferUpdate: vi.fn().mockResolvedValue(undefined),
		editReply: vi.fn().mockResolvedValue(undefined),
		update: vi.fn().mockResolvedValue(undefined),
		...rest
	});

	const listener = (executeCancel = vi.fn().mockResolvedValue({ content: 'Task **X** has been cancelled' })) => ({
		_denied: async () => false,
		container: {
			logger: { warn: vi.fn() },
			stores: { get: () => ({ get: () => ({ _executeCancel: executeCancel }) }) }
		}
	});

	it('dismisses a create card and keeps the dismissal on record', async () => {
		suggestions.createSuggestion({
			id: `dis-${n}`,
			channelId: 'dis-chan',
			sourceMessageId: `dis-src-${n}`,
			title: 'Latihan personal finance',
			assigneeId: 'u1',
			deadline: null
		});
		suggestions.setCardMessage(`dis-${n}`, `dis-card-${n}`);

		const i = interaction();
		await Listener.prototype._dismiss.call(listener(), i, `dis-${n}`);

		expect(i.message.delete).toHaveBeenCalledTimes(1);
		expect(i.editReply).not.toHaveBeenCalled();
		expect(suggestions.getSuggestion(`dis-${n}`)).toMatchObject({ status: 'dismissed', handled_by: 'u9' });
	});

	it('falls back to marking the card dismissed when it cannot be deleted', async () => {
		suggestions.createSuggestion({
			id: `dis2-${n}`,
			channelId: 'dis-chan',
			sourceMessageId: `dis-src2-${n}`,
			title: 'Latihan personal finance',
			assigneeId: 'u1',
			deadline: null
		});
		suggestions.setCardMessage(`dis2-${n}`, `dis-card2-${n}`);

		const i = interaction({ message: { delete: vi.fn().mockRejectedValue(new Error('Missing Permissions')) } });
		await Listener.prototype._dismiss.call(listener(), i, `dis2-${n}`);

		const embed = i.editReply.mock.calls[0][0].embeds[0].toJSON();
		expect(embed.title).toBe('Suggestion dismissed');
		expect(i.editReply.mock.calls[0][0].components).toEqual([]);
	});

	it('cancels the target task through /task cancel and closes the card', async () => {
		createPendingTask(`cancel-task-${n}`);
		suggestions.createSuggestion({
			id: `cancel-${n}`,
			channelId: 'cancel-chan',
			sourceMessageId: `cancel-src-${n}`,
			title: 'Pengecekan LPJ',
			assigneeId: 'u1',
			deadline: DateTime.now().setZone(zone).plus({ days: 1 }).toUnixInteger(),
			kind: 'cancel',
			targetTaskId: `cancel-task-${n}`
		});
		suggestions.setCardMessage(`cancel-${n}`, `cancel-card-${n}`);

		const executeCancel = vi.fn().mockResolvedValue({ content: 'Task **Pengecekan LPJ** has been cancelled' });
		const i = interaction();
		await Listener.prototype._cancelTask.call(listener(executeCancel), i, `cancel-${n}`);

		expect(executeCancel).toHaveBeenCalledTimes(1);
		expect(executeCancel.mock.calls[0][0]).toMatchObject({ task_id: `cancel-task-${n}` });
		expect(i.editReply.mock.calls[0][0].content).toContain('has been cancelled');
		expect(suggestions.getSuggestion(`cancel-${n}`)).toMatchObject({
			status: 'cancelled',
			handled_by: 'u9',
			task_id: `cancel-task-${n}`
		});
	});

	it('releases the card when the cancellation failed', async () => {
		createPendingTask(`cancel-fail-${n}`);
		suggestions.createSuggestion({
			id: `cancelfail-${n}`,
			channelId: 'cancel-chan',
			sourceMessageId: `cancelfail-src-${n}`,
			title: 'Pengecekan LPJ',
			assigneeId: 'u1',
			deadline: DateTime.now().setZone(zone).plus({ days: 1 }).toUnixInteger(),
			kind: 'cancel',
			targetTaskId: `cancel-fail-${n}`
		});

		const i = interaction();
		await Listener.prototype._cancelTask.call(
			listener(vi.fn().mockResolvedValue('Could not cancel task. No cancellation was recorded.')),
			i,
			`cancelfail-${n}`
		);

		expect(i.followUp.mock.calls[0][0].content).toContain('Could not cancel');
		expect(suggestions.getSuggestion(`cancelfail-${n}`).status).toBe('open');
	});

	it('keeps the task and closes the card', async () => {
		createPendingTask(`keep-task-${n}`);
		suggestions.createSuggestion({
			id: `keep-${n}`,
			channelId: 'keep-chan',
			sourceMessageId: `keep-src-${n}`,
			title: 'Pengecekan LPJ',
			assigneeId: 'u1',
			deadline: DateTime.now().setZone(zone).plus({ days: 1 }).toUnixInteger(),
			kind: 'cancel',
			targetTaskId: `keep-task-${n}`
		});

		const i = interaction();
		await Listener.prototype._keep.call(listener(), i, `keep-${n}`);

		expect(i.update.mock.calls[0][0].content).toContain('Kept **Pengecekan LPJ**');
		expect(suggestions.getSuggestion(`keep-${n}`)).toMatchObject({ status: 'kept', handled_by: 'u9' });
	});

	it('does not create a task from a cancellation card', async () => {
		suggestions.createSuggestion({
			id: `wrongkind-${n}`,
			channelId: 'kind-chan',
			sourceMessageId: `wrongkind-src-${n}`,
			title: 'Pengecekan LPJ',
			assigneeId: 'u1',
			deadline: DateTime.now().setZone(zone).plus({ days: 1 }).toUnixInteger(),
			kind: 'cancel',
			targetTaskId: `wrongkind-task-${n}`
		});

		const i = interaction();
		await Listener.prototype._create.call(listener(), i, `wrongkind-${n}`);

		expect(i.reply.mock.calls[0][0].content).toContain('not a task creation card');
		expect(suggestions.getSuggestion(`wrongkind-${n}`).status).toBe('open');
	});
});

describe('task suggestion wiring (source level)', () => {
	const listener = readFileSync(join(root, 'src/listeners/taskSuggestInteraction.js'), 'utf8');
	const interactionCreate = readFileSync(join(root, 'src/listeners/interactionCreate.js'), 'utf8');
	const messageCreate = readFileSync(join(root, 'src/listeners/messageCreate.js'), 'utf8');

	it('creates suggested tasks through the same path as /task add', () => {
		expect(listener).toContain('taskCommand.createTaskRecord');
		expect(listener).not.toContain('luce.appendBlock');
		expect(listener).not.toContain('createTaskWithReminders');
	});

	it('cancels suggested tasks through the same path as /task cancel', () => {
		expect(listener).toContain('taskCommand._executeCancel');
	});

	it('parses custom ids on the colon, not per character', () => {
		expect(listener).toContain("interaction.customId.split(':')");
		expect(interactionCreate).toContain("interaction.customId.split(':')");
		expect(listener).not.toContain("interaction.customId.split('')");
		expect(interactionCreate).not.toContain("interaction.customId.split('')");
	});

	it('claims a proposal before acting on it and checks permissions on every action', () => {
		expect(listener.match(/claimProposal\(/g).length).toBeGreaterThanOrEqual(3);
		expect(listener.match(/await this\._denied\(interaction\)/g)).toHaveLength(6);
	});

	it('feeds every non-bot message to the suggestion service', () => {
		expect(messageCreate).toContain('taskSuggest.observe(message)');
	});

	it('forgets single and bulk-deleted messages', () => {
		const single = readFileSync(join(root, 'src/listeners/messageDelete.js'), 'utf8');
		const bulk = readFileSync(join(root, 'src/listeners/messageDeleteBulk.js'), 'utf8');
		expect(single).toContain("event: 'messageDelete'");
		expect(single).toContain('taskSuggest.forgetMessage(message.channelId, message.id)');
		expect(bulk).toContain("event: 'messageDeleteBulk'");
		expect(bulk).toContain('taskSuggest.forgetMessage(channel.id, id)');
	});
});
