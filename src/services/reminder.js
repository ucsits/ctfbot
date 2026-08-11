/**
 * Reminder Service
 * Background poller that checks for unsent task reminders and sends
 * them to the configured Discord channel.
 *
 * Also handles the weekly task digest (every Monday ≥5AM Asia/Jakarta)
 * and the daily task digest (every day ≥4AM Asia/Jakarta).
 *
 * @module services/reminder
 */

const { container } = require('@sapphire/framework');
const { EmbedBuilder } = require('discord.js');
const { DateTime } = require('luxon');
const constants = require('../lib/constants/config');
const taskRepository = require('../database/repositories/task.repository');
const { computePeriodRange } = require('../lib/utils/date');

let intervalHandle = null;
let clientRef = null;

/** @type {number|null} Last ISO week number for which the digest was sent */
let lastDigestWeek = null;

/** @type {string|null} Last date (YYYY-MM-DD Asia/Jakarta) for which the daily digest was sent */
let lastDigestDate = null;

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

	intervalHandle = setInterval(poll, interval);

	// Also run once immediately
	poll();
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
 * Single poll cycle: check due per-task reminders, weekly digest, daily digest.
 */
async function poll() {
	await pollReminders();
	await pollWeeklyDigest();
	await pollDailyDigest();
}

// ──────────────────────────────────────────────
//  Per-task reminders (existing)
// ──────────────────────────────────────────────

async function pollReminders() {
	if (!clientRef) {
		return;
	}

	const now = Math.floor(Date.now() / 1000);

	try {
		const due = taskRepository.getDueReminders(now);

		for (const reminder of due) {
			try {
				const channel = await clientRef.channels.fetch(reminder.channel_id);
				if (!channel) {
					container.logger.warn(`Reminder channel ${reminder.channel_id} not found`);
					taskRepository.markReminderSent(reminder.id);
					continue;
				}

				const userMention = `<@${reminder.assigned_to}>`;
				const deadlineStr = `<t:${reminder.deadline}:R>`;

				await channel.send({
					content: `⏰ **Reminder** ${userMention}`,
					embeds: [{
						color: 0xE67E22,
						title: reminder.title,
						description: reminder.description || 'No description',
						fields: [
							{ name: 'Deadline', value: deadlineStr, inline: true },
							{ name: 'Task ID', value: `\`${reminder.task_id}\``, inline: false }
						],
						timestamp: new Date().toISOString()
					}]
				});

				taskRepository.markReminderSent(reminder.id);
				container.logger.info(`Sent reminder for task ${reminder.task_id}`);
			} catch (err) {
				container.logger.error(`Failed to send reminder ${reminder.id}:`, err);
				// Mark as sent anyway to avoid retry loops on permanent errors
				taskRepository.markReminderSent(reminder.id);
			}
		}
	} catch (error) {
		container.logger.error('Reminder poll error:', error);
	}
}

// ──────────────────────────────────────────────
//  Weekly task digest (every Monday ≥5AM JKT)
// ──────────────────────────────────────────────

/**
 * Format a list of tasks into a compact string for the digest embed.
 * If the list is empty, returns "✅ No pending tasks."
 */
function _formatTaskList(tasks) {
	if (tasks.length === 0) {
		return '✅ No pending tasks.';
	}

	return tasks
		.slice(0, 15) // cap at 15 to avoid embed field limits
		.map(t => {
			const deadline = `<t:${t.deadline}:R>`;
			return `• **${t.title}** - <@${t.assigned_to}> - ${deadline}`;
		})
		.join('\n') + (tasks.length > 15 ? `\n… and ${tasks.length - 15} more` : '');
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
 * content never exceeds 2000 characters. Discord ignores mentions
 * inside embed fields, so the pings live in the main message content.
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
		return;
	}

	const nowJakarta = DateTime.now().setZone('Asia/Jakarta');
	const currentWeek = nowJakarta.weekNumber;

	// Only send on Monday at/after 5:00 AM Jakarta time, once per ISO week
	if (nowJakarta.weekday !== 1 || nowJakarta.hour < 5 || currentWeek === lastDigestWeek) {
		return;
	}

	lastDigestWeek = currentWeek;

	container.logger.info(`Sending weekly task digest (ISO week ${currentWeek})`);

	const now = Math.floor(Date.now() / 1000);
	const weekRange = computePeriodRange('week', now);
	const monthRange = computePeriodRange('month', now);

	try {
		const weekTasks = taskRepository.listPendingTasks({
			deadlineAfter: weekRange.start,
			deadlineBefore: weekRange.end
		});

		const monthTasks = taskRepository.listPendingTasks({
			deadlineAfter: monthRange.start,
			deadlineBefore: monthRange.end
		});

		const weekText = _formatTaskList(weekTasks);
		const monthText = _formatTaskList(monthTasks);

		const embed = new EmbedBuilder()
			.setColor(0x9B59B6)
			.setTitle(`📋 Weekly Task Digest - Week ${currentWeek}`)
			.setDescription('Good morning! Here is an overview of pending tasks.')
			.addFields(
				{ name: `🗓️ This Week (${weekTasks.length} tasks)`, value: weekText, inline: false },
				{ name: `📅 This Month (${monthTasks.length} tasks)`, value: monthText, inline: false }
			)
			.setFooter({ text: `Sent Monday ${nowJakarta.toLocaleString(DateTime.DATE_HUGE)} at 5AM Jakarta time` })
			.setTimestamp();

		const channel = await clientRef.channels.fetch(constants.REMINDER_CHANNEL_ID);
		if (channel?.isTextBased()) {
			const mentions = _buildMentions([...weekTasks, ...monthTasks]);
			const mentionContent = _buildMentionContent('📋 **Weekly Task Digest**', mentions);

			await channel.send({
				content: mentionContent,
				embeds: [embed]
			});
			container.logger.info(`Weekly digest sent (week ${currentWeek})`);
		}
	} catch (error) {
		container.logger.error('Failed to send weekly digest:', error);
		// Reset so it retries next poll cycle (within the same Monday window)
		lastDigestWeek = null;
	}
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
		return;
	}

	const nowJakarta = DateTime.now().setZone('Asia/Jakarta');

	// Only send at/after 4:00 AM Jakarta time, once per day (Asia/Jakarta date)
	if (nowJakarta.hour < 4 || nowJakarta.toISODate() === lastDigestDate) {
		return;
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

		const embed = new EmbedBuilder()
			.setColor(0x3498DB)
			.setTitle(`📅 Daily Task Digest - ${nowJakarta.toISODate()}`)
			.setDescription('Good morning! Here are the tasks for today until the end of this week.')
			.addFields({ name: `🗓️ Today → End of Week (${tasks.length} tasks)`, value: _formatTaskList(tasks), inline: false })
			.setFooter({ text: `Sent ${nowJakarta.toLocaleString(DateTime.DATE_HUGE)} at 4AM Jakarta time` })
			.setTimestamp();

		const channel = await clientRef.channels.fetch(constants.REMINDER_CHANNEL_ID);
		if (channel?.isTextBased()) {
			const mentions = _buildMentions(tasks);
			const mentionContent = _buildMentionContent('📅 **Daily Task Digest**', mentions);

			await channel.send({
				content: mentionContent,
				embeds: [embed]
			});
			container.logger.info(`Daily digest sent (${lastDigestDate})`);
		}
	} catch (error) {
		container.logger.error('Failed to send daily digest:', error);
		// Reset so it retries next poll cycle (within the same 4AM window)
		lastDigestDate = null;
	}
}

module.exports = {
	startReminderService,
	stopReminderService
};
