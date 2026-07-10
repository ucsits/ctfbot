/**
 * Reminder Service
 * Background poller that checks for unsent task reminders and sends
 * them to the configured Discord channel.
 *
 * @module services/reminder
 */

const { container } = require('@sapphire/framework');
const constants = require('../lib/constants/config');
const taskRepository = require('../database/repositories/task.repository');

let intervalHandle = null;
let clientRef = null;

/**
 * Start the reminder polling service.
 * Polls every 30 seconds for due reminders.
 *
 * @param {import('discord.js').Client} client - Discord client instance
 */
function startReminderService(client) {
	clientRef = client;
	const interval = 30_000; // 30 seconds

	container.logger.info('Starting reminder service (polling every 30s)');

	intervalHandle = setInterval(pollReminders, interval);

	// Also run once immediately
	pollReminders();
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

module.exports = {
	startReminderService,
	stopReminderService
};
