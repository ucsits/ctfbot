/**
 * Reminder Service
 * Background poller that checks for unsent task reminders and sends
 * them to the configured Discord channel.
 *
 * Also handles the weekly task digest (every Monday ≥5AM Asia/Jakarta),
 * the daily task digest (every day ≥4AM Asia/Jakarta) and the overdue task
 * digest (every day ≥10AM Asia/Jakarta, repeating until the task is done or
 * cancelled).
 *
 * @module services/reminder
 */

const { container } = require('@sapphire/framework');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { DateTime } = require('luxon');
const constants = require('../lib/constants/config');
const taskRepository = require('../database/repositories/task.repository');
const { computePeriodRange } = require('../lib/utils/date');

// Custom id namespaces for the buttons on a reminder message. The format is
// <namespace>:<taskId>. Handled by src/listeners/interactionCreate.js.
const REMINDER_IDS = {
	done: 'remind_done'
};

// Custom id namespace for the per-task buttons on an overdue digest. The format
// is <namespace>:<taskId>. Handled by src/listeners/interactionCreate.js.
const OVERDUE_IDS = {
	done: 'overdue_done'
};

// Discord allows at most 5 action rows of 5 buttons per message, so a digest
// message can carry at most 25 "Mark done" buttons.
const MAX_BUTTONS_PER_MESSAGE = 25;

let intervalHandle = null;
let clientRef = null;

/** @type {number|null} Last ISO week number for which the digest was sent */
let lastDigestWeek = null;

/** @type {string|null} Last date (YYYY-MM-DD Asia/Jakarta) for which the daily digest was sent */
let lastDigestDate = null;
let pollInProgress = false;
let weeklyDigestSentThisCycle = false;

/**
 * Start the reminder polling service.
 * Polls every 30 seconds for due reminders, weekly digest, and daily digest.
 *
 * @param {import('discord.js').Client} client - Discord client instance
 */
function startReminderService(client) {
	clientRef = client;
	const interval = 30_000; // 30 seconds

	container.logger.info('Starting reminder service (polling every 30s)');

	if (intervalHandle) {
		return;
	}
	intervalHandle = setInterval(() => {
		poll().catch(error => container.logger.error('Reminder poll failed', error));
	}, interval);

	// Also run once immediately
	poll().catch(error => container.logger.error('Initial reminder poll failed', error));
}

/**
 * Stop the reminder polling service.
 */
function stopReminderService() {
	if (intervalHandle) {
		clearInterval(intervalHandle);
		intervalHandle = null;
	}
}

/**
 * Single poll cycle. Check due per-task reminders, the weekly digest and the
 * daily digest.
 */
async function poll() {
	if (pollInProgress) {
		return;
	}
	pollInProgress = true;
	try {
		weeklyDigestSentThisCycle = await pollWeeklyDigest();
		await pollDailyDigest();
		await pollOverdueDigest();
		await pollReminders();
	} finally {
		pollInProgress = false;
	}
}

/**
 * Build the "Mark done" buttons for one overdue digest message. There is one
 * button per task so the assignee can complete a task straight from the
 * digest. Discord allows at most 5 rows of 5 buttons, so the list is capped.
 *
 * @param {Array<object>} tasks - Task rows carrying task_id and title
 * @returns {ActionRowBuilder[]}
 */
function buildOverdueButtons(tasks) {
	const rows = [];
	const limited = tasks.slice(0, MAX_BUTTONS_PER_MESSAGE);
	for (let i = 0; i < limited.length; i += 5) {
		rows.push(
			new ActionRowBuilder().addComponents(
				limited
					.slice(i, i + 5)
					.map(t =>
						new ButtonBuilder()
							.setCustomId(`${OVERDUE_IDS.done}:${t.task_id}`)
							.setLabel(`Done: ${t.title}`.slice(0, 80))
							.setStyle(ButtonStyle.Success)
					)
			)
		);
	}
	return rows;
}

// ──────────────────────────────────────────────
//  Per-task reminders (existing)
// ──────────────────────────────────────────────

/**
 * Buttons under a per-task reminder. One click marks the task done, through
 * the same path as /task done.
 *
 * @param {string} taskId
 * @returns {ActionRowBuilder}
 */
function buildReminderButtons(taskId) {
	return new ActionRowBuilder().addComponents(
		new ButtonBuilder()
			.setCustomId(`${REMINDER_IDS.done}:${taskId}`)
			.setLabel('Mark done')
			.setStyle(ButtonStyle.Success)
	);
}

async function pollReminders() {
	if (!clientRef) {
		return;
	}

	const now = Math.floor(Date.now() / 1000);

	try {
		const due = taskRepository.claimDueReminders(now);

		for (const reminder of due) {
			try {
				const channel = await clientRef.channels.fetch(reminder.channel_id);
				if (!channel) {
					container.logger.warn(
						`Reminder channel ${reminder.channel_id} not found. Suppressing reminder ${reminder.id}`
					);
					taskRepository.releaseReminder(reminder.id, 'Reminder channel not found', true);
					continue;
				}

				const userMention = `<@${reminder.assigned_to}>`;
				const deadlineStr = `<t:${reminder.deadline}:R>`;

				await channel.send({
					content: `**Reminder** ${userMention}`,
					allowedMentions: { users: [reminder.assigned_to] },
					embeds: [
						{
							color: 0xe67e22,
							title: reminder.title,
							description: reminder.description || 'No description',
							fields: [
								{ name: 'Deadline', value: deadlineStr, inline: true },
								{ name: 'Task ID', value: `\`${reminder.task_id}\``, inline: false }
							],
							timestamp: new Date().toISOString()
						}
					],
					components: [buildReminderButtons(reminder.task_id)]
				});

				taskRepository.markReminderSent(reminder.id);
				container.logger.info(`Sent reminder for task ${reminder.task_id}`);
			} catch (err) {
				container.logger.error(`Failed to send reminder ${reminder.id}`, err);
				const permanent =
					[403, 404].includes(err.code) || /Missing Access|Cannot send messages/i.test(err.message || '');
				taskRepository.releaseReminder(reminder.id, err.message, permanent);
				container.logger.warn(`Reminder ${reminder.id} will be retried after delivery failure`);
			}
		}
	} catch (error) {
		container.logger.error('Reminder poll error', error);
	}
}

// ──────────────────────────────────────────────
//  Weekly task digest (every Monday ≥5AM JKT)
// ──────────────────────────────────────────────

const FIELD_VALUE_LIMIT = 1024;
const MESSAGE_CONTENT_LIMIT = 2000;
const MAX_FIELDS_PER_EMBED = 25;
const MAX_EMBED_TOTAL = 6000;

/**
 * Group tasks so each group's formatted text fits within Discord's 1024-character
 * embed field value limit. Every task is preserved. None are silently dropped.
 * Returns an array of task arrays (one per field chunk).
 *
 * @param {Array<object>} tasks
 * @returns {Array<Array<object>>}
 */
function _groupTasksForFields(tasks) {
	const groups = [];
	let current = [];
	let currentLen = 0;

	for (const t of tasks) {
		const line = `• **${t.title}** - <@${t.assigned_to}> - <t:${t.deadline}:R>`;
		const extra = (current.length > 0 ? 1 : 0) + line.length; // +1 for newline
		if (current.length > 0 && currentLen + extra > FIELD_VALUE_LIMIT) {
			groups.push(current);
			current = [t];
			currentLen = line.length;
		} else {
			current.push(t);
			currentLen += extra;
		}
	}
	if (current.length > 0) {
		groups.push(current);
	}
	return groups;
}

/**
 * Format a single group of tasks into the text for one embed field.
 *
 * @param {Array<object>} group
 * @returns {string}
 */
function _formatTaskGroup(group) {
	if (group.length === 0) {
		return 'No pending tasks.';
	}
	return group.map(t => `• **${t.title}** - <@${t.assigned_to}> - <t:${t.deadline}:R>`).join('\n');
}

/**
 * Estimate the length of the deduplicated mention string for a set of tasks,
 * matching the format produced by `_buildMentions`/`_buildMentionContent`.
 *
 * @param {Array<object>} tasks
 * @returns {number}
 */
function _estimateMentionsLength(tasks) {
	const seen = new Set();
	let len = 0;
	for (const t of tasks) {
		const mention = `<@${t.assigned_to}> `;
		if (!seen.has(mention)) {
			seen.add(mention);
			len += mention.length;
		}
	}
	return len;
}

/**
 * Send a task digest as one or more Discord messages.
 *
 * Each message carries an embed whose fields list a batch of tasks. Its leading
 * content @mentions ONLY the people whose tasks appear in that message.
 * Tasks are split across fields (<=1024 chars each) and across messages
 * (<=25 fields, <=6000 chars total, <=2000 chars of mentions) so the digest
 * never hits Discord's embed limits and never pings people outside the batch
 * shown in that message.
 *
 * @param {import('discord.js').TextBasedChannel} channel
 * @param {object} opts
 * @param {string} opts.title
 * @param {number} opts.color
 * @param {string} opts.description
 * @param {string} opts.footer
 * @param {string} opts.mentionLabel
 * @param {Array<{heading: string, tasks: Array<object>}>} opts.sections
 * @param {number} [opts.maxTasksPerMessage] - Cap on tasks per message, so a
 *   message never carries more tasks than it has buttons for
 * @param {(tasks: Array<object>) => Array<import('discord.js').ActionRowBuilder>} [opts.buildButtons]
 *   - Optional per-message component rows, built from the tasks in that message
 */
async function _sendDigest(
	channel,
	{
		title,
		color,
		description,
		footer,
		mentionLabel,
		digestKey,
		sections,
		maxTasksPerMessage = Infinity,
		buildButtons = null
	}
) {
	// Flatten sections into field groups, labelling chunks when a section splits.
	const fieldGroups = [];
	for (const section of sections) {
		const groups = _groupTasksForFields(section.tasks);
		groups.forEach((group, i) => {
			fieldGroups.push({
				heading: groups.length > 1 ? `${section.heading} (${i + 1}/${groups.length})` : section.heading,
				tasks: group
			});
		});
	}
	if (fieldGroups.length === 0) {
		fieldGroups.push({ heading: 'Tasks', tasks: [] });
	}

	// A single field can hold more tasks than a message has button slots, so
	// split any group that is still too large before packing.
	const boundedGroups = [];
	for (const fg of fieldGroups) {
		if (fg.tasks.length <= maxTasksPerMessage) {
			boundedGroups.push(fg);
			continue;
		}
		for (let i = 0; i < fg.tasks.length; i += maxTasksPerMessage) {
			boundedGroups.push({ heading: fg.heading, tasks: fg.tasks.slice(i, i + maxTasksPerMessage) });
		}
	}

	// Pack field groups into messages, respecting Discord's per-message limits.
	const messages = [];
	let current = null;
	for (const fg of boundedGroups) {
		const value = _formatTaskGroup(fg.tasks);
		// Raw text length plus JSON syntax overhead per field ("name", "value",
		// "inline" keys and quotes) so the serialized embed stays under Discord's
		// 6000-character total limit.
		const fieldLen = fg.heading.length + value.length + 34;
		const mentionsLen = _estimateMentionsLength(fg.tasks);

		const messageOverhead = title.length + description.length + footer.length + 80;
		const overflow =
			!current ||
			current.fields.length >= MAX_FIELDS_PER_EMBED ||
			current.tasks.length + fg.tasks.length > maxTasksPerMessage ||
			current.totalLen + fieldLen + messageOverhead > MAX_EMBED_TOTAL ||
			current.mentionsLen + mentionsLen + 64 > MESSAGE_CONTENT_LIMIT;

		if (overflow) {
			current = { fields: [], tasks: [], totalLen: 0, mentionsLen: 0 };
			messages.push(current);
		}
		current.fields.push({ name: fg.heading, value, inline: false });
		current.tasks.push(...fg.tasks);
		current.totalLen += fieldLen;
		current.mentionsLen += mentionsLen;
	}

	const total = messages.length;

	for (const [idx, m] of messages.entries()) {
		const partKey = digestKey ? `${digestKey}:part:${idx + 1}` : null;
		if (partKey && (taskRepository.hasDigestBeenSent(partKey) || !taskRepository.claimDigestPart(partKey))) {
			continue;
		}
		const embed = new EmbedBuilder().setColor(color);
		if (idx === 0) {
			embed.setTitle(title).setDescription(description);
		} else {
			embed.setTitle(total > 1 ? `${title} (part ${idx + 1}/${total})` : title);
		}
		embed.addFields(m.fields);
		if (idx === total - 1) {
			embed.setFooter({ text: footer }).setTimestamp();
		}

		const mentions = _buildMentions(m.tasks);
		const label = total > 1 ? `${mentionLabel} (part ${idx + 1}/${total})` : mentionLabel;
		const content = _buildMentionContent(label, mentions);
		const components = buildButtons ? buildButtons(m.tasks) : undefined;

		await channel.send({
			content,
			allowedMentions: { users: mentions.map(mention => mention.slice(2, -1)) },
			embeds: [embed],
			...(components && components.length > 0 ? { components } : {})
		});
		if (partKey) {
			taskRepository.markDigestPartSent(partKey);
		}
	}
}

/**
 * Build a sorted, deduplicated list of `<@id>` mentions for task assignees.
 * This list goes into the main message content, because Discord does not
 * trigger mentions that live only inside embed fields.
 * The returned string stays under the 2000 character content limit.
 *
 * @param {Array<object>} tasks - Task rows with an assigned_to string field
 * @returns {string[]} Unique user mentions, one per assignee
 */
function _buildMentions(tasks) {
	const seen = new Set();
	const mentions = [];

	for (const t of tasks) {
		const mention = `<@${t.assigned_to}>`;
		if (!seen.has(mention)) {
			seen.add(mention);
			mentions.push(mention);
		}
	}

	return mentions;
}

/**
 * Join assignee mentions into a content string, capped so the message
 * content never exceeds 2000 characters. Discord ignores mentions inside embed
 * fields. The pings therefore live in the main message content.
 *
 * @param {string} label - Bold label that prefixes the mentions
 * @param {string[]} mentions - Unique user mention strings
 * @returns {string|null} Message content, or null when there are no mentions
 */
function _buildMentionContent(label, mentions) {
	if (mentions.length === 0) {
		return null;
	}

	const prefix = `${label} `;
	const limit = 2000 - prefix.length;
	let content = prefix;

	for (const mention of mentions) {
		if (content.length + mention.length + 1 > limit) {
			break;
		}
		content += `${mention} `;
	}

	return content.trimEnd();
}

/**
 * Check if it's time for the weekly digest (Monday ≥5AM Asia/Jakarta)
 * and send it once per ISO week.
 */
async function pollWeeklyDigest() {
	if (!clientRef) {
		return false;
	}

	const nowJakarta = DateTime.now().setZone('Asia/Jakarta');
	const currentWeek = nowJakarta.weekNumber;

	// Only send on Monday at/after 5:00 AM Jakarta time, once per ISO week
	const digestKey = `weekly:${nowJakarta.weekYear}-${String(currentWeek).padStart(2, '0')}`;
	if (nowJakarta.weekday !== 1 || nowJakarta.hour < 5 || currentWeek === lastDigestWeek) {
		return false;
	}
	// If the persisted digest was already sent (from a prior process cycle),
	// set lastDigestWeek so pollDailyDigest can suppress Monday daily.
	if (taskRepository.hasDigestBeenSent(digestKey)) {
		lastDigestWeek = currentWeek;
		return false;
	}

	lastDigestWeek = currentWeek;

	container.logger.info(`Sending weekly task digest (ISO week ${currentWeek})`);

	const now = Math.floor(Date.now() / 1000);
	const weekRange = computePeriodRange('week', now, 'Asia/Jakarta');
	const monthRange = computePeriodRange('month', now, 'Asia/Jakarta');

	try {
		const weekTasks = taskRepository.listPendingTasks({
			deadlineAfter: weekRange.start,
			deadlineBefore: weekRange.end
		});

		const monthTasks = taskRepository.listPendingTasks({
			deadlineAfter: monthRange.start,
			deadlineBefore: monthRange.end
		});

		const channel = await clientRef.channels.fetch(constants.REMINDER_CHANNEL_ID);
		if (channel?.isTextBased()) {
			await _sendDigest(channel, {
				title: `Weekly Task Digest - Week ${currentWeek}`,
				color: 0x9b59b6,
				description: 'Good morning! Here is an overview of pending tasks.',
				footer: `Sent Monday ${nowJakarta.toLocaleString(DateTime.DATE_HUGE)} at 5AM Jakarta time`,
				mentionLabel: '**Weekly Task Digest**',
				digestKey,
				sections: [
					{ heading: `This Week (${weekTasks.length} tasks)`, tasks: weekTasks },
					{ heading: `This Month (${monthTasks.length} tasks)`, tasks: monthTasks }
				]
			});
			taskRepository.markDigestSent(digestKey);
			container.logger.info(`Weekly digest sent (week ${currentWeek})`);
			return true;
		}
	} catch (error) {
		container.logger.error('Failed to send weekly digest', error);
		// Reset so it retries next poll cycle (within the same Monday window)
		lastDigestWeek = null;
	}
	return false;
}

// ──────────────────────────────────────────────
//  Daily task digest (every day ≥4AM JKT)
// ──────────────────────────────────────────────

/**
 * Check if it's time for the daily digest (≥4AM Asia/Jakarta)
 * and send it once per day.
 * Lists tasks whose deadline falls between start of today and
 * end of this week, both computed in Asia/Jakarta time.
 */
async function pollDailyDigest() {
	if (!clientRef) {
		return false;
	}

	const nowJakarta = DateTime.now().setZone('Asia/Jakarta');

	// Only send at/after 4:00 AM Jakarta time, once per day (Asia/Jakarta date)
	const digestKey = `daily:${nowJakarta.toISODate()}`;
	const weeklyDigestAlreadySent = nowJakarta.weekday === 1 && lastDigestWeek === nowJakarta.weekNumber;
	if (
		nowJakarta.hour < 4 ||
		nowJakarta.toISODate() === lastDigestDate ||
		weeklyDigestSentThisCycle ||
		weeklyDigestAlreadySent
	) {
		return false;
	}
	// If the persisted daily digest was already sent (from a prior process cycle),
	// set lastDigestDate so this poll cycle does not resend.
	if (taskRepository.hasDigestBeenSent(digestKey)) {
		lastDigestDate = nowJakarta.toISODate();
		return false;
	}

	lastDigestDate = nowJakarta.toISODate();

	container.logger.info(`Sending daily task digest (${lastDigestDate})`);

	try {
		const startToday = nowJakarta.startOf('day').toUnixInteger();
		const endOfWeek = nowJakarta.endOf('week').toUnixInteger();

		const tasks = taskRepository.listPendingTasks({
			deadlineAfter: startToday,
			deadlineBefore: endOfWeek
		});

		const channel = await clientRef.channels.fetch(constants.REMINDER_CHANNEL_ID);
		if (channel?.isTextBased()) {
			await _sendDigest(channel, {
				title: `Daily Task Digest - ${nowJakarta.toISODate()}`,
				color: 0x3498db,
				description: 'Good morning! Here are the tasks for today until the end of this week.',
				footer: `Sent ${nowJakarta.toLocaleString(DateTime.DATE_HUGE)} at 4AM Jakarta time`,
				mentionLabel: '**Daily Task Digest**',
				digestKey,
				sections: [{ heading: `Today → End of Week (${tasks.length} tasks)`, tasks }]
			});
			taskRepository.markDigestSent(digestKey);
			container.logger.info(`Daily digest sent (${lastDigestDate})`);
			return true;
		}
	} catch (error) {
		container.logger.error('Failed to send daily digest', error);
		// Reset so it retries next poll cycle (within the same 4AM window)
		lastDigestDate = null;
	}
	return false;
}

// ──────────────────────────────────────────────
//  Overdue task digest (every day ≥10AM JKT)
// ──────────────────────────────────────────────

/**
 * Check if it's time for the overdue digest (≥10AM Asia/Jakarta) and send it
 * once per day.
 *
 * Every pending task whose deadline has already passed is listed, every single
 * day, until it is marked done or cancelled. Nothing is stored per task: the
 * list is recomputed from the pending tasks and the "sent once per day"
 * bookkeeping reuses task_digest_deliveries.
 *
 * Each task gets its own "Mark done" button so the assignee can complete it
 * from the digest without leaving the channel.
 *
 * @param {import('discord.js').Client} [client] - Defaults to the started client
 * @returns {Promise<boolean>} true when a digest was sent
 */
async function pollOverdueDigest(client = clientRef) {
	if (!client) {
		return false;
	}

	const nowJakarta = DateTime.now().setZone('Asia/Jakarta');

	// Only send at/after 10:00 AM Jakarta time, once per day (Asia/Jakarta date)
	const digestKey = `overdue:${nowJakarta.toISODate()}`;
	if (nowJakarta.hour < 10 || taskRepository.hasDigestBeenSent(digestKey)) {
		return false;
	}

	try {
		const now = Math.floor(Date.now() / 1000);
		// Pending, non-cancelled tasks whose deadline already passed.
		const tasks = taskRepository.listPendingTasks({ deadlineBefore: now });

		// Nothing overdue. Stay silent, but remember the day so the poller does
		// not re-query on every cycle until midnight.
		if (tasks.length === 0) {
			taskRepository.markDigestSent(digestKey);
			return false;
		}

		const channel = await client.channels.fetch(constants.REMINDER_CHANNEL_ID);
		if (!channel?.isTextBased()) {
			return false;
		}

		container.logger.info(`Sending overdue task digest (${nowJakarta.toISODate()})`);

		await _sendDigest(channel, {
			title: `Overdue Tasks - ${nowJakarta.toISODate()}`,
			color: 0xe74c3c,
			description:
				'These tasks are past their deadline. They stay listed here every day until they are marked done or cancelled.',
			footer: `Sent ${nowJakarta.toLocaleString(DateTime.DATE_HUGE)} at 10AM Jakarta time`,
			mentionLabel: '**Overdue Tasks**',
			digestKey,
			maxTasksPerMessage: MAX_BUTTONS_PER_MESSAGE,
			buildButtons: buildOverdueButtons,
			sections: [{ heading: `Overdue (${tasks.length} tasks)`, tasks }]
		});

		taskRepository.markDigestSent(digestKey);
		container.logger.info(`Overdue digest sent (${nowJakarta.toISODate()})`);
		return true;
	} catch (error) {
		container.logger.error('Failed to send overdue digest', error);
		return false;
	}
}

module.exports = {
	REMINDER_IDS,
	OVERDUE_IDS,
	MAX_BUTTONS_PER_MESSAGE,
	startReminderService,
	stopReminderService,
	// Exported for testing
	poll,
	pollReminders,
	pollWeeklyDigest,
	pollDailyDigest,
	pollOverdueDigest,
	buildReminderButtons,
	buildOverdueButtons,
	_sendDigest,
	_groupTasksForFields,
	_formatTaskGroup,
	_estimateMentionsLength,
	_buildMentions,
	_buildMentionContent
};
