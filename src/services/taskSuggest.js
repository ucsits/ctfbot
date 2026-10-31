/**
 * Task Suggestion Service
 *
 * Watches governance channels and, when the conversation settles, asks an
 * OpenAI-compatible model whether the admins decided to do something in the
 * future. Mentioning the bot skips the wait: it analyses immediately, shows
 * "typing..." while the model works, and always answers the mention.
 * Each firm decision is posted as a suggestion card (reply to the
 * message where it was made) with Create / Edit & create / Dismiss buttons,
 * handled by src/listeners/taskSuggestInteraction.js. Nothing is created
 * until someone confirms.
 *
 * The bot also remembers people: each pass sees the notes and preferences
 * stored for the participants (actor_profiles / actor_memories) and may add
 * or drop notes when someone states a lasting fact or preference; the source
 * message gets a 🧠 reaction so people know. The system prompt makes the
 * model write in Indonesian unless a person's saved language says otherwise.
 *
 * Only messages from GOVERNANCE_CATEGORIES channels are buffered or sent to
 * the model. Message buffers live in memory; suggestions are stored in the
 * task_suggestions table, so a card stays actionable (across restarts, with
 * no time limit) until someone creates the task or dismisses it.
 *
 * @module services/taskSuggest
 */

const { randomUUID } = require('crypto');
const { DateTime } = require('luxon');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const constants = require('../lib/constants/config');
const { chatCompletion, parseJsonReply } = require('../lib/llm/openai');
const suggestionRepository = require('../database/repositories/taskSuggestion.repository');
const memoryRepository = require('../database/repositories/actorMemory.repository');
const { logger } = require('../lib/logger');

const suggestLog = logger.child('TaskSuggest');

// Wait for this much silence in a channel before analysing it.
const QUIET_MS = 60_000;
// Never analyse the same channel more often than this.
const MIN_INTERVAL_MS = 120_000;
const BUFFER_LIMIT = 40;
const BUFFER_MAX_AGE_MS = 3 * 60 * 60 * 1000;
// Earlier messages sent along as context for the new ones, read from the
// channel's Discord history so a restart does not lose the conversation.
const HISTORY_MESSAGES = 20;
const MAX_UPDATES_PER_PASS = 3;
const MAX_MESSAGE_CHARS = 1500;
const MAX_PROPOSALS_PER_PASS = 3;
const MIN_CONFIDENCE = 0.7;
const MAX_MEMORY_CHANGES_PER_PASS = 5;
const MAX_NOTE_CHARS = 200;
const MAX_LANGUAGE_CHARS = 30;
// The model answers a mention with a few short chat messages, sent one by one.
const MAX_CHAT_MESSAGES = 3;
const MAX_CHAT_CHARS = 1000;
const MEMORY_REACTION = '🧠';
// Discord shows "typing..." for about 10s per call, so refresh it before then.
const TYPING_REFRESH_MS = 8_000;
const TIMEZONE = constants.DEFAULT_TIMEZONE;

// Custom ID namespaces for the suggestion card. Format: <namespace>:<proposalId>
const SUGGEST_IDS = {
	create: 'tsug_create',
	edit: 'tsug_edit',
	dismiss: 'tsug_dismiss',
	modal: 'tsug_modal'
};

/** @type {Map<string, object>} channelId → buffer state */
const channels = new Map();

let warnedUnconfigured = false;

/**
 * Whether suggestions are switched on and the model endpoint is configured.
 *
 * @returns {boolean}
 */
function isEnabled() {
	if (!config.taskSuggestions.enabled) {
		return false;
	}
	if (!config.llm.isConfigured) {
		if (!warnedUnconfigured) {
			suggestLog.warn('TASK_SUGGESTIONS_ENABLED is true but OPENAI_API_KEY / OPENAI_MODEL are not set');
			warnedUnconfigured = true;
		}
		return false;
	}
	return true;
}

/**
 * Record a guild message and schedule an analysis once the channel is quiet.
 * Called for every non-bot message from the messageCreate listener.
 *
 * @param {import('discord.js').Message} message
 */
function observe(message) {
	if (message.author.bot || !message.guild || !isEnabled()) {
		return;
	}
	if (!constants.GOVERNANCE_CATEGORIES.includes(message.channel?.parentId)) {
		return;
	}
	const content = message.content?.trim();
	if (!content) {
		return;
	}

	let state = channels.get(message.channelId);
	if (!state) {
		state = {
			channel: message.channel,
			messages: [],
			people: new Map(),
			timer: null,
			lastRunAt: 0,
			running: false,
			pendingTrigger: null,
			// Stops the "typing..." shown while a mention waits for a running pass.
			queuedTyping: null
		};
		channels.set(message.channelId, state);
	}

	state.people.set(message.author.id, message.member?.displayName ?? message.author.username);
	for (const user of message.mentions?.users?.values() ?? []) {
		if (!user.bot) {
			state.people.set(user.id, message.mentions.members?.get(user.id)?.displayName ?? user.username);
		}
	}

	const botId = message.client?.user?.id;
	const botRoles = botId ? _botRoleIds(message, botId) : [];
	// Show a mention of the bot's role to the model as a mention of the bot.
	const text = botRoles.reduce((s, roleId) => s.replaceAll(`<@&${roleId}>`, `<@${botId}>`), content);

	state.messages.push({
		id: message.id,
		authorId: message.author.id,
		content: text.slice(0, MAX_MESSAGE_CHARS),
		createdAt: message.createdTimestamp,
		analyzed: false
	});
	_prune(state);

	// A direct mention is a request to look now, not after the discussion ends.
	if (botId && (message.mentions?.users?.has(botId) || botRoles.length > 0)) {
		clearTimeout(state.timer);
		_analyze(message.channelId, { trigger: message }).catch(err =>
			suggestLog.error(`Analysis failed for channel ${message.channelId}: ${err.message}`)
		);
		return;
	}
	_schedule(message.channelId, state);
}

/**
 * Ids of mentioned roles that belong to this bot. Discord creates a managed
 * role named after the bot, and picking it from the @ autocomplete sends a
 * role mention instead of a user mention. Other roles the bot happens to have
 * (e.g. @Admin) do not count.
 *
 * @returns {string[]}
 */
function _botRoleIds(message, botId) {
	return [...(message.mentions?.roles?.values() ?? [])].filter(r => r.tags?.botId === botId).map(r => r.id);
}

function _prune(state) {
	const cutoff = Date.now() - BUFFER_MAX_AGE_MS;
	state.messages = state.messages.filter(m => m.createdAt >= cutoff).slice(-BUFFER_LIMIT);
}

function _schedule(channelId, state) {
	clearTimeout(state.timer);
	const delay = Math.max(QUIET_MS, state.lastRunAt + MIN_INTERVAL_MS - Date.now());
	state.timer = setTimeout(() => {
		_analyze(channelId).catch(err => suggestLog.error(`Analysis failed for channel ${channelId}: ${err.message}`));
	}, delay);
	state.timer.unref?.();
}

/**
 * Keep the "typing..." indicator up in a channel until the returned stop
 * function is called. Posting a message also clears it on Discord's side.
 *
 * @returns {() => void}
 */
function _keepTyping(channel) {
	const send = () => Promise.resolve(channel.sendTyping?.()).catch(() => {});
	send();
	const interval = setInterval(send, TYPING_REFRESH_MS);
	interval.unref?.();
	return () => clearInterval(interval);
}

/**
 * Post the model's chat messages one by one: the first (a quick
 * acknowledgment) as a reply to the mention, the rest as plain messages so
 * they read like a conversation.
 */
async function _sendChat(channel, messages, trigger) {
	for (const [i, content] of messages.entries()) {
		if (i === 0) {
			await _replyTo(trigger, content);
		} else {
			await channel.send({ content, allowedMentions: { parse: [] } }).catch(() => {});
		}
	}
}

/**
 * The model's chat messages for a mention: "messages" (an array), or an
 * older-style single "reply" string.
 *
 * @returns {string[]}
 */
function _chatMessages(parsed) {
	const raw = Array.isArray(parsed?.messages) ? parsed.messages : [parsed?.reply];
	return raw
		.filter(m => typeof m === 'string')
		.map(m => m.trim().slice(0, MAX_CHAT_CHARS))
		.filter(Boolean)
		.slice(0, MAX_CHAT_MESSAGES);
}

function _replyTo(message, content) {
	return message.reply({ content, allowedMentions: { parse: [], repliedUser: false } }).catch(() => {});
}

/**
 * Send the unanalysed messages (plus some context) to the model and post a
 * suggestion card for each decision it finds.
 *
 * @param {string} channelId
 * @param {object} [options]
 * @param {import('discord.js').Message} [options.trigger] - Message that
 *   mentioned the bot. Shows "typing..." during the call and always replies,
 *   even when nothing is found or the model call fails.
 */
async function _analyze(channelId, { trigger = null } = {}) {
	const state = channels.get(channelId);
	if (!state) {
		return;
	}
	if (state.running) {
		// Run the mention right after the current pass instead of waiting for
		// the channel to go quiet again, showing "typing..." in the meantime.
		if (trigger) {
			state.pendingTrigger = trigger;
			state.queuedTyping ??= _keepTyping(state.channel);
		} else {
			_schedule(channelId, state);
		}
		return;
	}
	if (trigger) {
		// The mention's own pass takes over the indicator from here.
		state.queuedTyping?.();
		state.queuedTyping = null;
	}

	const fresh = state.messages.filter(m => !m.analyzed);
	if (fresh.length === 0) {
		if (trigger) {
			await _replyTo(trigger, 'hmm belum ada chat baru buat aku cek nih');
		}
		return;
	}
	state.running = true;
	state.lastRunAt = Date.now();
	for (const m of fresh) {
		m.analyzed = true;
	}
	const stopTyping = trigger ? _keepTyping(state.channel) : () => {};

	try {
		const context = await _loadContext(state, fresh);
		const open = await _dropDeletedCards(state.channel, suggestionRepository.listOpenSuggestions(channelId));
		const openTitles = new Set(open.map(r => r.title));
		const profiles = memoryRepository.getProfiles([...state.people.keys()]);

		let reply;
		try {
			reply = await chatCompletion({
				messages: _buildPrompt({
					context,
					fresh,
					people: state.people,
					open,
					profiles,
					proposedTitles: suggestionRepository.recentTitles(channelId).filter(t => !openTitles.has(t)),
					botId: trigger ? trigger.client.user.id : null
				}),
				json: true,
				// Spotting decisions in chat does not need deep reasoning; low effort
				// keeps replies fast and cheap.
				reasoningEffort: 'low'
			});
		} catch (error) {
			// Put the messages back so the next pass (triggered by the next
			// message in this channel) retries them instead of losing the
			// decision. No timer is set here, so a broken endpoint is not
			// polled in a loop.
			for (const m of fresh) {
				m.analyzed = false;
			}
			if (trigger) {
				stopTyping();
				await _replyTo(trigger, `❌ duh, otakku (model AI-nya) lagi nggak nyaut. ${error.message}`);
			}
			throw error;
		}
		const parsed = parseJsonReply(reply);
		const found = _normalizeProposals(parsed, {
			fresh,
			people: state.people,
			proposedSources: suggestionRepository.suggestedSourceIds(
				channelId,
				fresh.map(m => m.id)
			)
		});

		const updates = _normalizeUpdates(parsed, { fresh, people: state.people, open });

		// For a mention the model's chat messages come first and the cards
		// follow them in the channel, like "oke ini ya" and then the card.
		const chat = trigger ? _chatMessages(parsed) : [];
		await _sendChat(state.channel, chat, trigger);

		let updated = 0;
		for (const u of updates) {
			if (await _applyUpdate(state.channel, u)) {
				updated++;
			}
		}
		let posted = 0;
		for (const p of found) {
			if (await _postProposal(state.channel, p, { reply: !trigger })) {
				posted++;
			}
		}
		const learned = await _applyMemories(
			state.channel,
			_normalizeMemories(parsed, { fresh, people: state.people, profiles })
		);
		if (posted > 0 || updated > 0 || learned > 0) {
			suggestLog.info(
				`Posted ${posted}, updated ${updated} task suggestion(s) and saved ${learned} memory change(s) in channel ${channelId}`
			);
		}
		if (trigger && chat.length === 0) {
			if (posted === 0 && updated === 0 && learned === 0) {
				await _replyTo(
					trigger,
					'hmm aku nggak nemu keputusan baru atau perubahan buat saran yang masih kebuka nih'
				);
			}
		}
	} finally {
		stopTyping();
		state.running = false;
		if (state.pendingTrigger) {
			const next = state.pendingTrigger;
			state.pendingTrigger = null;
			_analyze(channelId, { trigger: next }).catch(err =>
				suggestLog.error(`Analysis failed for channel ${channelId}: ${err.message}`)
			);
		}
	}
}

/**
 * Text the model should see for a Discord message: its content, or for the
 * bot's own suggestion cards, the card title and details.
 */
function _describeMessage(message) {
	const content = message.content?.trim();
	if (content) {
		return content.slice(0, MAX_MESSAGE_CHARS);
	}
	const embed = message.embeds?.[0];
	if (message.author?.bot && embed?.title) {
		return `[${embed.title}] ${embed.description ?? ''}`.trim().slice(0, MAX_MESSAGE_CHARS);
	}
	return '';
}

/**
 * Earlier messages for context: the channel's recent Discord history before
 * the first new message, merged with what is buffered. Reading history means
 * a correction like "make it Friday instead" still has the original message
 * in view after a restart.
 *
 * @returns {Promise<Array<object>>} oldest first
 */
async function _loadContext(state, fresh) {
	const freshIds = new Set(fresh.map(m => m.id));
	const byId = new Map(state.messages.filter(m => !freshIds.has(m.id)).map(m => [m.id, m]));

	try {
		const history = await state.channel.messages.fetch({ limit: HISTORY_MESSAGES, before: fresh[0].id });
		for (const m of history.values()) {
			if (byId.has(m.id) || freshIds.has(m.id)) {
				continue;
			}
			const content = _describeMessage(m);
			if (!content) {
				continue;
			}
			if (!m.author.bot) {
				state.people.set(m.author.id, m.member?.displayName ?? m.author.username);
			}
			byId.set(m.id, {
				id: m.id,
				authorId: m.author.id,
				authorName: m.author.bot ? `${m.author.username} (bot)` : undefined,
				content,
				createdAt: m.createdTimestamp
			});
		}
	} catch (error) {
		suggestLog.warn(`Could not read history for channel ${state.channel.id}: ${error.message}`);
	}

	return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-HISTORY_MESSAGES);
}

/**
 * Build the chat messages for one analysis pass.
 *
 * @returns {Array<{role: string, content: string}>}
 */
function _buildPrompt({
	context,
	fresh,
	people,
	proposedTitles,
	open = [],
	profiles = new Map(),
	botId = null,
	now = DateTime.now()
}) {
	const local = now.setZone(TIMEZONE);
	const localTime = unix => DateTime.fromSeconds(unix).setZone(TIMEZONE).toFormat('yyyy-MM-dd HH:mm cccc');
	const fmt = m => {
		const at = DateTime.fromMillis(m.createdAt).setZone(TIMEZONE).toFormat('yyyy-MM-dd HH:mm');
		const name = m.authorName ?? people.get(m.authorId) ?? 'unknown';
		return `id=${m.id} ${at} ${name} (${m.authorId}): ${m.content}`;
	};

	const system = [
		"You watch a Discord channel where an organisation's administrators coordinate.",
		'Find decisions, made or confirmed in the NEW messages, to do something in the future that deserves a tracked task with a reminder.',
		'Only include firm commitments or agreed plans. Skip open questions, ideas still being debated, things already done, jokes, and actions that will be finished within the next hour.',
		'Earlier messages are context: use them to understand what the NEW messages refer to, but only act on what the NEW messages say. Do not repeat anything listed as already suggested.',
		'When a NEW message changes or corrects an OPEN suggestion (a different day, person, title or detail), put it in "updates" with that suggestion_id instead of adding a new proposal. Only include the fields that change.',
		'Messages may be in Indonesian, English or a mix. Write every title, description, note and reply in Indonesian (Bahasa Indonesia) by default, even when the messages are in English. Use another language only for a person whose memory sets one: the assignee for a task, the person who mentioned you for the reply.',
		'Gaya bicara: kamu itu temen sekelas yang lagi chat di grup Discord, bukan orang kantor dan bukan customer service. Ketik kayak orang nge-chat: pendek-pendek, huruf kecil boleh, bahasa gaul sehari-hari ("bro", "gas", "aman", "sip", "oke", "wkwk", "udah", "nggak", "aja", "nih", "dong", "sih"), sesekali emoji. Nggak usah basa-basi formal kayak "Baik, saya telah mencatat permintaan Anda" atau "Terima kasih atas informasinya". Jangan kasar.',
		'Humor setting: 30%, kayak TARS di Interstellar. Kadang selipin satu celetukan kering yang deadpan, tapi kebanyakan langsung to the point dan jawabannya tetap jelas. Jangan maksa lucu di tiap pesan, dan jangan bercanda soal hal yang serius.',
		'Judul tugas tetap singkat dan jelas, misalnya "Kirim proposal sponsor". Kalau seseorang minta bahasa lain, tetap santai kayak temen di bahasa itu.',
		'You remember participants between conversations. Use what you remember to pick assignees and deadlines the way each person prefers.',
		'In "memories", save lasting facts or preferences a NEW message states about its author or a teammate that will help with later tasks: role or responsibilities, usual availability, preferred reminder time, how they want to be addressed. Do not save one-off task details, anything already remembered, secrets or credentials, or sensitive personal data. When a NEW message says a remembered note is no longer true, "forget" it by note id (and "remember" the corrected one). Set "language" only when a person asks you to use a language with them.',
		'Reply with a JSON object only:',
		'{"proposals":[{"title":"short imperative, max 80 chars","description":"one or two sentences of context, or empty","assignee_id":"Discord user id from the participants list, or null if unclear","deadline":"YYYY-MM-DD HH:mm in the given local time, or null if no time frame was mentioned","source_message_id":"id of the NEW message where it was decided","confidence":0.0}],"updates":[{"suggestion_id":"id of the OPEN suggestion","title":"new title, or omit","description":"new description, or omit","assignee_id":"new assignee id, or omit","deadline":"new YYYY-MM-DD HH:mm, or omit","source_message_id":"id of the NEW message asking for the change"}],"memories":[{"user_id":"Discord user id the note is about","remember":"short note in the third person, max 200 chars, or omit","forget":"id of a remembered note that is no longer true, or omit","language":"language the person asked you to use with them, or omit","source_message_id":"id of the NEW message it came from"}]}',
		'Resolve relative dates ("besok", "next Friday", "end of the month") against the current local time. When only a day is given, use the time the assignee prefers if you remember one, otherwise 23:59 that day. "Jam 12 malam" on a day means the end of that day, so use 23:59 that day.',
		'Return {"proposals":[],"updates":[],"memories":[]} when there is nothing to do.'
	];
	if (botId) {
		system.push(
			`You were mentioned directly as <@${botId}>: someone is asking you to look for tasks now. Treat an explicit request such as "remind us to X by Y" as a decision, and use the mentioning message as source_message_id when the request is made there. Also add "messages" to the JSON object: one to three short chat messages to the person who mentioned you, each sent as its own Discord message, like texting a friend. The first message is sent as a reply to them and must be a quick acknowledgment of a few words that fits what they said: "wait" or "oke bentar" for a request, a short reaction like "ohh itu" or "hmm" for a question. Put the actual answer in the next message(s). Any suggestion card is posted right after your messages, so a card needs only something short like "oke ini ya". Say what you suggested, changed or remembered, or why there was nothing to do, and answer questions about what you remember from the memory list. Example: "brooooo @bot minta tolong buatin task ABC deadlinenya besok jam 12 malam" → {"proposals":[{"title":"ABC",...}],"messages":["wait","oke ini ya"]}. "<@bot> deadline inaff kapan sih?" → {"proposals":[],"messages":["hmm bentar","jumat jam 23:59, masih aman kok"]}.`
		);
	}
	const systemText = system.join('\n');

	const participants = [...people].map(([id, name]) => `- ${name} (${id})`).join('\n');
	const memoryLines = [...people].map(([id, name]) => {
		const profile = profiles.get(id);
		const language = profile?.language ? `language=${profile.language}` : 'language=default (Indonesian)';
		const notes = profile?.notes?.length ? profile.notes.map(n => `[${n.id}] ${n.note}`).join('; ') : 'none';
		return `- ${name} (${id}): ${language}; notes: ${notes}`;
	});
	const openLines = open.map(
		r =>
			`- suggestion_id=${r.id} title="${r.title}" assignee=${people.get(r.assignee_id) ?? 'unknown'} (${r.assignee_id}) deadline=${r.deadline ? localTime(r.deadline) : 'none'} from message id=${r.source_message_id}${r.description ? ` details="${r.description}"` : ''}`
	);
	const user = [
		`Current local time: ${local.toFormat('yyyy-MM-dd HH:mm cccc')} (${TIMEZONE})`,
		'',
		'Participants:',
		participants,
		'',
		'What you remember about participants:',
		memoryLines.join('\n'),
		'',
		'OPEN suggestions (posted, not yet accepted; update these rather than suggesting them again):',
		openLines.length ? openLines.join('\n') : '(none)',
		'',
		`Already suggested and handled: ${proposedTitles.length ? proposedTitles.map(t => `"${t}"`).join(', ') : 'none'}`,
		'',
		'Earlier messages (context):',
		context.length ? context.map(fmt).join('\n') : '(none)',
		'',
		'NEW messages:',
		fresh.map(fmt).join('\n')
	].join('\n');

	return [
		{ role: 'system', content: systemText },
		{ role: 'user', content: user }
	];
}

/**
 * Validate the model's proposals against what was actually said. Anything
 * pointing at an unknown message, or below the confidence bar, is dropped;
 * unknown assignees fall back to the author of the source message.
 *
 * @returns {Array<object>}
 */
function _normalizeProposals(parsed, { fresh, people, proposedSources, now = Date.now() }) {
	const raw = Array.isArray(parsed?.proposals) ? parsed.proposals : [];
	const freshById = new Map(fresh.map(m => [String(m.id), m]));
	const seen = new Set();
	const out = [];

	for (const item of raw) {
		if (!item || typeof item !== 'object') {
			continue;
		}
		const title = typeof item.title === 'string' ? item.title.replace(/\s+/g, ' ').trim().slice(0, 100) : '';
		const source = freshById.get(String(item.source_message_id));
		if (!title || !source || proposedSources.has(source.id) || seen.has(source.id)) {
			continue;
		}
		if (typeof item.confidence === 'number' && item.confidence < MIN_CONFIDENCE) {
			continue;
		}

		const assigneeId =
			item.assignee_id && people.has(String(item.assignee_id)) ? String(item.assignee_id) : source.authorId;

		let deadline = null;
		if (typeof item.deadline === 'string') {
			const dt = DateTime.fromFormat(item.deadline.trim(), 'yyyy-MM-dd HH:mm', { zone: TIMEZONE });
			if (dt.isValid && dt.toMillis() > now + 5 * 60_000) {
				deadline = dt.toUnixInteger();
			}
		}

		const description =
			typeof item.description === 'string' && item.description.trim()
				? item.description.trim().slice(0, 1000)
				: null;

		seen.add(source.id);
		out.push({ title, description, assigneeId, deadline, sourceMessageId: source.id });
		if (out.length >= MAX_PROPOSALS_PER_PASS) {
			break;
		}
	}
	return out;
}

/**
 * Validate the model's updates to open suggestions. Unknown suggestions,
 * invalid values and no-op changes are dropped.
 *
 * @returns {Array<{ id: string, changes: object, sourceMessageId: string }>}
 */
function _normalizeUpdates(parsed, { fresh, people, open, now = Date.now() }) {
	const raw = Array.isArray(parsed?.updates) ? parsed.updates : [];
	const openById = new Map(open.map(r => [String(r.id), r]));
	const freshById = new Map(fresh.map(m => [String(m.id), m]));
	const seen = new Set();
	const out = [];

	for (const item of raw) {
		const row = item && typeof item === 'object' ? openById.get(String(item.suggestion_id)) : null;
		if (!row || seen.has(row.id)) {
			continue;
		}

		const changes = {};
		if (typeof item.title === 'string') {
			const title = item.title.replace(/\s+/g, ' ').trim().slice(0, 100);
			if (title && title !== row.title) {
				changes.title = title;
			}
		}
		if (typeof item.description === 'string') {
			const description = item.description.trim().slice(0, 1000) || null;
			if (description !== row.description) {
				changes.description = description;
			}
		}
		if (item.assignee_id && people.has(String(item.assignee_id)) && String(item.assignee_id) !== row.assignee_id) {
			changes.assigneeId = String(item.assignee_id);
		}
		if (typeof item.deadline === 'string') {
			const dt = DateTime.fromFormat(item.deadline.trim(), 'yyyy-MM-dd HH:mm', { zone: TIMEZONE });
			if (dt.isValid && dt.toMillis() > now + 5 * 60_000 && dt.toUnixInteger() !== row.deadline) {
				changes.deadline = dt.toUnixInteger();
			}
		}
		if (Object.keys(changes).length === 0) {
			continue;
		}

		const source = freshById.get(String(item.source_message_id)) ?? fresh[fresh.length - 1];
		seen.add(row.id);
		out.push({ id: row.id, changes, sourceMessageId: source.id });
		if (out.length >= MAX_UPDATES_PER_PASS) {
			break;
		}
	}
	return out;
}

/**
 * Validate the model's memory changes. A note must be about a known
 * participant and come from a NEW message; only the person themselves can
 * change their language; "forget" must name one of that person's notes.
 *
 * @returns {Array<{ userId: string, authorId: string, sourceMessageId: string, remember?: string, forget?: { id: number, note: string }, language?: string }>}
 */
function _normalizeMemories(parsed, { fresh, people, profiles }) {
	const raw = Array.isArray(parsed?.memories) ? parsed.memories : [];
	const freshById = new Map(fresh.map(m => [String(m.id), m]));
	const out = [];

	for (const item of raw) {
		if (!item || typeof item !== 'object') {
			continue;
		}
		const userId = String(item.user_id);
		const source = freshById.get(String(item.source_message_id));
		if (!people.has(userId) || !source) {
			continue;
		}
		const profile = profiles.get(userId) ?? { language: null, notes: [] };
		const change = { userId, authorId: source.authorId, sourceMessageId: source.id };

		if (item.forget !== undefined && item.forget !== null) {
			const noteId = Number(String(item.forget).replace(/^#/, ''));
			const note = profile.notes.find(n => n.id === noteId);
			if (note) {
				change.forget = note;
			}
		}
		if (typeof item.remember === 'string') {
			const note = item.remember.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_CHARS);
			const known = profile.notes.some(n => n !== change.forget && n.note.toLowerCase() === note.toLowerCase());
			if (note && !known) {
				change.remember = note;
			}
		}
		if (typeof item.language === 'string' && source.authorId === userId) {
			const language = item.language.replace(/\s+/g, ' ').trim().slice(0, MAX_LANGUAGE_CHARS);
			if (language && language.toLowerCase() !== (profile.language ?? '').toLowerCase()) {
				change.language = language;
			}
		}
		if (!change.remember && !change.forget && !change.language) {
			continue;
		}
		out.push(change);
		if (out.length >= MAX_MEMORY_CHANGES_PER_PASS) {
			break;
		}
	}
	return out;
}

/**
 * Store memory changes and react on each source message so people can see
 * the bot remembered something (and check it with /memory view).
 *
 * @returns {Promise<number>} number of changes saved
 */
async function _applyMemories(channel, changes) {
	const sources = new Set();
	for (const c of changes) {
		if (c.forget) {
			memoryRepository.removeNote(c.userId, c.forget.id);
		}
		if (c.remember) {
			memoryRepository.addNote(c.userId, c.remember, { addedBy: c.authorId, sourceMessageId: c.sourceMessageId });
		}
		if (c.language) {
			memoryRepository.setLanguage(c.userId, c.language);
		}
		sources.add(c.sourceMessageId);
	}
	for (const id of sources) {
		const message = await channel.messages.fetch(id).catch(() => null);
		await message?.react(MEMORY_REACTION).catch(() => {});
	}
	return changes.length;
}

/**
 * Save an update to an open suggestion, edit its card in place, and reply to
 * the message that asked for the change with what changed. Returns false when
 * the suggestion was handled in the meantime.
 *
 * @returns {Promise<boolean>}
 */
async function _applyUpdate(channel, { id, changes, sourceMessageId }) {
	const row = suggestionRepository.updateSuggestion(id, changes);
	if (!row) {
		return false;
	}
	const proposal = _toProposal(row);

	if (row.card_message_id) {
		const card = await channel.messages.fetch(row.card_message_id).catch(() => null);
		await card
			?.edit({ embeds: [buildProposalEmbed(proposal)], components: [buildProposalButtons(proposal)] })
			.catch(error => suggestLog.warn(`Could not edit suggestion card ${row.card_message_id}: ${error.message}`));
	}

	const lines = [];
	if (changes.title) {
		lines.push(`title → **${changes.title}**`);
	}
	if (changes.assigneeId) {
		lines.push(`assignee → <@${changes.assigneeId}>`);
	}
	if (changes.deadline) {
		lines.push(`deadline → <t:${changes.deadline}:F> (<t:${changes.deadline}:R>)`);
	}
	if ('description' in changes) {
		lines.push('details updated');
	}
	const link = row.card_message_id
		? `https://discord.com/channels/${channel.guildId}/${channel.id}/${row.card_message_id}`
		: null;
	const content = `✏️ Updated the suggestion **${row.title}**${link ? ` (${link})` : ''}:\n${lines.map(l => `- ${l}`).join('\n')}`;

	const payload = { content, allowedMentions: { parse: [], repliedUser: false } };
	const source = await channel.messages.fetch(sourceMessageId).catch(() => null);
	await (source ? source.reply(payload) : channel.send(payload));
	return true;
}

/**
 * Store a suggestion and post its card, as a reply to the message where it
 * was decided unless `reply` is false (after a mention, the card follows the
 * bot's own chat messages instead). Returns false when the decision was
 * already suggested (e.g. before a restart) and nothing was posted.
 *
 * @returns {Promise<boolean>}
 */
async function _postProposal(channel, found, { reply = true } = {}) {
	const proposal = { ...found, id: randomUUID() };
	const inserted = suggestionRepository.createSuggestion({
		id: proposal.id,
		channelId: channel.id,
		sourceMessageId: proposal.sourceMessageId,
		title: proposal.title,
		description: proposal.description,
		assigneeId: proposal.assigneeId,
		deadline: proposal.deadline
	});
	if (!inserted) {
		return false;
	}

	const payload = {
		embeds: [buildProposalEmbed(proposal)],
		components: [buildProposalButtons(proposal)],
		allowedMentions: { parse: [], repliedUser: false }
	};
	try {
		const source = reply ? await channel.messages.fetch(proposal.sourceMessageId).catch(() => null) : null;
		const card = await (source ? source.reply(payload) : channel.send(payload));
		suggestionRepository.setCardMessage(proposal.id, card.id);
	} catch (error) {
		// No card exists, so drop the row and let a later pass suggest it again.
		suggestionRepository.deleteSuggestion(proposal.id);
		throw error;
	}
	return true;
}

/**
 * @param {object} proposal
 * @returns {EmbedBuilder}
 */
function buildProposalEmbed(proposal) {
	const embed = new EmbedBuilder()
		.setColor(0xf1c40f)
		.setTitle('💡 Set a task reminder?')
		.setDescription(`**${proposal.title}**${proposal.description ? `\n${proposal.description}` : ''}`)
		.addFields(
			{ name: 'Assign To', value: `<@${proposal.assigneeId}>`, inline: true },
			{
				name: 'Deadline',
				value: proposal.deadline
					? `<t:${proposal.deadline}:F> (<t:${proposal.deadline}:R>)`
					: 'Not stated, use **Edit & create**',
				inline: true
			}
		)
		.setFooter({ text: 'Suggested from this conversation. Nothing is created until someone confirms.' });
	return embed;
}

/**
 * @param {object} proposal
 * @returns {ActionRowBuilder}
 */
function buildProposalButtons(proposal) {
	return new ActionRowBuilder().addComponents(
		new ButtonBuilder()
			.setCustomId(`${SUGGEST_IDS.create}:${proposal.id}`)
			.setLabel('Create task')
			.setStyle(ButtonStyle.Success)
			.setDisabled(!proposal.deadline),
		new ButtonBuilder()
			.setCustomId(`${SUGGEST_IDS.edit}:${proposal.id}`)
			.setLabel('Edit & create')
			.setStyle(ButtonStyle.Primary),
		new ButtonBuilder()
			.setCustomId(`${SUGGEST_IDS.dismiss}:${proposal.id}`)
			.setLabel('Dismiss')
			.setStyle(ButtonStyle.Secondary)
	);
}

function _toProposal(row) {
	return {
		id: row.id,
		channelId: row.channel_id,
		sourceMessageId: row.source_message_id,
		title: row.title,
		description: row.description,
		assigneeId: row.assignee_id,
		deadline: row.deadline,
		status: row.status
	};
}

/**
 * Return a suggestion that can still be acted on, or null.
 */
function getProposal(id) {
	const row = suggestionRepository.getSuggestion(id);
	if (!row) {
		return null;
	}
	const leaseExpired = row.status === 'working' && row.claimed_until < Math.floor(Date.now() / 1000);
	return row.status === 'open' || leaseExpired ? _toProposal(row) : null;
}

/**
 * Atomically take a suggestion so two clicks cannot both act on it.
 * Returns the proposal, or null when it is gone, handled, or being handled.
 */
function claimProposal(id) {
	const row = suggestionRepository.claimSuggestion(id);
	return row ? _toProposal(row) : null;
}

/** Put a claimed suggestion back so it can be retried. */
function releaseProposal(id) {
	suggestionRepository.releaseSuggestion(id);
}

/**
 * Close a suggestion once it was turned into a task or dismissed.
 *
 * @param {string} id
 * @param {{ status: 'created'|'dismissed', handledBy: string, taskId?: string }} outcome
 */
function finishProposal(id, outcome) {
	suggestionRepository.finishSuggestion(id, outcome);
}

/**
 * Explain to the clicker why a suggestion cannot be acted on right now.
 *
 * @returns {string}
 */
function unavailableMessage(id) {
	const row = suggestionRepository.getSuggestion(id);
	if (!row) {
		return '❌ This suggestion could not be found (it was posted before suggestions were saved). Use /task add instead.';
	}
	if (row.status === 'created') {
		return `✅ <@${row.handled_by}> already created this task${row.task_id ? ` (\`${row.task_id}\`)` : ''}.`;
	}
	if (row.status === 'dismissed') {
		return `This suggestion was dismissed by <@${row.handled_by}>.`;
	}
	return '⏳ Someone else is handling this suggestion right now. Try again in a moment.';
}

/**
 * Forget a message that was deleted from Discord, so the model never sees
 * it again: drop it from the buffer, drop the suggestion if it was a card,
 * and drop notes learned from it. Called from the messageDelete listener.
 *
 * @param {string} channelId
 * @param {string} messageId
 */
function forgetMessage(channelId, messageId) {
	const state = channels.get(channelId);
	if (state) {
		state.messages = state.messages.filter(m => m.id !== messageId);
	}
	const card = suggestionRepository.deleteByCardMessage(channelId, messageId);
	const notes = memoryRepository.removeNotesFromMessage(messageId);
	if (card || notes > 0) {
		suggestLog.info(
			`Message ${messageId} was deleted: removed ${card ? 'its suggestion card' : 'no card'} and ${notes} note(s)`
		);
	}
}

// Discord's error code for a message that no longer exists.
const UNKNOWN_MESSAGE = 10008;

/**
 * Drop open suggestions whose card was deleted while the bot was not
 * watching (e.g. offline). Cards are usually in the message cache, so this
 * rarely costs an API call. Errors other than "unknown message" keep the
 * suggestion.
 *
 * @returns {Promise<Array<object>>} the suggestions whose card still exists
 */
async function _dropDeletedCards(channel, open) {
	const kept = [];
	for (const row of open) {
		if (row.card_message_id) {
			const gone = await channel.messages.fetch(row.card_message_id).then(
				() => false,
				error => error?.code === UNKNOWN_MESSAGE
			);
			if (gone) {
				suggestionRepository.deleteByCardMessage(channel.id, row.card_message_id);
				continue;
			}
		}
		kept.push(row);
	}
	return kept;
}

/** Test helper: clear all in-memory state. */
function _reset() {
	for (const state of channels.values()) {
		clearTimeout(state.timer);
		state.queuedTyping?.();
	}
	channels.clear();
	warnedUnconfigured = false;
}

module.exports = {
	SUGGEST_IDS,
	TIMEZONE,
	isEnabled,
	observe,
	forgetMessage,
	getProposal,
	claimProposal,
	releaseProposal,
	finishProposal,
	unavailableMessage,
	buildProposalEmbed,
	buildProposalButtons,
	_analyze,
	_keepTyping,
	_buildPrompt,
	_normalizeProposals,
	_normalizeUpdates,
	_normalizeMemories,
	_applyMemories,
	_applyUpdate,
	_loadContext,
	_postProposal,
	_reset
};
