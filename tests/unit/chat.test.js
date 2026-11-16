import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import sharp from 'sharp';

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
	db.exec(readFileSync(join(root, 'migrations/030_add_global_memory.sql'), 'utf8'));
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
let globalMemory;
let media;

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
	delete process.env.CHAT_UNPROMPTED_ENABLED;
	delete process.env.CHAT_COOLDOWN_MS;
	delete process.env.CHAT_VISION_ENABLED;
	delete process.env.CHAT_GLOBAL_MEMORY_MAX;
	delete process.env.CHAT_GLOBAL_MEMORY_PER_DAY;

	chat = await import('../../src/services/chat.js');
	chatState = await import('../../src/database/repositories/chatState.repository.js');
	channelMemory = await import('../../src/database/repositories/channelMemory.repository.js');
	globalMemory = await import('../../src/database/repositories/globalMemory.repository.js');
	media = await import('../../src/lib/media/index.js');
	media._reset();
	chatState._reset();
	channelMemory._reset();
	globalMemory._reset();
	chat._reset();
});

afterEach(() => {
	chat._reset();
});

/** Minimal Discord channel double with no cached permissions. Sends are allowed. */
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

	it('treats a picture or a link card as a signal on its own', () => {
		expect(chat._signal([message({ content: '', hasVisuals: true })]).signal).toBe('image');
		expect(chat._signal([message({ content: 'ini poster' })]).signal).toBeNull();
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
		expect(decision).toEqual({ consider: true, reason: 'signal question' });
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

	it('only speaks when asked when unprompted talk is off', () => {
		process.env.CHAT_UNPROMPTED_ENABLED = 'false';
		expect(chat._consider(stateWith()).reason).toBe('unprompted talk is disabled');
		// A mention still goes through.
		expect(chat._consider(stateWith(), { trigger: message() })).toEqual({ consider: true, reason: 'mentioned' });
	});

	it('does not join a busy channel after being ignored', () => {
		const now = Date.now();
		const busy = Array.from({ length: 6 }, (_, i) =>
			message({ id: `m${i}`, authorId: `u${i % 3}`, content: 'wkwk', createdAt: now - i * 1000 })
		);
		chatState.noteIgnored('c1');
		expect(chat._consider(stateWith(busy), { now, random: () => 0 }).consider).toBe(false);
	});

	it('answers a correction even while backing off', () => {
		chatState.setBackoffUntil('c1', Math.floor(Date.now() / 1000) + 3600);
		expect(chat._consider(stateWith()).reason).toBe('backing off after being ignored');
		expect(chat._consider(stateWith(), { trigger: message(), scold: true })).toEqual({
			consider: true,
			reason: 'corrected'
		});
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
		expect(chat._sanitize('"eh — coba ini @everyone"')).toBe('eh.');
		expect(chat._sanitize('"coba ini @everyone"')).toBe('coba ini everyone');
	});

	it('removes emojis', () => {
		expect(chat._sanitize('gas 🔥 aja')).toBe('gas aja');
	});

	it('caps the length', () => {
		process.env.CHAT_MAX_MESSAGE_CHARS = '20';
		expect(chat._sanitize('a'.repeat(100)).length).toBeLessThanOrEqual(21);
	});

	it('keeps the leading clause and drops what follows a clause comma', () => {
		expect(chat._sanitize('oh iya deng, di posternya 7-10 menit')).toBe('oh iya deng');
		expect(chat._sanitize('7-10 menit, harusnya aman')).toBe('7-10 menit');
		expect(chat._sanitize('di posternya 7-10 menit, jadi aman')).toBe('di posternya 7-10 menit');
	});

	it('leaves a list of items alone', () => {
		expect(chat._sanitize('elektro, komputer, elektronika, telekomunikasi')).toBe(
			'elektro, komputer, elektronika, telekomunikasi'
		);
		expect(chat._sanitize('prodi elektro, informatika, sistem informasi')).toBe(
			'prodi elektro, informatika, sistem informasi'
		);
		expect(chat._sanitize('elektro, komputer, dan informatika')).toBe('elektro, komputer, dan informatika');
		// Two segments joined by "dan" is a clause, not a list.
		expect(chat._sanitize('aman kok, dan harusnya gitu')).toBe('aman kok');
	});

	it('does not touch a decimal comma or a comma inside a link', () => {
		expect(chat._sanitize('1,5 menit doang')).toBe('1,5 menit doang');
		expect(chat._sanitize('cek https://example.com/a,b?x=1,y=2 dulu')).toBe(
			'cek https://example.com/a,b?x=1,y=2 dulu'
		);
	});

	it('drops a sentence that only recaps the answer', () => {
		expect(chat._sanitize('sisanya sudah jelas, intinya gitu')).toBe('');
		expect(chat._sanitize('di posternya 7-10 menit. sisanya sudah jelas')).toBe('di posternya 7-10 menit.');
	});

	it('posts only the first sentence, because a second one is nobody asked for it', () => {
		expect(chat._sanitize('oh iya deng. di poster nggak ada daftar prodi')).toBe('oh iya deng.');
		expect(chat._sanitize('di posternya 7-10 menit. oh iya deng')).toBe('di posternya 7-10 menit.');
		expect(chat._sanitize('oh iya deng. 7-10 menit kok. sisanya jelas')).toBe('oh iya deng.');
		expect(chat._sanitize('deadline 30 Juni\nisinya 7-10 menit')).toBe('deadline 30 Juni');
	});

	it('falls through a recap opener to the sentence that actually says something', () => {
		expect(chat._sanitize('intinya gitu. di posternya 7-10 menit')).toBe('di posternya 7-10 menit');
	});
});

describe('chat._dropClauses', () => {
	it('turns a dash into a sentence break instead of a comma', () => {
		expect(chat._plain('eh — coba ini')).toBe('eh. coba ini');
	});

	it('leaves a single clause with no comma alone', () => {
		expect(chat._dropClauses('7-10 menit kok')).toBe('7-10 menit kok');
	});
});

describe('chat._sanitize apology', () => {
	it('keeps two sentences and does not split on a dash', () => {
		expect(chat._sanitize('Maaf, aku salah soal deadline. Ini yang benar 7-10 menit', { apology: true })).toBe(
			'Maaf, aku salah soal deadline. Ini yang benar 7-10 menit'
		);
		expect(chat._sanitize('Maaf — aku salah soal deadline', { apology: true })).toBe(
			'Maaf aku salah soal deadline'
		);
	});

	it('drops a recap sentence and keeps the apology', () => {
		expect(chat._sanitize('Maaf, aku salah. Intinya gitu', { apology: true })).toBe('Maaf, aku salah.');
	});

	it('leaves the ordinary one-sentence rule alone', () => {
		expect(chat._sanitize('oh iya deng. 7-10 menit kok')).toBe('oh iya deng.');
	});
});

describe('chat._isScold', () => {
	it('spots a correction aimed at the bot', () => {
		expect(chat._isScold('kamu salah soal deadline')).toBe(true);
		expect(chat._isScold('jangan ngasal')).toBe(true);
		expect(chat._isScold('salah deh')).toBe(true);
		expect(chat._isScold('bot ngaco')).toBe(true);
	});

	it('leaves an ordinary message alone', () => {
		expect(chat._isScold('salah satu dari dua itu mana?')).toBe(false);
		expect(chat._isScold('cek posternya')).toBe(false);
		expect(chat._isScold('gimana caranya?')).toBe(false);
	});
});

describe('chat._isHostile', () => {
	it('drops an insult and keeps a self-correction', () => {
		expect(chat._isHostile('kamu bodoh banget')).toBe(true);
		expect(chat._isHostile('dasar bot')).toBe(true);
		expect(chat._isHostile('tadi aku sotoy')).toBe(false);
		expect(chat._isHostile('7-10 menit kok')).toBe(false);
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
		expect(system.content).toContain('Jangan bercanda secara default');
		expect(system.content).toContain('jangan jawab sendiri');
		expect(system.content).toContain('Jangan pernah bilang seseorang kurang kreatif');
		expect(system.content).toContain('Jangan pakai emoji');
		expect(system.content).toContain('<search_results>');
	});

	it('tells a mentioned reply to answer briefly instead of holding forth', () => {
		const [system] = chat._buildPrompt({
			channel: { id: 'c1', name: 'general' },
			messages: [message()],
			notes: [],
			profiles: new Map(),
			recentSaid: [],
			trigger: message({ authorId: 'u1', id: 'm1', replyToId: 'm0' }),
			people: new Map([['u1', 'Alice']])
		});
		// The mention names the trigger and the message it answers, so the model
		// can find the question instead of summarising whatever is on screen.
		expect(system.content).toContain('Kamu disebut langsung oleh Alice di pesan id=m1');
		expect(system.content).toContain('membalas id=m0');
		expect(system.content).toContain('jangan berpidato');
	});

	it('tells the model that frames of one GIF are the same animation', () => {
		const [system] = chat._buildPrompt({
			channel: { id: 'c1', name: 'general' },
			messages: [message()],
			notes: [],
			profiles: new Map(),
			recentSaid: [],
			trigger: null,
			people: new Map()
		});
		expect(system.content).toContain('animasi yang sama');
		expect(system.content).toContain('[embed]');
	});

	it('leaves the user turn as a string when there are no pictures', () => {
		const [, user] = chat._buildPrompt({
			channel: { id: 'c1', name: 'general' },
			messages: [message()],
			notes: [],
			profiles: new Map(),
			recentSaid: [],
			trigger: null,
			people: new Map()
		});
		expect(typeof user.content).toBe('string');
	});

	it('attaches pictures as parts, each labelled with its message and GIF frame', () => {
		const [, user] = chat._buildPrompt({
			channel: { id: 'c1', name: 'general' },
			messages: [message({ content: 'ini posternya', hasVisuals: true })],
			notes: [],
			profiles: new Map(),
			recentSaid: [],
			trigger: null,
			people: new Map([['u1', 'Alice']]),
			imageParts: [
				{
					messageId: 'm1',
					authorId: 'u1',
					label: 'GIF "x.gif" frame 1/18 (0% durasi)',
					dataUrl: 'data:image/jpeg;base64,AAA'
				},
				{
					messageId: 'm1',
					authorId: 'u1',
					label: 'GIF "x.gif" frame 5/18 (24% durasi)',
					dataUrl: 'data:image/jpeg;base64,BBB'
				}
			]
		});

		expect(Array.isArray(user.content)).toBe(true);
		expect(user.content[0]).toEqual({ type: 'text', text: expect.stringContaining('ini posternya') });
		expect(user.content[1].text).toContain('Gambar 1 dari 2');
		expect(user.content[1].text).toContain('oleh Alice');
		expect(user.content[1].text).toContain('frame 1/18');
		expect(user.content[2]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA' } });
		expect(user.content[3].text).toContain('frame 5/18');
		expect(user.content[4]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBB' } });
	});

	it('shows the reply chain so a correction is visibly aimed at a message', () => {
		const [, user] = chat._buildPrompt({
			channel: { id: 'c1', name: 'general' },
			messages: [
				message({ id: 'm0', authorId: 'u1', content: 'berapa menit nihnya' }),
				message({ id: 'm1', authorId: 'u2', content: 'cek posternya', replyToId: 'm0' })
			],
			notes: [],
			profiles: new Map(),
			recentSaid: [],
			trigger: null,
			people: new Map([
				['u1', 'Agus'],
				['u2', 'Hanz']
			])
		});
		expect(user.content).toContain('id=m1');
		expect(user.content).toContain('(balas ke id=m0)');
	});

	it('shows its own earlier messages with an id so it can take one back', () => {
		const [, user] = chat._buildPrompt({
			channel: { id: 'c1', name: 'general' },
			messages: [message()],
			notes: [],
			profiles: new Map(),
			recentSaid: [{ note: 'D3/D4 dan S1-S2 dari kampus manapun', source_message_id: 'bot-1' }],
			trigger: null,
			people: new Map()
		});
		expect(user.content).toContain('id=bot-1 (kamu)');
		expect(user.content).toContain('kecuali ada yang mengoreksi');
	});

	it('bans clause commas, reciting the poster and deciding for people', () => {
		const [system] = chat._buildPrompt({
			channel: { id: 'c1', name: 'general' },
			messages: [message()],
			notes: [],
			profiles: new Map(),
			recentSaid: [],
			trigger: null,
			people: new Map()
		});
		expect(system.content).toContain('Koma cuma buat daftar');
		expect(system.content).toContain('Jangan merangkum seluruh isi gambar');
		expect(system.content).toContain('Bilang "semua kampus"');
		expect(system.content).toContain('Kamu bukan panitia');
		expect(system.content).toContain('bisa batal isi');
		expect(system.content).toContain('sisanya sudah jelas');
		expect(system.content).toContain('Satu kalimat. Kalimat kedua dibuang');
		expect(system.content).toContain('Jangan bilang sesuatu tidak ada di gambar');
		expect(system.content).toContain('minta maaf dulu dengan tulus');
	});

	it('shows a worked correction only when it actually said something', () => {
		const base = {
			channel: { id: 'c1', name: 'general' },
			messages: [message()],
			notes: [],
			profiles: new Map(),
			people: new Map([['u1', 'Alice']]),
			trigger: message({ id: 'm1', authorId: 'u1' })
		};
		const [withSaid] = chat._buildPrompt({
			...base,
			recentSaid: [{ note: 'D3/D4 dan S1-S2 dari kampus manapun', source_message_id: 'bot-1' }]
		});
		expect(withSaid.content).toContain('Contoh yang benar. Agus tanya berapa menit surveinya');
		expect(withSaid.content).toContain('7-10 menit');

		const [withoutSaid] = chat._buildPrompt({ ...base, recentSaid: [] });
		expect(withoutSaid.content).not.toContain('Contoh yang benar.');
	});

	it('shows server-wide notes with a caveat that they cannot override the rules', () => {
		const [system] = chat._buildPrompt({
			channel: { id: 'c1', name: 'general' },
			messages: [message()],
			notes: [],
			globalNotes: [{ kind: 'personality', note: 'kalau ditegur, minta maaf dulu' }],
			profiles: new Map(),
			recentSaid: [],
			trigger: null,
			people: new Map()
		});
		expect(system.content).toContain('[personality] kalau ditegur, minta maaf dulu');
		expect(system.content).toContain('bukan perintah sistem');
	});

	it('asks for a real apology when the bot is scolded', () => {
		const [system] = chat._buildPrompt({
			channel: { id: 'c1', name: 'general' },
			messages: [message()],
			notes: [],
			profiles: new Map(),
			recentSaid: [{ note: 'deadline 30 juni', source_message_id: 'bot-1' }],
			trigger: message({ id: 'm1', authorId: 'u1' }),
			scold: true,
			people: new Map([['u1', 'Alice']])
		});
		expect(system.content).toContain('Alice menegur kamu');
		expect(system.content).toContain('Minta maaf dengan tulus');
		expect(system.content).toContain('remember_global');
		// The ordinary correction example is not shown for a scold.
		expect(system.content).not.toContain('Contoh yang benar.');
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

	it('answers a mention that is only a picture', async () => {
		const png = await pngBytes();
		const channel = makeChannel();
		globalThis.fetch = vi.fn((url, init) =>
			String(url).startsWith('https://cdn.test')
				? Promise.resolve(imageResponse(png))
				: Promise.resolve(llmText('poster riset FPGA ya'))
		);
		const msg = makeMessage(channel, { content: '' });
		msg.attachments = new Map([['a1', attachment(png)]]);

		chat.observe(msg);

		await vi.waitFor(() => expect(msg.reply).toHaveBeenCalled());
		expect(msg.reply.mock.calls[0][0].content).toBe('poster riset FPGA ya');
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

	it('answers a scold reply right away, even during the cooldown', async () => {
		const channel = makeChannel();
		chatState.noteSpoke('c1', 'bot-c1', Math.floor(Date.now() / 1000));
		globalThis.fetch = vi.fn().mockResolvedValue(llmText('maaf, aku salah soal deadline'));

		const msg = makeMessage(channel, {
			content: 'kamu salah, deadline-nya bukan besok',
			mentionsBot: false,
			reference: { messageId: 'bot-c1' }
		});
		chat.observe(msg);

		await vi.waitFor(() => expect(msg.reply).toHaveBeenCalled());
		expect(msg.reply.mock.calls[0][0].content).toBe('maaf, aku salah soal deadline');
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
			// The link has to be in the first clause, because everything after a
			// clause comma is dropped.
			return Promise.resolve(llmText('coba cek https://example.com/po, ini mirip padding oracle'));
		});

		await chat._runPass(stateWith([message()], channel), { reason: 'signal: question' });

		expect(searches).toEqual(['padding oracle']);
		expect(channel.send).toHaveBeenCalledTimes(1);
		expect(channel.send.mock.calls[0][0].content).toContain('https://example.com/po');
	});

	it('filters a clause comma out of the posted text', async () => {
		const channel = makeChannel();
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(
				llmText(
					'Posternya bilang D3/D4 dan S1-S2 dari kampus manapun, sedangkan chatnya cuma elektro dan komputer. Sisanya sudah jelas.'
				)
			);

		await chat._runPass(stateWith([message()], channel), { reason: 'signal: image' });

		expect(channel.send).toHaveBeenCalledTimes(1);
		expect(channel.send.mock.calls[0][0].content).toBe('Posternya bilang D3/D4 dan S1-S2 dari kampus manapun');
	});

	it('stays silent when the reply is nothing but filler after filtering', async () => {
		const channel = makeChannel();
		globalThis.fetch = vi.fn().mockResolvedValue(llmText('Sisanya sudah jelas, intinya gitu'));

		await chat._runPass(stateWith([message()], channel), { reason: 'signal: image' });

		expect(channel.send).not.toHaveBeenCalled();
	});

	it('drops a reply that insults someone instead of posting it', async () => {
		const channel = makeChannel();
		globalThis.fetch = vi.fn().mockResolvedValue(llmText('kamu bodoh banget'));

		await chat._runPass(stateWith([message()], channel), { reason: 'signal: question' });

		expect(channel.send).not.toHaveBeenCalled();
	});

	it('does not offer remember_global on an unprompted pass', async () => {
		const channel = makeChannel();
		const bodies = [];
		globalThis.fetch = vi.fn((url, init) => {
			bodies.push(JSON.parse(init.body));
			return Promise.resolve(llmText('oke'));
		});

		await chat._runPass(stateWith([message()], channel), { reason: 'signal: question' });

		expect(bodies[0].tools.map(t => t.function.name)).not.toContain('remember_global');
	});

	it('offers remember_global when answering a scold and saves the note', async () => {
		const channel = makeChannel();
		const bodies = [];
		globalThis.fetch = vi.fn((url, init) => {
			bodies.push(JSON.parse(init.body));
			if (bodies.length === 1) {
				return Promise.resolve(
					llmTool('remember_global', { note: 'kalau ditegur minta maaf dulu', kind: 'personality' })
				);
			}
			return Promise.resolve(llmText('oke, aku catat'));
		});

		const trigger = message({
			id: 'm1',
			authorId: 'u1',
			content: 'kamu salah',
			reply: vi.fn().mockResolvedValue({ id: 'bot-reply' })
		});
		await chat._runPass(stateWith([trigger], channel), { trigger, reason: 'corrected', scold: true });

		expect(bodies[0].tools.map(t => t.function.name)).toContain('remember_global');
		const notes = globalMemory.listNotes();
		expect(notes.map(n => n.note)).toContain('kalau ditegur minta maaf dulu');
		expect(notes[0].added_by).toBe('u1');
	});
});

/** A 4x4 PNG, enough for sharp to decode without a fixture file. */
async function pngBytes() {
	return sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } })
		.png()
		.toBuffer();
}

const imageResponse = bytes => ({
	ok: true,
	headers: { get: () => String(bytes.length) },
	arrayBuffer: () => Promise.resolve(bytes)
});

const attachment = (bytes, overrides = {}) => ({
	id: 'a1',
	name: 'poster.png',
	contentType: 'image/png',
	size: bytes.length,
	url: 'https://cdn.test/poster.png',
	...overrides
});

describe('chat vision', () => {
	it('sends an attachment to the model as an image part', async () => {
		const png = await pngBytes();
		const channel = makeChannel();
		const modelBodies = [];
		globalThis.fetch = vi.fn((url, init) => {
			if (String(url).startsWith('https://cdn.test')) {
				return Promise.resolve(imageResponse(png));
			}
			modelBodies.push(JSON.parse(init.body));
			return Promise.resolve(llmText('poster riset FPGA ya, batasnya 30 juni'));
		});

		const msg = message({
			content: 'ikut survey ini ya\n[gambar "poster.png", 1080x1350]',
			createdAt: Date.now(),
			hasVisuals: true,
			attachments: [attachment(png)]
		});
		await chat._runPass(stateWith([msg], channel), { reason: 'signal: image' });

		expect(channel.send).toHaveBeenCalledTimes(1);
		const parts = modelBodies[0].messages[1].content;
		expect(Array.isArray(parts)).toBe(true);
		expect(parts[0].text).toContain('[gambar "poster.png"');
		expect(parts[1].text).toContain('dari pesan id=m1');
		expect(parts[2].type).toBe('image_url');
		expect(parts[2].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
	});

	it('retries without images when the provider cannot see them', async () => {
		const png = await pngBytes();
		const channel = makeChannel();
		const modelBodies = [];
		globalThis.fetch = vi.fn((url, init) => {
			if (String(url).startsWith('https://cdn.test')) {
				return Promise.resolve(imageResponse(png));
			}
			modelBodies.push(JSON.parse(init.body));
			if (modelBodies.length === 1) {
				return Promise.resolve({
					ok: false,
					status: 400,
					text: () => Promise.resolve('{"error":{"message":"model does not support image input"}}')
				});
			}
			return Promise.resolve(llmText('poster riset FPGA ya'));
		});

		const msg = message({ content: 'ini poster', hasVisuals: true, attachments: [attachment(png)] });
		await chat._runPass(stateWith([msg], channel), { reason: 'signal: image' });

		expect(modelBodies).toHaveLength(2);
		expect(Array.isArray(modelBodies[0].messages[1].content)).toBe(true);
		expect(typeof modelBodies[1].messages[1].content).toBe('string');
		expect(channel.send).toHaveBeenCalledTimes(1);
	});

	it('keeps the message when its picture cannot be downloaded', async () => {
		const channel = makeChannel();
		const modelBodies = [];
		globalThis.fetch = vi.fn((url, init) => {
			if (String(url).startsWith('https://cdn.test')) {
				return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('gone') });
			}
			modelBodies.push(JSON.parse(init.body));
			return Promise.resolve(llmText('posternya nggak kebuka, coba kirim ulang'));
		});

		const msg = message({
			content: 'ini poster',
			hasVisuals: true,
			attachments: [attachment(Buffer.alloc(0))]
		});
		await chat._runPass(stateWith([msg], channel), { reason: 'signal: image' });

		expect(typeof modelBodies[0].messages[1].content).toBe('string');
		expect(modelBodies[0].messages[1].content).toContain('ini poster');
		expect(channel.send).toHaveBeenCalledTimes(1);
	});
});
