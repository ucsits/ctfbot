/**
 * Task Suggestion Service
 *
 * Watches governance channels and, when the conversation settles, asks an
 * OpenAI-compatible model whether the admins decided to do something in the
 * future. Each firm decision is posted as a suggestion card (reply to the
 * message where it was made) with Create / Edit & create / Dismiss buttons,
 * handled by src/listeners/taskSuggestInteraction.js. Nothing is created
 * until someone confirms.
 *
 * Only messages from GOVERNANCE_CATEGORIES channels are buffered or sent to
 * the model. Buffers and open suggestions live in memory, so suggestion
 * buttons expire on restart.
 *
 * @module services/taskSuggest
 */

const { randomUUID } = require('crypto');
const { DateTime } = require('luxon');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const constants = require('../lib/constants/config');
const { chatCompletion, parseJsonReply } = require('../lib/llm/openai');
const { logger } = require('../lib/logger');

const suggestLog = logger.child('TaskSuggest');

// Wait for this much silence in a channel before analysing it.
const QUIET_MS = 60_000;
// Never analyse the same channel more often than this.
const MIN_INTERVAL_MS = 120_000;
const BUFFER_LIMIT = 40;
const BUFFER_MAX_AGE_MS = 3 * 60 * 60 * 1000;
// Already-analysed messages sent along as context for the new ones.
const CONTEXT_MESSAGES = 10;
const MAX_MESSAGE_CHARS = 1500;
const MAX_PROPOSALS_PER_PASS = 3;
const MIN_CONFIDENCE = 0.7;
const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;
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
/** @type {Map<string, object>} proposalId → proposal */
const proposals = new Map();

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
			proposedSources: new Set(),
			proposedTitles: [],
			timer: null,
			lastRunAt: 0,
			running: false
		};
		channels.set(message.channelId, state);
	}

	state.people.set(message.author.id, message.member?.displayName ?? message.author.username);
	for (const user of message.mentions?.users?.values() ?? []) {
		if (!user.bot) {
			state.people.set(user.id, message.mentions.members?.get(user.id)?.displayName ?? user.username);
		}
	}

	state.messages.push({
		id: message.id,
		authorId: message.author.id,
		content: content.slice(0, MAX_MESSAGE_CHARS),
		createdAt: message.createdTimestamp,
		analyzed: false
	});
	_prune(state);
	_schedule(message.channelId, state);
}

function _prune(state) {
	const cutoff = Date.now() - BUFFER_MAX_AGE_MS;
	state.messages = state.messages.filter(m => m.createdAt >= cutoff).slice(-BUFFER_LIMIT);

	const expiry = Date.now() - PROPOSAL_TTL_MS;
	for (const [id, p] of proposals) {
		if (p.createdAt < expiry) {
			proposals.delete(id);
		}
	}
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
 * Send the unanalysed messages (plus some context) to the model and post a
 * suggestion card for each decision it finds.
 */
async function _analyze(channelId) {
	const state = channels.get(channelId);
	if (!state) {
		return;
	}
	if (state.running) {
		_schedule(channelId, state);
		return;
	}

	const fresh = state.messages.filter(m => !m.analyzed);
	if (fresh.length === 0) {
		return;
	}
	const context = state.messages.filter(m => m.analyzed).slice(-CONTEXT_MESSAGES);

	state.running = true;
	state.lastRunAt = Date.now();
	for (const m of fresh) {
		m.analyzed = true;
	}

	try {
		let reply;
		try {
			reply = await chatCompletion({
				messages: _buildPrompt({ context, fresh, people: state.people, proposedTitles: state.proposedTitles }),
				json: true
			});
		} catch (error) {
			// Put the messages back so the next pass (triggered by the next
			// message in this channel) retries them instead of losing the
			// decision. No timer is set here, so a broken endpoint is not
			// polled in a loop.
			for (const m of fresh) {
				m.analyzed = false;
			}
			throw error;
		}
		const found = _normalizeProposals(parseJsonReply(reply), {
			fresh,
			people: state.people,
			proposedSources: state.proposedSources
		});

		for (const p of found) {
			state.proposedSources.add(p.sourceMessageId);
			state.proposedTitles.push(p.title);
			await _postProposal(state.channel, p);
		}
		state.proposedTitles = state.proposedTitles.slice(-20);
		if (found.length > 0) {
			suggestLog.info(`Posted ${found.length} task suggestion(s) in channel ${channelId}`);
		}
	} finally {
		state.running = false;
	}
}

/**
 * Build the chat messages for one analysis pass.
 *
 * @returns {Array<{role: string, content: string}>}
 */
function _buildPrompt({ context, fresh, people, proposedTitles, now = DateTime.now() }) {
	const local = now.setZone(TIMEZONE);
	const fmt = m => {
		const at = DateTime.fromMillis(m.createdAt).setZone(TIMEZONE).toFormat('yyyy-MM-dd HH:mm');
		return `id=${m.id} ${at} ${people.get(m.authorId) ?? 'unknown'} (${m.authorId}): ${m.content}`;
	};

	const system = [
		"You watch a Discord channel where an organisation's administrators coordinate.",
		'Find decisions, made or confirmed in the NEW messages, to do something in the future that deserves a tracked task with a reminder.',
		'Only include firm commitments or agreed plans. Skip open questions, ideas still being debated, things already done, jokes, and actions that will be finished within the next hour.',
		'Earlier messages are context only. Do not repeat anything listed as already suggested.',
		'Messages may be in Indonesian, English or a mix; write the title and description in the language the decision was made in.',
		'Reply with a JSON object only:',
		'{"proposals":[{"title":"short imperative, max 80 chars","description":"one or two sentences of context, or empty","assignee_id":"Discord user id from the participants list, or null if unclear","deadline":"YYYY-MM-DD HH:mm in the given local time, or null if no time frame was mentioned","source_message_id":"id of the NEW message where it was decided","confidence":0.0}]}',
		'Resolve relative dates ("besok", "next Friday", "end of the month") against the current local time. When only a day is given, use 23:59 that day.',
		'Return {"proposals":[]} when there is nothing to suggest.'
	].join('\n');

	const participants = [...people].map(([id, name]) => `- ${name} (${id})`).join('\n');
	const user = [
		`Current local time: ${local.toFormat('yyyy-MM-dd HH:mm cccc')} (${TIMEZONE})`,
		'',
		'Participants:',
		participants,
		'',
		`Already suggested: ${proposedTitles.length ? proposedTitles.map(t => `"${t}"`).join(', ') : 'none'}`,
		'',
		'Earlier messages (context):',
		context.length ? context.map(fmt).join('\n') : '(none)',
		'',
		'NEW messages:',
		fresh.map(fmt).join('\n')
	].join('\n');

	return [
		{ role: 'system', content: system },
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

async function _postProposal(channel, found) {
	const proposal = {
		...found,
		id: randomUUID(),
		channelId: channel.id,
		createdAt: Date.now(),
		status: 'open'
	};
	proposals.set(proposal.id, proposal);

	const payload = {
		embeds: [buildProposalEmbed(proposal)],
		components: [buildProposalButtons(proposal)],
		allowedMentions: { parse: [], repliedUser: false }
	};
	const source = await channel.messages.fetch(proposal.sourceMessageId).catch(() => null);
	await (source ? source.reply(payload) : channel.send(payload));
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

/**
 * Return an open, unexpired proposal, or null.
 */
function getProposal(id) {
	const p = proposals.get(id);
	if (!p || p.status !== 'open' || p.createdAt < Date.now() - PROPOSAL_TTL_MS) {
		return null;
	}
	return p;
}

/**
 * Atomically take an open proposal so two clicks cannot both act on it.
 * Returns the proposal, or null when it is gone or already being handled.
 */
function claimProposal(id) {
	const p = getProposal(id);
	if (!p) {
		return null;
	}
	p.status = 'working';
	return p;
}

/** Put a claimed proposal back so it can be retried. */
function releaseProposal(id) {
	const p = proposals.get(id);
	if (p && p.status === 'working') {
		p.status = 'open';
	}
}

/** Forget a proposal once it was turned into a task or dismissed. */
function finishProposal(id) {
	proposals.delete(id);
}

/** Test helper: clear all in-memory state. */
function _reset() {
	for (const state of channels.values()) {
		clearTimeout(state.timer);
	}
	channels.clear();
	proposals.clear();
	warnedUnconfigured = false;
}

module.exports = {
	SUGGEST_IDS,
	TIMEZONE,
	isEnabled,
	observe,
	getProposal,
	claimProposal,
	releaseProposal,
	finishProposal,
	buildProposalEmbed,
	buildProposalButtons,
	_analyze,
	_buildPrompt,
	_normalizeProposals,
	_postProposal,
	_reset,
	_proposals: proposals
};
