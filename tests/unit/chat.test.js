import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';

const root = join(import.meta.dirname, '../..');

// The service persists state through the real repositories, which open
// ctfbot.db in the working directory. Run the whole file in a scratch
// directory holding a fresh database with just the tables it uses.
let tmpDir;
let originalCwd;
const originalEnv = { ...process.env };

beforeAll(() => {
	originalCwd = process.cwd();
	tmpDir = mkdtempSync(join(tmpdir(), 'ctfbot-chat-'));
	const db = new Database(join(tmpDir, 'ctfbot.db'));
	db.exec(readFileSync(join(root, 'migrations/027_add_actor_memory.sql'), 'utf8'));
	db.exec(readFileSync(join(root, 'migrations/028_add_proactive_chat.sql'), 'utf8'));
	db.close();
	process.chdir(tmpDir);
});

afterAll(async () => {
	const { closeConnection } = await import('../../src/database/connection.js');
	closeConnection();
	process.chdir(originalCwd);
	rmSync(tmpDir, { recursive: true, force: true });
});

let chat;
let chatState;
let channelMemory;

beforeEach(async () => {
	vi.resetModules();
	process.env = { ...originalEnv };
	process.env.CHAT_ENABLED = 'true';
	process.env.OPENAI_API_KEY = 'sk-test';
	process.env.OPENAI_MODEL = 'test-model';
	process.env.OPENAI_BASE_URL = 'https://example.test/v1';
	delete process.env.CHAT_DENY_CHANNEL_IDS;
	delete process.env.CHAT_MAX_PER_HOUR;
	delete process.env.CHAT_MAX_PER_DAY;
	delete process.env.CHAT_GUILD_MAX_PER_DAY;
	delete process.env.CHAT_SPARK_PROBABILITY;
	delete process.env.CHAT_COOLDOWN_MS;

	chat = await import('../../src/services/chat.js');
	chatState = await import('../../src/database/repositories/chatState.repository.js');
	channelMemory = await import('../../src/database/repositories/channelMemory.repository.js');
	chatState._reset();
	channelMemory._reset();
	chat._reset();
});

afterEach(() => {
	chat._reset();
});

/** Minimal Discord channel double: no cached permissions, so sends are allowed. */
function makeChannel({ id = 'c1', name = 'general', guildId = 'g1' } = {}) {
	return {
		id,
		name,
		guildId,
		guild: { members: { me: null } },
		messages: { fetch: vi.fn().mockResolvedValue(new Map()) },
		send: vi.fn().mockResolvedValue({ id: `bot-${id}` }),
		sendTyping: vi.fn().mockResolvedValue(undefined)
	};
}

function message(overrides = {}) {
	return {
		id: 'm1',
		authorId: 'u1',
		content: 'gimana cara solve challenge ini?',
		createdAt: Date.now(),
		...overrides
	};
}

function stateWith(messages = [message()], channel = makeChannel()) {
	return { channel, messages, people: new Map([['u1', 'Alice']]), lastBotMessageId: null };
}

const llmText = content => ({
	ok: true,
	json: () => Promise.resolve({ choices: [{ message: { role: 'assistant', content } }] })
});

const llmTool = (name, args) => ({
	ok: true,
	json: () =>
		Promise.resolve({
			choices: [
				{
					message: {
						role: 'assistant',
						content: null,
						tool_calls: [
							{ id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(args) } }
						]
					}
				}
			]
		})
});

describe('chat._signal', () => {
	it('spots a question, a link, a problem and a verifiable claim', () => {
		expect(chat._signal([message({ content: 'ini gimana?' })]).signal).toBe('question');
		expect(chat._signal([message({ content: 'coba deh gimana caranya' })]).signal).toBe('question');
		expect(chat._signal([message({ content: 'liat https://example.com aja' })]).signal).toBe('link');
		expect(chat._signal([message({ content: 'buildnya gagal terus' })]).signal).toBe('problem');
		expect(chat._signal([message({ content: 'katanya servernya down' })]).signal).toBe('claim');
	});

	it('finds no signal in plain chatter', () => {
		const result = chat._signal([message({ content: 'wkwk iya bener' }), message({ id: 'm2', content: 'sip' })]);
		expect(result.signal).toBeNull();
		expect(result.busy).toBe(false);
	});

	it('marks a channel busy only when enough different people talked recently', () => {
		const now = Date.now();
		const many = Array.from({ length: 6 }, (_, i) =>
			message({ id: `m${i}`, authorId: `u${i % 3}`, content: 'wkwk', createdAt: now - i * 1000 })
		);
		expect(chat._signal(many, now).busy).toBe(true);
		// Six messages from one person is a monologue, not a conversation.
		const solo = many.map(m => ({ ...m, authorId: 'u1' }));
		expect(chat._signal(solo, now).busy).toBe(false);
		// Old messages do not count.
		const old = many.map(m => ({ ...m, createdAt: now - 60 * 60 * 1000 }));
		expect(chat._signal(old, now).busy).toBe(false);
	});
});

describe('chat._consider', () => {
	it('spends a model call on a question', () => {
		const decision = chat._consider(stateWith());
		expect(decision).toEqual({ consider: true, reason: 'signal: question' });
	});

	it('stays out of plain chatter', () => {
		const decision = chat._consider(stateWith([message({ content: 'wkwk' })]));
		expect(decision.consider).toBe(false);
		expect(decision.reason).toBe('nothing worth a model call');
	});

	it('sometimes joins a busy channel with no explicit signal', () => {
		const now = Date.now();
		const busy = Array.from({ length: 6 }, (_, i) =>
			message({ id: `m${i}`, authorId: `u${i % 3}`, content: 'wkwk', createdAt: now - i * 1000 })
		);
		expect(chat._consider(stateWith(busy), { now, random: () => 0 }).consider).toBe(true);
		expect(chat._consider(stateWith(busy), { now, random: () => 0.99 }).consider).toBe(false);
	});

	it('respects a mute, and only in the muted channel', () => {
		chat._muteChannel('c1', { by: 'u1' });
		expect(chat._consider(stateWith()).reason).toBe('channel is muted');
		expect(chat._consider(stateWith([message()], makeChannel({ id: 'c2' }))).consider).toBe(true);
	});

	it('lifts the mute once the stored time has passed', () => {
		chatState.setMutedUntil('c1', Math.floor(Date.now() / 1000) - 1);
		expect(chat._consider(stateWith()).consider).toBe(true);
	});

	it('respects the channel denylist', () => {
		process.env.CHAT_DENY_CHANNEL_IDS = 'c1,c9';
		expect(chat._consider(stateWith()).reason).toBe('channel is on the denylist');
	});

	it('never treats its own message as a reason to speak again', () => {
		chatState.noteSpoke('c1', 'bot-1', Math.floor(Date.now() / 1000));
		const older = [message({ createdAt: Date.now() - 60_000 })];
		expect(chat._consider(stateWith(older)).reason).toBe('no human message since the last one');
	});

	it('waits out the cooldown after speaking', () => {
		const nowSec = Math.floor(Date.now() / 1000);
		chatState.noteSpoke('c1', 'bot-1', nowSec);
		const after = [message({ createdAt: (nowSec + 1) * 1000 })];
		expect(chat._consider(stateWith(after)).reason).toBe('cooldown');
	});

	it('answers a mention even during the cooldown', () => {
		const nowSec = Math.floor(Date.now() / 1000);
		chatState.noteSpoke('c1', 'bot-1', nowSec);
		const after = [message({ createdAt: (nowSec + 1) * 1000 })];
		const decision = chat._consider(stateWith(after), { trigger: after[0] });
		expect(decision).toEqual({ consider: true, reason: 'mentioned' });
	});

	it('stops when the daily budget is used up', () => {
		process.env.CHAT_MAX_PER_DAY = '1';
		chatState.consumeBudget({ channelId: 'c1', guildId: 'g1' });
		expect(chat._consider(stateWith()).reason).toBe('daily budget (1) reached');
	});

	it('stops when the guild budget is used up', () => {
		process.env.CHAT_GUILD_MAX_PER_DAY = '1';
		chatState.consumeBudget({ channelId: 'other', guildId: 'g1' });
		expect(chat._consider(stateWith()).reason).toBe('guild daily budget (1) reached');
	});
});

describe('chat._backoffUntil', () => {
	it('is patient at first, then quiet for a while, then until tomorrow', () => {
		const now = Date.now();
		expect(chat._backoffUntil(0, now)).toBeNull();
		expect(chat._backoffUntil(1, now)).toBeNull();
		expect(chat._backoffUntil(2, now)).toBe(Math.floor((now + 20 * 60_000) / 1000));
		// Four ignored messages silence the channel until the next local midnight.
		const until = chat._backoffUntil(4, now);
		const nowSec = Math.floor(now / 1000);
		expect(until).toBeGreaterThan(nowSec);
		expect(until).toBeLessThanOrEqual(nowSec + 24 * 3600);
	});
});

describe('chat._sanitize', () => {
	it('removes em dashes, @everyone and surrounding quotes', () => {
		expect(chat._sanitize('"eh — coba ini @everyone"')).toBe('eh, coba ini everyone');
	});

	it('caps the length', () => {
		process.env.CHAT_MAX_MESSAGE_CHARS = '20';
		expect(chat._sanitize('a'.repeat(100)).length).toBeLessThanOrEqual(21);
	});
});

describe('chat prompt', () => {
	it('tells the model how to open, when to stay silent and never to belittle people', () => {
		const [system] = chat._buildPrompt({
			channel: { id: 'c1', name: 'general' },
			messages: [message()],
			notes: [],
			profiles: new Map(),
			recentSaid: [],
			trigger: null,
			people: new Map([['u1', 'Alice']])
		});
		expect(system.content).toContain('stay_silent');
		expect(system.content).toContain('gimana kalau');
		expect(system.content).toContain('menurutku');
		expect(system.content).toContain('Humor setting: 10%');
		expect(system.content).toContain('jangan jawab sendiri');
		expect(system.content).toContain('Jangan pernah bilang seseorang kurang kreatif');
		expect(system.content).toContain('<search_results>');
	});

	it('tells a mentioned reply to answer briefly instead of holding forth', () => {
		const [system] = chat._buildPrompt({
			channel: { id: 'c1', name: 'general' },
			messages: [message()],
			notes: [],
			profiles: new Map(),
			recentSaid: [],
			trigger: message(),
			people: new Map()
		});
		expect(system.content).toContain('baru disebut langsung');
	});
});

describe('chat.observe', () => {
	/** A message double good enough for the mention and engagement checks. */
	const makeMessage = (channel, { content = 'gimana ini?', mentionsBot = true, reference = null } = {}) => ({
		id: 'm1',
		author: { id: 'u1', username: 'Alice', bot: false },
		member: { displayName: 'Alice' },
		guild: { id: 'g1' },
		guildId: 'g1',
		channel,
		channelId: channel.id,
		content,
		createdTimestamp: Date.now(),
		mentions: {
			users: new Map(mentionsBot ? [['bot-1', { id: 'bot-1', username: 'ctfbot', bot: true }]] : []),
			members: new Map(),
			roles: new Map()
		},
		client: { user: { id: 'bot-1' } },
		reference,
		reply: vi.fn().mockResolvedValue({ id: 'bot-reply' })
	});

	it('answers a mention right away in a normal channel', async () => {
		const channel = makeChannel();
		const msg = makeMessage(channel);
		globalThis.fetch = vi.fn().mockResolvedValue(llmText('oke ini ya'));

		chat.observe(msg);

		await vi.waitFor(() => expect(msg.reply).toHaveBeenCalled());
		expect(msg.reply.mock.calls[0][0].content).toBe('oke ini ya');
		expect(msg.reply.mock.calls[0][0].allowedMentions).toEqual({ parse: [], repliedUser: false });
	});

	it('leaves a mention in a governance channel to the task service', async () => {
		process.env.TASK_SUGGESTIONS_ENABLED = 'true';
		const constants = await import('../../src/lib/constants/config.js');
		const channel = makeChannel({ name: 'governance' });
		channel.parentId = constants.GOVERNANCE_CATEGORIES[0];
		globalThis.fetch = vi.fn();

		chat.observe(makeMessage(channel));
		await new Promise(resolve => setTimeout(resolve, 20));

		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(channel.send).not.toHaveBeenCalled();
	});

	it('mutes the channel when told to be quiet in a reply', async () => {
		const channel = makeChannel();
		chatState.noteSpoke('c1', 'bot-c1', Math.floor(Date.now() / 1000));
		globalThis.fetch = vi.fn();

		chat.observe(
			makeMessage(channel, { content: 'diem aja', mentionsBot: false, reference: { messageId: 'bot-c1' } })
		);

		const row = chatState.getState('c1');
		expect(row.muted_until).toBeGreaterThan(Math.floor(Date.now() / 1000));
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('does not mute the channel when two members tell each other to be quiet', async () => {
		const channel = makeChannel();
		chat.observe(makeMessage(channel, { content: 'diem aja', mentionsBot: false }));
		expect(chatState.getState('c1').muted_until).toBeNull();
	});
});

describe('chat._runPass', () => {
	it('posts the model text and records it as something it already said', async () => {
		const channel = makeChannel();
		globalThis.fetch = vi.fn().mockResolvedValue(llmText('menurutku coba baca ulang bagian padding-nya dulu'));

		await chat._runPass(stateWith([message()], channel), { reason: 'signal: question' });

		expect(channel.send).toHaveBeenCalledTimes(1);
		expect(channel.send.mock.calls[0][0].content).toBe('menurutku coba baca ulang bagian padding-nya dulu');
		expect(channel.send.mock.calls[0][0].allowedMentions).toEqual({ parse: [] });
		expect(channelMemory.recentSaid('c1', 1)).toEqual(['menurutku coba baca ulang bagian padding-nya dulu']);
		expect(chatState.getState('c1').last_spoke_message_id).toBe('bot-c1');
	});

	it('stays silent when the model calls stay_silent', async () => {
		const channel = makeChannel();
		globalThis.fetch = vi.fn().mockResolvedValue(llmTool('stay_silent', { reason: 'dua orang lagi ngobrol' }));

		await chat._runPass(stateWith([message()], channel), { reason: 'signal: question' });

		expect(channel.send).not.toHaveBeenCalled();
		expect(chatState.getState('c1').last_spoke_at).toBeNull();
	});

	it('treats an empty reply as silence', async () => {
		const channel = makeChannel();
		globalThis.fetch = vi.fn().mockResolvedValue(llmText('   '));
		await chat._runPass(stateWith([message()], channel), { reason: 'signal: question' });
		expect(channel.send).not.toHaveBeenCalled();
	});

	it('does not post when the model call fails', async () => {
		const channel = makeChannel();
		globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('boom') });
		await chat._runPass(stateWith([message()], channel), { reason: 'signal: question' });
		expect(channel.send).not.toHaveBeenCalled();
	});

	it('can search before answering, and the tool result reaches the model', async () => {
		process.env.SERPBASE_API_KEY = 'sk-test';
		const channel = makeChannel();
		const searches = [];
		globalThis.fetch = vi.fn((url, init) => {
			if (String(url).includes('serpbase')) {
				searches.push(JSON.parse(init.body).q);
				return Promise.resolve({
					ok: true,
					json: () =>
						Promise.resolve({
							status: 0,
							credits_charged: 1,
							organic: [
								{ title: 'Padding oracle', link: 'https://example.com/po', snippet: 'a CBC attack' }
							],
							people_also_ask: []
						})
				});
			}
			// First model call asks for a search, the second answers with the link.
			if (searches.length === 0) {
				return Promise.resolve(llmTool('search_web', { query: 'padding oracle' }));
			}
			return Promise.resolve(llmText('eh ini mirip padding oracle, coba cek https://example.com/po'));
		});

		await chat._runPass(stateWith([message()], channel), { reason: 'signal: question' });

		expect(searches).toEqual(['padding oracle']);
		expect(channel.send).toHaveBeenCalledTimes(1);
		expect(channel.send.mock.calls[0][0].content).toContain('https://example.com/po');
	});
});
