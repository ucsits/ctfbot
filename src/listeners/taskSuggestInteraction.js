const { Listener } = require('@sapphire/framework');
const {
	EmbedBuilder,
	ModalBuilder,
	LabelBuilder,
	TextInputBuilder,
	TextInputStyle,
	UserSelectMenuBuilder,
	PermissionFlagsBits
} = require('discord.js');
const { randomUUID } = require('crypto');
const { DateTime } = require('luxon');
const taskSuggest = require('../services/taskSuggest');
const taskRepository = require('../database/repositories/task.repository');
const { parseLocalDateToUTC } = require('../lib/utils');
const { checkPermissionReply } = require('../lib/middleware/ensurePermission');
const constants = require('../lib/constants/config');

const { SUGGEST_IDS, TIMEZONE } = taskSuggest;

/**
 * Handle the buttons and modal on task suggestion cards posted by
 * src/services/taskSuggest.js. The custom ids are
 *   tsug_create:<id>   create the task as suggested
 *   tsug_edit:<id>     open a pre-filled modal (tsug_modal:<id>) that creates on submit
 *   tsug_dismiss:<id>  close the suggestion without creating anything
 *   tsug_cancel:<id>   cancel the existing task a cancellation card targets
 *   tsug_keep:<id>     keep the existing task and close the cancellation card
 *   tsug_done:<id>     mark the existing task done, from a done card
 *   tsug_notdone:<id>  leave the task pending and close the done card
 * Tasks are written through TaskCommand.createTaskRecord, the same path as
 * /task add, completions through TaskCommand._executeDone, the same path as
 * /task done, and cancellations through TaskCommand._executeCancel, the same
 * path as /task cancel.
 */
class TaskSuggestInteractionListener extends Listener {
	constructor(context, options) {
		super(context, {
			...options,
			event: 'interactionCreate',
			name: 'task-suggest-interaction-handler'
		});
	}

	async run(interaction) {
		if (!interaction.isButton() && !interaction.isModalSubmit()) {
			return;
		}

		const [namespace, proposalId] = interaction.customId.split(':');
		if (!proposalId) {
			return;
		}

		try {
			if (interaction.isButton()) {
				if (namespace === SUGGEST_IDS.create) {
					return await this._create(interaction, proposalId);
				}
				if (namespace === SUGGEST_IDS.edit) {
					return await this._showModal(interaction, proposalId);
				}
				if (namespace === SUGGEST_IDS.dismiss) {
					return await this._dismiss(interaction, proposalId);
				}
				if (namespace === SUGGEST_IDS.cancel) {
					return await this._cancelTask(interaction, proposalId);
				}
				if (namespace === SUGGEST_IDS.keep) {
					return await this._keep(interaction, proposalId);
				}
				if (namespace === SUGGEST_IDS.done) {
					return await this._completeTask(interaction, proposalId);
				}
				if (namespace === SUGGEST_IDS.notDone) {
					return await this._notDone(interaction, proposalId);
				}
			} else if (namespace === SUGGEST_IDS.modal) {
				return await this._submitModal(interaction, proposalId);
			}
		} catch (error) {
			this.container.logger.error('Error handling task suggestion interaction', error);
			taskSuggest.releaseProposal(proposalId);
			const reply = { content: 'Something went wrong handling this suggestion.', ephemeral: true };
			await (
				interaction.deferred || interaction.replied ? interaction.followUp(reply) : interaction.reply(reply)
			).catch(() => {});
		}
	}

	_unavailable(interaction, proposalId) {
		return interaction.reply({
			content: taskSuggest.unavailableMessage(proposalId),
			ephemeral: true,
			allowedMentions: { parse: [] }
		});
	}

	async _denied(interaction) {
		return checkPermissionReply(interaction, PermissionFlagsBits.ManageMessages, 'Manage Messages');
	}

	async _create(interaction, proposalId) {
		if (await this._denied(interaction)) {
			return;
		}

		const proposal = taskSuggest.claimProposal(proposalId);
		if (!proposal) {
			return this._unavailable(interaction, proposalId);
		}
		if (proposal.kind !== 'create') {
			taskSuggest.releaseProposal(proposalId);
			return interaction.reply({
				content: 'This card is not a task creation card.',
				ephemeral: true
			});
		}
		if (!proposal.deadline || proposal.deadline <= Math.floor(Date.now() / 1000)) {
			taskSuggest.releaseProposal(proposalId);
			return interaction.reply({
				content: 'This suggestion has no future deadline. Use **Edit & create** to set one.',
				ephemeral: true
			});
		}

		await interaction.deferUpdate();
		return this._createTask(interaction, proposal, {
			title: proposal.title,
			description: proposal.description,
			assignedTo: proposal.assigneeId,
			deadline: proposal.deadline
		});
	}

	async _showModal(interaction, proposalId) {
		if (await this._denied(interaction)) {
			return;
		}

		const proposal = taskSuggest.getProposal(proposalId);
		if (!proposal) {
			return this._unavailable(interaction, proposalId);
		}
		if (proposal.kind !== 'create') {
			return interaction.reply({
				content: 'This card is not a task creation card.',
				ephemeral: true
			});
		}

		const titleInput = new TextInputBuilder()
			.setCustomId('title')
			.setStyle(TextInputStyle.Short)
			.setMaxLength(100)
			.setRequired(true)
			.setValue(proposal.title);

		const assigneeSelect = new UserSelectMenuBuilder().setCustomId('assignee').setMinValues(1).setMaxValues(1);
		if (proposal.assigneeId) {
			assigneeSelect.setDefaultUsers(proposal.assigneeId);
		}

		const deadlineInput = new TextInputBuilder()
			.setCustomId('deadline')
			.setStyle(TextInputStyle.Short)
			.setMaxLength(64)
			.setRequired(true)
			.setPlaceholder('DD-MM-YYYY HH:MM');
		if (proposal.deadline) {
			deadlineInput.setValue(
				DateTime.fromSeconds(proposal.deadline).setZone(TIMEZONE).toFormat('dd-MM-yyyy HH:mm')
			);
		}

		const descriptionInput = new TextInputBuilder()
			.setCustomId('description')
			.setStyle(TextInputStyle.Paragraph)
			.setMaxLength(4000)
			.setRequired(false);
		if (proposal.description) {
			descriptionInput.setValue(proposal.description);
		}

		const modal = new ModalBuilder()
			.setCustomId(`${SUGGEST_IDS.modal}:${proposal.id}`)
			.setTitle('Create task')
			.addLabelComponents(
				new LabelBuilder().setLabel('Title').setTextInputComponent(titleInput),
				new LabelBuilder().setLabel('Assign to').setUserSelectMenuComponent(assigneeSelect),
				new LabelBuilder()
					.setLabel('Deadline')
					.setDescription(`DD-MM-YYYY HH:MM in ${TIMEZONE} time`)
					.setTextInputComponent(deadlineInput),
				new LabelBuilder().setLabel('Description').setTextInputComponent(descriptionInput)
			);

		return interaction.showModal(modal);
	}

	async _submitModal(interaction, proposalId) {
		if (await this._denied(interaction)) {
			return;
		}

		const proposal = taskSuggest.claimProposal(proposalId);
		if (!proposal) {
			return this._unavailable(interaction, proposalId);
		}
		if (proposal.kind !== 'create') {
			taskSuggest.releaseProposal(proposalId);
			return interaction.reply({
				content: 'This card is not a task creation card.',
				ephemeral: true
			});
		}

		const title = interaction.fields.getTextInputValue('title')?.trim();
		const description = interaction.fields.getTextInputValue('description')?.trim() || null;
		const assignee = interaction.fields.getSelectedUsers('assignee')?.first();
		const deadlineStr = interaction.fields.getTextInputValue('deadline')?.trim();

		const invalid = message => {
			taskSuggest.releaseProposal(proposalId);
			return interaction.reply({ content: `${message}\nPress **Edit & create** to try again.`, ephemeral: true });
		};

		if (!title || title.length > 100) {
			return invalid('Task title must be between 1 and 100 characters.');
		}
		if (!assignee) {
			return invalid('Pick who the task is assigned to.');
		}

		let deadlineDate;
		try {
			deadlineDate = parseLocalDateToUTC(deadlineStr, TIMEZONE);
		} catch (error) {
			return invalid(`${error.message}`);
		}
		if (deadlineDate <= new Date()) {
			return invalid('Deadline must be in the future.');
		}

		await interaction.deferUpdate();
		return this._createTask(interaction, proposal, {
			title,
			description,
			assignedTo: assignee.id,
			deadline: Math.floor(deadlineDate.getTime() / 1000)
		});
	}

	async _dismiss(interaction, proposalId) {
		if (await this._denied(interaction)) {
			return;
		}

		const proposal = taskSuggest.claimProposal(proposalId);
		if (!proposal) {
			return this._unavailable(interaction, proposalId);
		}
		taskSuggest.finishProposal(proposalId, { status: 'dismissed', handledBy: interaction.user.id });

		// Remove the card so dismissed suggestions do not clutter the channel.
		// The row stays. The model still knows this was not wanted.
		await interaction.deferUpdate();
		try {
			await interaction.message.delete();
		} catch (error) {
			this.container.logger.warn(`Could not delete dismissed suggestion card ${error.message}`);
			const embed = new EmbedBuilder()
				.setColor(0x95a5a6)
				.setTitle('Suggestion dismissed')
				.setDescription(`~~${proposal.title}~~`)
				.setFooter({ text: `Dismissed by ${interaction.member?.displayName ?? interaction.user.username}` });
			await interaction.editReply({ embeds: [embed], components: [] });
		}
	}

	/**
	 * Cancel the task a cancellation card targets, through the same path as
	 * /task cancel. The card is only closed once the transition succeeded.
	 */
	async _cancelTask(interaction, proposalId) {
		if (await this._denied(interaction)) {
			return;
		}

		const proposal = taskSuggest.claimProposal(proposalId);
		if (!proposal) {
			return this._unavailable(interaction, proposalId);
		}
		if (proposal.kind !== 'cancel' || !proposal.targetTaskId) {
			taskSuggest.releaseProposal(proposalId);
			return interaction.reply({
				content: 'This card is not a cancellation card.',
				ephemeral: true
			});
		}

		const task = taskRepository.getTask(proposal.targetTaskId);
		if (!task || task.status !== 'pending' || task.cancelled) {
			// Nothing left to cancel. Close the card instead of leaving it open.
			taskSuggest.finishProposal(proposalId, {
				status: 'cancelled',
				handledBy: interaction.user.id,
				taskId: proposal.targetTaskId
			});
			return interaction.update({
				content: 'This task was already done or cancelled.',
				embeds: [],
				components: []
			});
		}

		await interaction.deferUpdate();
		const taskCommand = this.container.stores.get('commands').get('task');
		const result = await taskCommand._executeCancel(task, interaction);

		if (typeof result !== 'object') {
			taskSuggest.releaseProposal(proposalId);
			return interaction.followUp({ content: result, ephemeral: true });
		}

		taskSuggest.finishProposal(proposalId, {
			status: 'cancelled',
			handledBy: interaction.user.id,
			taskId: task.task_id
		});
		return interaction.editReply({ content: result.content, embeds: [], components: [] });
	}

	/**
	 * Mark the task a done card targets as done, through the same path as
	 * /task done. The card is only closed once the transition succeeded.
	 */
	async _completeTask(interaction, proposalId) {
		if (await this._denied(interaction)) {
			return;
		}

		const proposal = taskSuggest.claimProposal(proposalId);
		if (!proposal) {
			return this._unavailable(interaction, proposalId);
		}
		if (proposal.kind !== 'done' || !proposal.targetTaskId) {
			taskSuggest.releaseProposal(proposalId);
			return interaction.reply({
				content: 'This card is not a done card.',
				ephemeral: true
			});
		}

		const task = taskRepository.getTask(proposal.targetTaskId);
		if (!task || task.status !== 'pending' || task.cancelled) {
			// Nothing left to complete. Close the card instead of leaving it open.
			taskSuggest.finishProposal(proposalId, {
				status: 'done',
				handledBy: interaction.user.id,
				taskId: proposal.targetTaskId
			});
			return interaction.update({
				content: 'This task was already done or cancelled.',
				embeds: [],
				components: []
			});
		}

		await interaction.deferUpdate();
		const taskCommand = this.container.stores.get('commands').get('task');
		const result = await taskCommand._executeDone(task, interaction);

		if (typeof result !== 'object') {
			taskSuggest.releaseProposal(proposalId);
			return interaction.followUp({ content: result, ephemeral: true });
		}

		taskSuggest.finishProposal(proposalId, {
			status: 'done',
			handledBy: interaction.user.id,
			taskId: task.task_id
		});
		return interaction.editReply({ content: result.content, embeds: [], components: [] });
	}

	/** Leave the task pending and close the done card without recording anything. */
	async _notDone(interaction, proposalId) {
		if (await this._denied(interaction)) {
			return;
		}

		const proposal = taskSuggest.claimProposal(proposalId);
		if (!proposal) {
			return this._unavailable(interaction, proposalId);
		}
		if (proposal.kind !== 'done') {
			taskSuggest.releaseProposal(proposalId);
			return interaction.reply({
				content: 'This card is not a done card.',
				ephemeral: true
			});
		}
		taskSuggest.finishProposal(proposalId, {
			status: 'kept',
			handledBy: interaction.user.id,
			taskId: proposal.targetTaskId
		});

		return interaction.update({
			content: `Left **${proposal.title}** pending. Nothing was recorded.`,
			embeds: [],
			components: []
		});
	}

	/** Keep the task and close the cancellation card without recording anything. */
	async _keep(interaction, proposalId) {
		if (await this._denied(interaction)) {
			return;
		}

		const proposal = taskSuggest.claimProposal(proposalId);
		if (!proposal) {
			return this._unavailable(interaction, proposalId);
		}
		taskSuggest.finishProposal(proposalId, {
			status: 'kept',
			handledBy: interaction.user.id,
			taskId: proposal.targetTaskId
		});

		return interaction.update({
			content: `Kept **${proposal.title}**. Nothing was cancelled.`,
			embeds: [],
			components: []
		});
	}

	/**
	 * Write the task and replace the suggestion card with the result. The
	 * interaction must already be deferred with deferUpdate.
	 */
	async _createTask(interaction, proposal, { title, description, assignedTo, deadline }) {
		const taskCommand = this.container.stores.get('commands').get('task');
		const taskId = randomUUID();

		try {
			const { block } = await taskCommand.createTaskRecord({
				taskId,
				title,
				description,
				assignedTo,
				createdBy: interaction.user.id,
				deadline
			});
			taskSuggest.finishProposal(proposal.id, { status: 'created', handledBy: interaction.user.id, taskId });

			const embed = new EmbedBuilder()
				.setColor(0x00ff00)
				.setTitle('Task Created')
				.setDescription(`**${title}** has been created on the blockchain.`)
				.addFields(
					{ name: 'Assigned To', value: `<@${assignedTo}>`, inline: true },
					{ name: 'Deadline', value: `<t:${deadline}:F>`, inline: true },
					{ name: 'Block Height', value: `#${block.height}`, inline: true },
					{ name: 'Task ID', value: `\`${taskId}\``, inline: false }
				)
				.setFooter({ text: `Accepted by ${interaction.member?.displayName ?? interaction.user.username}` })
				.setTimestamp();

			if (description) {
				embed.addFields({ name: 'Description', value: description.slice(0, 1024), inline: false });
			}
			if (constants.GOOGLE_CALENDAR_ENABLED) {
				embed.addFields({ name: 'Google Calendar', value: 'Synced to shared calendar', inline: false });
			}

			return interaction.editReply({ embeds: [embed], components: [] });
		} catch (error) {
			this.container.logger.error('Error creating task from suggestion', error);
			if (error.message?.includes('Blockchain')) {
				taskSuggest.releaseProposal(proposal.id);
				return interaction.followUp({
					content: 'Could not anchor the task on the blockchain. No task was created. You can try again.',
					ephemeral: true
				});
			}
			// The block was anchored, which means the task exists. Never offer the card
			// again.
			taskSuggest.finishProposal(proposal.id, { status: 'created', handledBy: interaction.user.id, taskId });
			return interaction.followUp({
				content: `The task was anchored, but the confirmation could not be completed. Task ID \`${taskId}\`. Please use /task list to verify it.`,
				ephemeral: true
			});
		}
	}
}

module.exports = { TaskSuggestInteractionListener };
