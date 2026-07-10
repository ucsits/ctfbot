/**
 * Reminder Service
 * Background poller that checks for unsent task reminders and sends
 * them to the configured Discord channel.
 *
 * Also handles the weekly task digest (every Monday ≥5AM Asia/Jakarta).
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

/**
 * Start the reminder polling service.
 * Polls every 30 seconds for due reminders and weekly digest check.
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
 * Single poll cycle: check due per-task reminders + weekly digest.
 */
async function poll() {
	await pollReminders();
	await pollWeeklyDigest();
}

// ──────────────────────────────────────────────
//  Per-task reminders (existing)
// ──────────────────────────────────────────────

async function pollReminders() {
	if (!clientRef) return;

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
	if (tasks.length === 0) return '✅ No pending tasks.';

	return tasks
		.slice(0, 15) // cap at 15 to avoid embed field limits
		.map(t => {
			const deadline = `<t:${t.deadline}:R>`;
			return `• **${t.title}** — <@${t.assigned_to}> — ${deadline}`;
		})
		.join('\n') + (tasks.length > 15 ? `\n… and ${tasks.length - 15} more` : '');
}

/**
 * Check if it's time for the weekly digest (Monday ≥5AM Asia/Jakarta)
 * and send it once per ISO week.
 */
async function pollWeeklyDigest() {
	if (!clientRef) return;

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
			.setTitle(`📋 Weekly Task Digest — Week ${currentWeek}`)
			.setDescription(`Good morning! Here's an overview of pending tasks.`)
			.addFields(
				{ name: `🗓️ This Week (${weekTasks.length} tasks)`, value: weekText, inline: false },
				{ name: `📅 This Month (${monthTasks.length} tasks)`, value: monthText, inline: false }
			)
			.setFooter({ text: `Sent Monday ${nowJakarta.toLocaleString(DateTime.DATE_HUGE)} at 5AM Jakarta time` })
			.setTimestamp();

		const channel = await clientRef.channels.fetch(constants.REMINDER_CHANNEL_ID);
		if (channel?.isTextBased()) {
			await channel.send({ embeds: [embed] });
			container.logger.info(`Weekly digest sent (week ${currentWeek})`);
		}
	} catch (error) {
		container.logger.error('Failed to send weekly digest:', error);
		// Reset so it retries next poll cycle (within the same Monday window)
		lastDigestWeek = null;
	}
}

module.exports = {
	startReminderService,
	stopReminderService
};
