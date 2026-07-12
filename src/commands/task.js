const { Command } = require('@sapphire/framework');
const { PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { randomUUID } = require('crypto');
const { getConnection } = require('../database/connection');
const taskRepository = require('../database/repositories/task.repository');
const luce = require('../lib/luce');
const { sendErrorResponse, sendSuccessResponse } = require('../lib/utils/response');
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
							opt.setName('title').setDescription('Task title').setRequired(true)
						)
						.addUserOption(opt =>
							opt.setName('assign_to').setDescription('Who to assign this task to').setRequired(true)
						)
						.addStringOption(opt =>
							opt.setName('deadline').setDescription('Deadline — DD-MM-YYYY HH:MM or Unix timestamp (@time compatible)').setRequired(true)
						)
						.addStringOption(opt =>
							opt.setName('timezone').setDescription('Your timezone (default: Asia/Jakarta)').setRequired(false)
						)
						.addStringOption(opt =>
							opt.setName('description').setDescription('Task description').setRequired(false)
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
							opt.setName('task_id').setDescription('The task UUID').setRequired(true)
						)
				)

				// ── subcommand: cancel ──
				.addSubcommand(sub =>
					sub
						.setName('cancel')
						.setDescription('Cancel a pending task')
						.addStringOption(opt =>
							opt.setName('task_id').setDescription('The task UUID').setRequired(true)
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

		const title = interaction.options.getString('title');
		const description = interaction.options.getString('description');
		const assignTo = interaction.options.getUser('assign_to');
		const deadlineStr = interaction.options.getString('deadline');

		const timezone = interaction.options.getString('timezone') || 'Asia/Jakarta';

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

			// 3. Create reminder (1 hour before deadline)
			const remindAt = deadlineUnix - 3600;
			if (remindAt > Math.floor(Date.now() / 1000)) {
				taskRepository.createReminder({
					taskId,
					channelId: constants.REMINDER_CHANNEL_ID,
					remindAt
				});
			}

			// 4. Create day-before reminder (9:00 AM Jakarta time, day before deadline)
			const deadlineJakarta = DateTime.fromSeconds(deadlineUnix).setZone('Asia/Jakarta');
			const dayBefore9am = deadlineJakarta.minus({ days: 1 }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
			const dayBeforeRemindAt = dayBefore9am.toUTC().toUnixInteger();
			if (dayBeforeRemindAt > Math.floor(Date.now() / 1000)) {
				taskRepository.createReminder({
					taskId,
					channelId: constants.REMINDER_CHANNEL_ID,
					remindAt: dayBeforeRemindAt
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
				embed.addFields({ name: 'Description', value: description, inline: false });
			}

			const interpretation = formatDateInterpretation(deadlineStr, timezone, deadlineDate);
			return interaction.editReply({ content: interpretation, embeds: [embed] });
		} catch (error) {
			this.container.logger.error('Error creating task:', error);
			return interaction.editReply('❌ Failed to create task. Blockchain error: ' + error.message);
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
		const range = computePeriodRange(period, now);

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

			const embed = new EmbedBuilder()
				.setColor(0x3498DB)
				.setTitle(`📋 Tasks — ${periodLabel}`)
				.setDescription(`**${tasks.length}** task(s) remaining for ${listLabel}`)
				.setTimestamp();

			for (const t of tasks) {
				const deadlineStr = `<t:${t.deadline}:R>`;
				embed.addFields({
					name: `${t.title}`,
					value: `Deadline: ${deadlineStr}\nID: \`${t.task_id}\``,
					inline: false
				});
			}

			return interaction.editReply({ embeds: [embed] });
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

		const taskId = interaction.options.getString('task_id');

		try {
			const existing = taskRepository.getTask(taskId);
			if (!existing) {
				return interaction.editReply('❌ Task not found. Check the task ID.');
			}
			if (existing.status === 'done') {
				return interaction.editReply('❌ This task is already marked as done.');
			}
			if (existing.cancelled) {
				return interaction.editReply('❌ This task has already been cancelled.');
			}

			// 1. Write completion to blockchain
			const data = JSON.stringify({
				type: 'task_done',
				v: 1,
				taskId,
				completedBy: interaction.user.id
			});

			await luce.appendBlock({
				author: interaction.user.id,
				data
			});

			// 2. Update DB
			taskRepository.completeTask({
				taskId,
				completedBy: interaction.user.id
			});

			return interaction.editReply({
				content: `✅ Task **${existing.title}** marked as done!`
			});
		} catch (error) {
			this.container.logger.error('Error completing task:', error);
			return interaction.editReply('❌ Failed to complete task. Blockchain error: ' + error.message);
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

		const taskId = interaction.options.getString('task_id');

		try {
			const existing = taskRepository.getTask(taskId);
			if (!existing) {
				return interaction.editReply('❌ Task not found. Check the task ID.');
			}
			if (existing.status === 'done') {
				return interaction.editReply('❌ Cannot cancel a task that is already done.');
			}
			if (existing.cancelled) {
				return interaction.editReply('❌ This task has already been cancelled.');
			}

			// 1. Write cancellation to blockchain
			const data = JSON.stringify({
				type: 'task_cancel',
				v: 1,
				taskId,
				cancelledBy: interaction.user.id
			});

			await luce.appendBlock({
				author: interaction.user.id,
				data
			});

			// 2. Update DB (marks cancelled, removes reminders)
			taskRepository.cancelTask({
				taskId,
				cancelledBy: interaction.user.id
			});

			return interaction.editReply({
				content: `🗑️ Task **${existing.title}** has been cancelled and removed from the pending list.`
			});
		} catch (error) {
			this.container.logger.error('Error cancelling task:', error);
			return interaction.editReply('❌ Failed to cancel task. Blockchain error: ' + error.message);
		}
	}

}

module.exports = { TaskCommand };
