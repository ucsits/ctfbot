const { Command } = require('@sapphire/framework');
const { PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { randomUUID } = require('crypto');
const taskRepository = require('../database/repositories/task.repository');
const luce = require('../lib/luce');
const { parseLocalDateToUTC, formatDateInterpretation, computePeriodRange } = require('../lib/utils');
const { DateTime } = require('luxon');
const { checkPermissionReply } = require('../lib/middleware/ensurePermission');
const { ensureGovernanceChannelReply } = require('../lib/middleware/ensureGovernanceChannel');
const { resolveTaskCandidates, MIN_FUZZY_SCORE } = require('../lib/utils/fuzzyMatch');
const constants = require('../lib/constants/config');

// Lazy-loaded calendar sync service — only loaded when GOOGLE_CALENDAR_ENABLED
// is true, so there is no calendar import / side effect when the feature is off.
let _calendarSync = null;
function _syncService() {
	if (_calendarSync === null && constants.GOOGLE_CALENDAR_ENABLED) {
		_calendarSync = require('../services/calendarSync');
	}
	return _calendarSync;
}

/**
 * Append a "Google Calendar synced" suffix to a message when the sync feature
 * is enabled, indicating the task was mirrored to the shared calendar.
 */
function _calendarNote() {
	return constants.GOOGLE_CALENDAR_ENABLED ? '\n\n📅 *Synced to Google Calendar*' : '';
}

// Custom ID namespaces for the task confirmation buttons handled by
// src/listeners/interactionCreate.js. Format: <namespace>:<taskId>[:<score>]
const TASK_DONE_IDS = {
	confirm: 'task_done_confirm',
	candidate: 'task_done_candidate',
	deny: 'task_done_deny'
};
const TASK_CANCEL_IDS = {
	confirm: 'task_cancel_confirm',
	candidate: 'task_cancel_candidate',
	deny: 'task_cancel_deny'
};

class TaskCommand extends Command {
	constructor(context, options) {
		super(context, {
			...options,
			name: 'task',
			description: 'Manage tasks with blockchain-backed tracking'
		});
	}

	registerApplicationCommands(registry) {
		registry.registerChatInputCommand(
			builder =>
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
								opt
									.setName('deadline')
									.setDescription('Deadline — DD-MM-YYYY HH:MM or Unix timestamp (@time compatible)')
									.setMaxLength(64)
									.setRequired(true)
							)
							.addStringOption(opt =>
								opt
									.setName('timezone')
									.setDescription('Your timezone (default: Asia/Jakarta)')
									.setMaxLength(64)
									.setRequired(false)
							)
							.addStringOption(opt =>
								opt
									.setName('description')
									.setDescription('Task description')
									.setMaxLength(4000)
									.setRequired(false)
							)
					)

					// ── subcommand: list ──
					.addSubcommand(sub =>
						sub
							.setName('list')
							.setDescription('View remaining tasks for a period')
							.addStringOption(opt =>
								opt
									.setName('period')
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
								opt
									.setName('user')
									.setDescription('Filter by assigned user (default: yourself)')
									.setRequired(false)
							)
							.addBooleanOption(opt =>
								opt
									.setName('everyone')
									.setDescription('Show tasks for all users (overrides user option)')
									.setRequired(false)
							)
					)

					// ── subcommand: done ──
					.addSubcommand(sub =>
						sub
							.setName('done')
							.setDescription('Mark a task as completed (by ID or fuzzy title search)')
							.addStringOption(opt =>
								opt
									.setName('task_id')
									.setDescription('The task UUID')
									.setMaxLength(36)
									.setRequired(false)
							)
							.addStringOption(opt =>
								opt
									.setName('task')
									.setDescription('Task title (fuzzy search) — requires confirmation')
									.setMaxLength(100)
									.setRequired(false)
							)
					)

					// ── subcommand: cancel ──
					.addSubcommand(sub =>
						sub
							.setName('cancel')
							.setDescription('Cancel a pending task (by ID or fuzzy title search)')
							.addStringOption(opt =>
								opt
									.setName('task_id')
									.setDescription('The task UUID')
									.setMaxLength(36)
									.setRequired(false)
							)
							.addStringOption(opt =>
								opt
									.setName('task')
									.setDescription('Task title (fuzzy search) — requires confirmation')
									.setMaxLength(100)
									.setRequired(false)
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
		const cancelled = await checkPermissionReply(
			interaction,
			PermissionFlagsBits.ManageMessages,
			'Manage Messages'
		);
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

			// 2. Write the task and all of its reminders in one transaction so a
			// failure cannot leave a task with only part of its schedule recorded.
			// Keep timestamps unique so short deadlines do not create duplicate
			// notifications.
			const reminderTimes = new Set();
			const remindAt = deadlineUnix - 3600;
			if (remindAt > Math.floor(Date.now() / 1000)) {
				reminderTimes.add(remindAt);
			}

			// Day-before reminder (9:00 AM Jakarta time, day before deadline)
			const deadlineJakarta = DateTime.fromSeconds(deadlineUnix).setZone('Asia/Jakarta');
			const dayBefore9am = deadlineJakarta
				.minus({ days: 1 })
				.set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
			const dayBeforeRemindAt = dayBefore9am.toUTC().toUnixInteger();
			if (dayBeforeRemindAt > Math.floor(Date.now() / 1000)) {
				reminderTimes.add(dayBeforeRemindAt);
			}

			taskRepository.createTaskWithReminders({
				task: {
					taskId,
					title,
					description,
					assignedTo: assignTo.id,
					createdBy: interaction.user.id,
					deadline: deadlineUnix,
					blockHeight: block.height
				},
				reminders: [...reminderTimes].map(at => ({
					channelId: constants.REMINDER_CHANNEL_ID,
					remindAt: at
				}))
			});

			// 5. Push to Google Calendar (best-effort, never blocks the response)
			const sync = _syncService();
			if (sync) {
				sync.pushTaskUpdate(
					{ task_id: taskId, title, description, assigned_to: assignTo.id, deadline: deadlineUnix, calendar_event_id: null },
					'create'
				).catch(err => this.container.logger.warn(`Calendar push failed for new task ${taskId}: ${err.message}`));
			}

			const embed = new EmbedBuilder()
				.setColor(0x00ff00)
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

			if (constants.GOOGLE_CALENDAR_ENABLED) {
				embed.addFields({ name: 'Google Calendar', value: '📅 Synced to shared calendar', inline: false });
			}

			const interpretation = formatDateInterpretation(deadlineStr, timezone, deadlineDate);
			return interaction.editReply({ content: interpretation, embeds: [embed] });
		} catch (error) {
			this.container.logger.error('Error creating task:', error);
			if (error.message?.includes('Blockchain')) {
				return interaction.editReply('❌ Could not anchor the task on the blockchain. No task was created.');
			}
			return interaction.editReply(
				`⚠️ The task was anchored, but the confirmation could not be completed. Task ID: \`${taskId}\`. Please use /task list to verify it.`
			);
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

			const periodLabel = { week: 'this week', month: 'this month', quarter: 'this quarter', year: 'this year' }[
				period
			];

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
					.setColor(0x3498db)
					.setTitle(
						`📋 Tasks — ${periodLabel}${pages.length > 1 ? ` (page ${index + 1}/${pages.length})` : ''}`
					)
					.setDescription(
						`**${tasks.length}** task(s) remaining for ${listLabel}\nReporting timezone: **Asia/Jakarta**`
					)
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
	//  /task done & /task cancel — shared input resolution
	// ──────────────────────────────────────────────
	/**
	 * Resolve the task targeted by a done/cancel invocation.
	 *
	 * Inputs:
	 *   - task_id (UUID)     → exact lookup (existing behavior)
	 *   - task (title query) → fuzzy search over pending tasks (title +
	 *     description). Multiple close candidates are returned so the caller
	 *     can offer a picker; the transition is NEVER executed directly.
	 *
	 * @returns {Object} { task, candidates, query, viaFuzzy }
	 *   task       — resolved task or null
	 *   candidates — fuzzy candidates (length > 1 = ambiguous)
	 *   query      — the raw title query used (null for UUID path)
	 */
	async _resolveTaskInput(interaction) {
		const taskId = interaction.options.getString('task_id')?.trim();
		const query = interaction.options.getString('task')?.trim();

		if (!taskId && !query) {
			return { error: '❌ Provide either `task_id` (the task UUID) or `task` (task title to fuzzy search).' };
		}

		// ── UUID path (exact) ──
		if (taskId) {
			if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId)) {
				return { error: '❌ Task ID must be a valid UUID.' };
			}
			const task = taskRepository.getTask(taskId);
			if (!task) {
				return { error: '❌ Task not found. Check the task ID.' };
			}
			return { task, candidates: [], query: null, viaFuzzy: false };
		}

		// ── Fuzzy title path ──
		const candidates = resolveTaskCandidates({
			query,
			tasks: taskRepository.searchTasksByQuery()
		});
		if (candidates.length === 0) {
			return {
				error: `❌ No task found matching **${query}** (minimum confidence ${Math.round(MIN_FUZZY_SCORE * 100)}%). Try a task ID or a more specific title.`
			};
		}
		return {
			task: candidates[0],
			candidates,
			query,
			viaFuzzy: true
		};
	}

	/**
	 * Render the task summary used in confirmation embeds.
	 */
	_taskSummaryFields(task, extra = {}) {
		const fields = [
			{ name: 'Assigned To', value: `<@${task.assigned_to}>`, inline: true },
			{ name: 'Deadline', value: `<t:${task.deadline}:F>`, inline: true }
		];
		if (extra.score !== undefined) {
			fields.push({ name: 'Match Confidence', value: `${Math.round(extra.score * 100)}%`, inline: true });
		}
		if (task.description) {
			fields.push({ name: 'Description', value: task.description.slice(0, 1024), inline: false });
		}
		return fields;
	}

	/**
	 * Build the ephemeral confirmation reply for a single resolved task.
	 * Nothing is claimed or written until the user presses Confirm.
	 */
	_taskConfirmReply({ interaction, ids, verb, emoji, color, task, score, extraTitle }) {
		const embed = new EmbedBuilder()
			.setColor(color)
			.setTitle(`${emoji} Confirm ${verb}?`)
			.setDescription(
				`**${task.title}**\nThis will ${verb.toLowerCase()} the task and record it on the blockchain.` +
					(extraTitle ? `\n${extraTitle}` : '')
			)
			.addFields(this._taskSummaryFields(task, { score }))
			.setTimestamp();

		// The initiator id is embedded in every button customId so the listener
		// can verify the clicker is the user who ran the command.
		const initiatorId = interaction.user.id;
		const row = new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`${ids.confirm}:${task.task_id}:${score ?? ''}:${initiatorId}`)
				.setLabel(`Confirm ${verb}`)
				.setStyle(ButtonStyle.Success),
			new ButtonBuilder()
				.setCustomId(`${ids.deny}:${task.task_id}::${initiatorId}`)
				.setLabel('Deny')
				.setStyle(ButtonStyle.Danger)
		);

		return interaction.editReply({
			content: '⚠️ **Action requires confirmation.** Nothing has been recorded yet.',
			embeds: [embed],
			components: [row],
			ephemeral: true
		});
	}

	/**
	 * Build the candidate-picker reply when several tasks match the query.
	 */
	_taskPickerReply({ interaction, ids, _verb, emoji, color, candidates, query }) {
		const embed = new EmbedBuilder()
			.setColor(color)
			.setTitle(`${emoji} Multiple tasks match "${query}"`)
			.setDescription('Pick the task you meant. Nothing has been recorded yet.')
			.setTimestamp();

		// The initiator id is embedded in every picker button customId so the
		// listener can verify the clicker is the user who ran the command.
		const initiatorId = interaction.user.id;
		const rows = [];
		for (let i = 0; i < candidates.length; i += 5) {
			rows.push(
				new ActionRowBuilder().addComponents(
					candidates.slice(i, i + 5).map(c =>
						new ButtonBuilder()
							.setCustomId(`${ids.candidate}:${c.task_id}:${c.score}:${initiatorId}`)
							.setLabel(`${i + 1}. ${c.title.slice(0, 80)}`)
							.setStyle(ButtonStyle.Primary)
					)
				)
			);
		}

		return interaction.editReply({
			content: `⚠️ **${candidates.length} tasks match "${query}".** Pick one to continue. Nothing has been recorded yet.`,
			embeds: [embed],
			components: rows,
			ephemeral: true
		});
	}

	/**
	 * Execute the claimed done transition for an already-confirmed task.
	 * Shared by /task done and the confirm button handler so there is exactly
	 * one code path that writes to the blockchain and the database.
	 */
	async _executeDone(task, interaction) {
		if (!taskRepository.claimTaskTransition({ taskId: task.task_id, actorId: interaction.user.id })) {
			return '⚠️ This task is already being updated by another action. Please try again.';
		}

		try {
			// 1. Anchor the completion block at most once. beginTaskTransition
			// records the attempt, so a retry after a lost response can see that
			// the chain write already happened and skip a duplicate append.
			const transition = taskRepository.beginTaskTransition({
				taskId: task.task_id,
				action: 'done',
				actorId: interaction.user.id
			});

			if (transition.block_height === null) {
				const data = JSON.stringify({
					type: 'task_done',
					v: 1,
					taskId: task.task_id,
					title: task.title,
					assignedTo: task.assigned_to,
					completedBy: interaction.user.id
				});

				const block = await luce.appendBlock({
					author: interaction.user.id,
					data
				});

				taskRepository.setTaskTransitionBlock({
					taskId: task.task_id,
					action: 'done',
					blockHeight: block.height
				});
			}

			// 2. Update DB. A concurrent done/cancel action may have won the race.
			if (
				!taskRepository.completeTask({
					taskId: task.task_id,
					completedBy: interaction.user.id
				})
			) {
				return '⚠️ This task was already updated by another action; no completion was recorded.';
			}

			// Push to Google Calendar (best-effort)
			const sync = _syncService();
			if (sync) {
				sync.pushTaskUpdate(task, 'delete').catch(err => this.container.logger.warn(`Calendar push failed for done task ${task.task_id}: ${err.message}`));
			}

			return { content: `✅ Task **${task.title}** marked as done!${_calendarNote()}` };
		} catch (error) {
			this.container.logger.error('Error completing task:', error);
			// Release the transition claim so the task is not blocked until the
			// lease expires; the user can immediately retry.
			taskRepository.releaseTaskTransition({ taskId: task.task_id, actorId: interaction.user.id });
			return `⚠️ Could not complete task **${task.title}**. No completion was recorded; please try again.`;
		}
	}

	/**
	 * Execute the claimed cancel transition for an already-confirmed task.
	 * Shared by /task cancel and the confirm button handler.
	 */
	async _executeCancel(task, interaction) {
		if (!taskRepository.claimTaskTransition({ taskId: task.task_id, actorId: interaction.user.id })) {
			return '⚠️ This task is already being updated by another action. Please try again.';
		}

		try {
			// 1. Anchor the cancellation block at most once. See _executeDone for
			// why the attempt is recorded before the append.
			const transition = taskRepository.beginTaskTransition({
				taskId: task.task_id,
				action: 'cancel',
				actorId: interaction.user.id
			});

			if (transition.block_height === null) {
				const data = JSON.stringify({
					type: 'task_cancel',
					v: 1,
					taskId: task.task_id,
					title: task.title,
					assignedTo: task.assigned_to,
					cancelledBy: interaction.user.id
				});

				const block = await luce.appendBlock({
					author: interaction.user.id,
					data
				});

				taskRepository.setTaskTransitionBlock({
					taskId: task.task_id,
					action: 'cancel',
					blockHeight: block.height
				});
			}

			// 2. Update DB (marks cancelled, removes reminders)
			if (
				!taskRepository.cancelTask({
					taskId: task.task_id,
					cancelledBy: interaction.user.id
				})
			) {
				return '⚠️ This task was already updated by another action; no cancellation was recorded.';
			}

			// Push to Google Calendar (best-effort)
			const sync = _syncService();
			if (sync) {
				sync.pushTaskUpdate(task, 'cancel').catch(err => this.container.logger.warn(`Calendar push failed for cancelled task ${task.task_id}: ${err.message}`));
			}

			return { content: `🗑️ Task **${task.title}** has been cancelled and removed from the pending list.${_calendarNote()}` };
		} catch (error) {
			this.container.logger.error('Error cancelling task:', error);
			// Release the transition claim so the task is not blocked until the
			// lease expires; the user can immediately retry.
			taskRepository.releaseTaskTransition({ taskId: task.task_id, actorId: interaction.user.id });
			return `⚠️ Could not cancel task **${task.title}**. No cancellation was recorded; please try again.`;
		}
	}

	// ──────────────────────────────────────────────
	//  /task done
	// ──────────────────────────────────────────────
	async _done(interaction) {
		const cancelled = await checkPermissionReply(
			interaction,
			PermissionFlagsBits.ManageMessages,
			'Manage Messages'
		);
		if (cancelled) {
			return;
		}

		await interaction.deferReply({ ephemeral: true });

		const resolved = await this._resolveTaskInput(interaction);
		if (resolved.error) {
			return interaction.editReply({ content: resolved.error, ephemeral: true });
		}

		// Title-based (fuzzy) matches ALWAYS require confirmation so a
		// low-confidence title/description match is never marked done silently.
		if (resolved.viaFuzzy) {
			if (resolved.candidates.length > 1) {
				return this._taskPickerReply({
					interaction,
					ids: TASK_DONE_IDS,
					verb: 'Done',
					emoji: '✅',
					color: 0x00ff00,
					candidates: resolved.candidates,
					query: resolved.query
				});
			}
			return this._taskConfirmReply({
				interaction,
				ids: TASK_DONE_IDS,
				verb: 'Done',
				emoji: '✅',
				color: 0x00ff00,
				task: resolved.task,
				score: resolved.task.score,
				extraTitle: `Matched by title search for **${resolved.query}**.`
			});
		}

		// UUID path — verify current state before asking for confirmation.
		const existing = resolved.task;
		if (existing.status === 'done') {
			return interaction.editReply({ content: '❌ This task is already marked as done.', ephemeral: true });
		}
		if (existing.cancelled) {
			return interaction.editReply({ content: '❌ This task has already been cancelled.', ephemeral: true });
		}

		return this._taskConfirmReply({
			interaction,
			ids: TASK_DONE_IDS,
			verb: 'Done',
			emoji: '✅',
			color: 0x00ff00,
			task: existing
		});
	}

	// ──────────────────────────────────────────────
	//  /task cancel
	// ──────────────────────────────────────────────
	async _cancel(interaction) {
		const cancelled = await checkPermissionReply(
			interaction,
			PermissionFlagsBits.ManageMessages,
			'Manage Messages'
		);
		if (cancelled) {
			return;
		}

		await interaction.deferReply({ ephemeral: true });

		const resolved = await this._resolveTaskInput(interaction);
		if (resolved.error) {
			return interaction.editReply({ content: resolved.error, ephemeral: true });
		}

		// Title-based (fuzzy) matches ALWAYS require confirmation so a
		// low-confidence title/description match is never cancelled silently.
		if (resolved.viaFuzzy) {
			if (resolved.candidates.length > 1) {
				return this._taskPickerReply({
					interaction,
					ids: TASK_CANCEL_IDS,
					verb: 'Cancellation',
					emoji: '🗑️',
					color: 0xe74c3c,
					candidates: resolved.candidates,
					query: resolved.query
				});
			}
			return this._taskConfirmReply({
				interaction,
				ids: TASK_CANCEL_IDS,
				verb: 'Cancellation',
				emoji: '🗑️',
				color: 0xe74c3c,
				task: resolved.task,
				score: resolved.task.score,
				extraTitle: `Matched by title search for **${resolved.query}**.`
			});
		}

		// UUID path — verify current state before asking for confirmation.
		const existing = resolved.task;
		if (existing.status === 'done') {
			return interaction.editReply({ content: '❌ Cannot cancel a task that is already done.', ephemeral: true });
		}
		if (existing.cancelled) {
			return interaction.editReply({ content: '❌ This task has already been cancelled.', ephemeral: true });
		}

		return this._taskConfirmReply({
			interaction,
			ids: TASK_CANCEL_IDS,
			verb: 'Cancellation',
			emoji: '🗑️',
			color: 0xe74c3c,
			task: existing
		});
	}
}

module.exports = { TaskCommand, TASK_DONE_IDS, TASK_CANCEL_IDS };
