const { Command } = require('@sapphire/framework');
const { PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { randomUUID } = require('crypto');
const taskRepository = require('../database/repositories/task.repository');
const luce = require('../lib/luce');
const { parseLocalDateToUTC, formatDateInterpretation, computePeriodRange } = require('../lib/utils');
const { DateTime } = require('luxon');
const { checkPermissionReply } = require('../lib/middleware/ensurePermission');
const { ensureGovernanceChannelReply } = require('../lib/middleware/ensureGovernanceChannel');
const constants = require('../lib/constants/config');

class TaskCommand extends Command {
	constructor(context, options) {
		super(context, {
			...options,
			name: 'task',
			description: 'Manage tasks with blockchain-backed tracking'
		});
	}

	registerApplicationCommands(registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription(this.description)

				// ── subcommand: add ──
				.addSubcommand(sub =>
					sub
						.setName('add')
						.setDescription('Create a new task')
						.addStringOption(opt =>
							opt.setName('title').setDescription('Task title').setMaxLength(100).setRequired(true)
						)
						.addUserOption(opt =>
							opt.setName('assign_to').setDescription('Who to assign this task to').setRequired(true)
						)
						.addStringOption(opt =>
							opt.setName('deadline').setDescription('Deadline — DD-MM-YYYY HH:MM or Unix timestamp (@time compatible)').setMaxLength(64).setRequired(true)
						)
						.addStringOption(opt =>
							opt.setName('timezone').setDescription('Your timezone (default: Asia/Jakarta)').setMaxLength(64).setRequired(false)
						)
						.addStringOption(opt =>
							opt.setName('description').setDescription('Task description').setMaxLength(4000).setRequired(false)
						)
				)

				// ── subcommand: list ──
				.addSubcommand(sub =>
					sub
						.setName('list')
						.setDescription('View remaining tasks for a period')
						.addStringOption(opt =>
							opt.setName('period')
								.setDescription('Time period')
								.setRequired(true)
								.addChoices(
									{ name: 'This Week', value: 'week' },
									{ name: 'This Month', value: 'month' },
									{ name: 'This Quarter', value: 'quarter' },
									{ name: 'This Year', value: 'year' }
								)
						)
						.addUserOption(opt =>
							opt.setName('user')
								.setDescription('Filter by assigned user (default: yourself)')
								.setRequired(false)
						)
						.addBooleanOption(opt =>
							opt.setName('everyone')
								.setDescription('Show tasks for all users (overrides user option)')
								.setRequired(false)
						)
				)

				// ── subcommand: done ──
				.addSubcommand(sub =>
					sub
						.setName('done')
						.setDescription('Mark a task as completed')
						.addStringOption(opt =>
							opt.setName('task_id').setDescription('The task UUID').setMaxLength(36).setRequired(true)
						)
				)

				// ── subcommand: cancel ──
				.addSubcommand(sub =>
					sub
						.setName('cancel')
						.setDescription('Cancel a pending task')
						.addStringOption(opt =>
							opt.setName('task_id').setDescription('The task UUID').setMaxLength(36).setRequired(true)
						)
						.addBooleanOption(opt =>
							opt.setName('confirm').setDescription('Confirm cancelling this task').setRequired(true)
						)
				),
		{
			idHints: require('../lib/utils/commandIds').getIdHints('task')
		}
		);
	}

	async chatInputRun(interaction) {
		// Restrict to governance channel categories
		const cancelled = await ensureGovernanceChannelReply(interaction);
		if (cancelled) {
			return;
		}

		const sub = interaction.options.getSubcommand();

		if (sub === 'add') {
			return this._add(interaction);
		}
		if (sub === 'list') {
			return this._list(interaction);
		}
		if (sub === 'done') {
			return this._done(interaction);
		}
		if (sub === 'cancel') {
			return this._cancel(interaction);
		}
	}

	// ──────────────────────────────────────────────
	//  /task add
	// ──────────────────────────────────────────────
	async _add(interaction) {
		const cancelled = await checkPermissionReply(interaction, PermissionFlagsBits.ManageMessages, 'Manage Messages');
		if (cancelled) {
			return;
		}

		await interaction.deferReply();

		const title = interaction.options.getString('title')?.trim();
		const description = interaction.options.getString('description')?.trim() || null;
		if (!title || title.length > 100) {
			return interaction.editReply('❌ Task title must be between 1 and 100 characters.');
		}
		if (description && description.length > 4000) {
			return interaction.editReply('❌ Task description cannot exceed 4000 characters.');
		}
		const assignTo = interaction.options.getUser('assign_to');
		const deadlineStr = interaction.options.getString('deadline');

		const timezone = interaction.options.getString('timezone')?.trim() || 'Asia/Jakarta';
		if (timezone.length > 64) {
			return interaction.editReply('❌ Timezone is too long. Use a valid IANA timezone.');
		}

		// Parse deadline with timezone support
		let deadlineDate;
		try {
			deadlineDate = parseLocalDateToUTC(deadlineStr, timezone);
		} catch (error) {
			return interaction.editReply(`❌ ${error.message}`);
		}

		if (deadlineDate <= new Date()) {
			return interaction.editReply('❌ Deadline must be in the future.');
		}

		const deadlineUnix = Math.floor(deadlineDate.getTime() / 1000);

		const taskId = randomUUID();

		try {
			// 1. Write to blockchain
			const data = JSON.stringify({
				type: 'task',
				v: 1,
				taskId,
				title,
				description: description || '',
				assignedTo: assignTo.id,
				createdBy: interaction.user.id,
				deadline: deadlineUnix
			});

			const block = await luce.appendBlock({
				author: interaction.user.id,
				data
			});

			// 2. Write to DB
			taskRepository.createTask({
				taskId,
				title,
				description,
				assignedTo: assignTo.id,
				createdBy: interaction.user.id,
				deadline: deadlineUnix,
				blockHeight: block.height
			});

			// 3. Create reminders. Keep timestamps unique so short deadlines do not
			// create duplicate notifications.
			const reminderTimes = new Set();
			const remindAt = deadlineUnix - 3600;
			if (remindAt > Math.floor(Date.now() / 1000)) {
				reminderTimes.add(remindAt);
			}

			// 4. Create day-before reminder (9:00 AM Jakarta time, day before deadline)
			const deadlineJakarta = DateTime.fromSeconds(deadlineUnix).setZone('Asia/Jakarta');
			const dayBefore9am = deadlineJakarta.minus({ days: 1 }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
			const dayBeforeRemindAt = dayBefore9am.toUTC().toUnixInteger();
			if (dayBeforeRemindAt > Math.floor(Date.now() / 1000)) {
				reminderTimes.add(dayBeforeRemindAt);
			}
			for (const remindAt of reminderTimes) {
				taskRepository.createReminder({
					taskId,
					channelId: constants.REMINDER_CHANNEL_ID,
					remindAt
				});
			}

			const embed = new EmbedBuilder()
				.setColor(0x00FF00)
				.setTitle('✅ Task Created')
				.setDescription(`**${title}** has been created on the blockchain.`)
				.addFields(
					{ name: 'Assigned To', value: assignTo.toString(), inline: true },
					{ name: 'Deadline', value: `<t:${deadlineUnix}:F>`, inline: true },
					{ name: 'Block Height', value: `#${block.height}`, inline: true },
					{ name: 'Task ID', value: `\`${taskId}\``, inline: false }
				)
				.setTimestamp();

			if (description) {
				embed.addFields({ name: 'Description', value: description.slice(0, 1024), inline: false });
			}

			const interpretation = formatDateInterpretation(deadlineStr, timezone, deadlineDate);
			return interaction.editReply({ content: interpretation, embeds: [embed] });
		} catch (error) {
			this.container.logger.error('Error creating task:', error);
			if (error.message?.includes('Blockchain')) {
				return interaction.editReply('❌ Could not anchor the task on the blockchain. No task was created.');
			}
			return interaction.editReply(`⚠️ The task was anchored, but the confirmation could not be completed. Task ID: \`${taskId}\`. Please use /task list to verify it.`);
		}
	}

	// ──────────────────────────────────────────────
	//  /task list
	// ──────────────────────────────────────────────
	async _list(interaction) {
		await interaction.deferReply();

		const period = interaction.options.getString('period');
		const userOpt = interaction.options.getUser('user');
		const showEveryone = interaction.options.getBoolean('everyone');

		// Determine assignedTo filter: null means show all
		let assignedTo;
		let listLabel;
		if (showEveryone) {
			assignedTo = null;
			listLabel = 'everyone';
		} else if (userOpt) {
			assignedTo = userOpt.id;
			listLabel = userOpt.toString();
		} else {
			assignedTo = interaction.user.id;
			listLabel = 'you';
		}

		const now = Math.floor(Date.now() / 1000);
		const range = computePeriodRange(period, now, 'Asia/Jakarta');

		try {
			const tasks = taskRepository.listPendingTasks({
				assignedTo,
				deadlineAfter: range.start,
				deadlineBefore: range.end
			});

			const periodLabel = { week: 'this week', month: 'this month', quarter: 'this quarter', year: 'this year' }[period];

			if (tasks.length === 0) {
				return interaction.editReply({
					content: `✅ No remaining tasks for ${periodLabel}!`
				});
			}

			// Discord permits at most 25 embed fields. Send navigable-sized pages as
			// follow-ups rather than failing the entire list for large result sets.
			const pages = [];
			for (let i = 0; i < tasks.length; i += 20) {
				pages.push(tasks.slice(i, i + 20));
			}

			for (const [index, pageTasks] of pages.entries()) {
				const embed = new EmbedBuilder()
					.setColor(0x3498DB)
					.setTitle(`📋 Tasks — ${periodLabel}${pages.length > 1 ? ` (page ${index + 1}/${pages.length})` : ''}`)
					.setDescription(`**${tasks.length}** task(s) remaining for ${listLabel}\nReporting timezone: **Asia/Jakarta**`)
					.setTimestamp();

				for (const t of pageTasks) {
					const deadlineStr = `<t:${t.deadline}:R>`;
					embed.addFields({
						name: `${t.title}`,
						value: `Assigned to: <@${t.assigned_to}>\nDeadline: ${deadlineStr}\nID: \`${t.task_id}\``,
						inline: false
					});
				}

				if (index === 0) {
					await interaction.editReply({ embeds: [embed] });
				} else {
					await interaction.followUp({ embeds: [embed] });
				}
			}
			return;
		} catch (error) {
			this.container.logger.error('Error listing tasks:', error);
			return interaction.editReply('❌ Failed to list tasks.');
		}
	}

	// ──────────────────────────────────────────────
	//  /task done
	// ──────────────────────────────────────────────
	async _done(interaction) {
		const cancelled = await checkPermissionReply(interaction, PermissionFlagsBits.ManageMessages, 'Manage Messages');
		if (cancelled) {
			return;
		}

		await interaction.deferReply();

		const taskId = interaction.options.getString('task_id')?.trim();
		if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId)) {
			return interaction.editReply('❌ Task ID must be a valid UUID.');
		}

		let existing;
		try {
			existing = taskRepository.getTask(taskId);
			if (!existing) {
				return interaction.editReply('❌ Task not found. Check the task ID.');
			}
			if (existing.status === 'done') {
				return interaction.editReply('❌ This task is already marked as done.');
			}
			if (existing.cancelled) {
				return interaction.editReply('❌ This task has already been cancelled.');
			}

			if (!taskRepository.claimTaskTransition({ taskId, actorId: interaction.user.id })) {
				return interaction.editReply('⚠️ This task is already being updated by another action. Please try again.');
			}

			// 1. Write completion to blockchain
			const data = JSON.stringify({
				type: 'task_done',
				v: 1,
				taskId,
				title: existing.title,
				assignedTo: existing.assigned_to,
				completedBy: interaction.user.id
			});

			await luce.appendBlock({
				author: interaction.user.id,
				data
			});

			// 2. Update DB. A concurrent done/cancel action may have won the race.
			if (!taskRepository.completeTask({
				taskId,
				completedBy: interaction.user.id
			})) {
				return interaction.editReply('⚠️ This task was already updated by another action; no completion was recorded.');
			}
		} catch (error) {
			this.container.logger.error('Error completing task:', error);
			// Release the transition claim so the task is not blocked until the
			// lease expires; the user can immediately retry.
			taskRepository.releaseTaskTransition({ taskId, actorId: interaction.user.id });
			return interaction.editReply(`⚠️ Could not complete task **${taskId}**. No completion was recorded; please try again.`);
		}

		// Response is separate from persistence so a reply failure does not
		// produce a misleading "no completion recorded" error.
		try {
			return interaction.editReply({
				content: `✅ Task **${existing.title}** marked as done!`
			});
		} catch (replyError) {
			this.container.logger.error('Task done reply failed (task was already completed):', replyError);
			return;
		}
	}

	// ──────────────────────────────────────────────
	//  /task cancel
	// ──────────────────────────────────────────────
	async _cancel(interaction) {
		const cancelled = await checkPermissionReply(interaction, PermissionFlagsBits.ManageMessages, 'Manage Messages');
		if (cancelled) {
			return;
		}

		await interaction.deferReply();

		const taskId = interaction.options.getString('task_id')?.trim();
		const confirm = interaction.options.getBoolean('confirm');
		if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId)) {
			return interaction.editReply('❌ Task ID must be a valid UUID.');
		}

		let existing;
		try {
			existing = taskRepository.getTask(taskId);
			if (!existing) {
				return interaction.editReply('❌ Task not found. Check the task ID.');
			}
			if (existing.status === 'done') {
				return interaction.editReply('❌ Cannot cancel a task that is already done.');
			}
			if (existing.cancelled) {
				return interaction.editReply('❌ This task has already been cancelled.');
			}
			if (!confirm) {
				return interaction.editReply(
					`⚠️ Cancellation not confirmed. This will remove reminders for **${existing.title}** (deadline <t:${existing.deadline}:F>). Run the command again with **confirm: True** to continue.`
				);
			}

			if (!taskRepository.claimTaskTransition({ taskId, actorId: interaction.user.id })) {
				return interaction.editReply('⚠️ This task is already being updated by another action. Please try again.');
			}

			// 1. Write cancellation to blockchain
			const data = JSON.stringify({
				type: 'task_cancel',
				v: 1,
				taskId,
				title: existing.title,
				assignedTo: existing.assigned_to,
				cancelledBy: interaction.user.id
			});

			await luce.appendBlock({
				author: interaction.user.id,
				data
			});

			// 2. Update DB (marks cancelled, removes reminders)
			if (!taskRepository.cancelTask({
				taskId,
				cancelledBy: interaction.user.id
			})) {
				return interaction.editReply('⚠️ This task was already updated by another action; no cancellation was recorded.');
			}
		} catch (error) {
			this.container.logger.error('Error cancelling task:', error);
			// Release the transition claim so the task is not blocked until the
			// lease expires; the user can immediately retry.
			taskRepository.releaseTaskTransition({ taskId, actorId: interaction.user.id });
			return interaction.editReply(`⚠️ Could not cancel task **${taskId}**. No cancellation was recorded; please try again.`);
		}

		// Response is separate from persistence so a reply failure does not
		// produce a misleading "no cancellation recorded" error.
		try {
			return interaction.editReply({
				content: `🗑️ Task **${existing.title}** has been cancelled and removed from the pending list.`
			});
		} catch (replyError) {
			this.container.logger.error('Task cancel reply failed (task was already cancelled):', replyError);
			return;
		}
	}

}

module.exports = { TaskCommand };
