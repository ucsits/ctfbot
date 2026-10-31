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
const { parseLocalDateToUTC } = require('../lib/utils');
const { checkPermissionReply } = require('../lib/middleware/ensurePermission');
const constants = require('../lib/constants/config');

const { SUGGEST_IDS, TIMEZONE } = taskSuggest;

/**
 * Handle the buttons and modal on task suggestion cards posted by
 * src/services/taskSuggest.js:
 *   tsug_create:<id>   create the task as suggested
 *   tsug_edit:<id>     open a pre-filled modal (tsug_modal:<id>) that creates on submit
 *   tsug_dismiss:<id>  close the suggestion without creating anything
 * Tasks are written through TaskCommand.createTaskRecord, the same path as /task add.
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
			} else if (namespace === SUGGEST_IDS.modal) {
				return await this._submitModal(interaction, proposalId);
			}
		} catch (error) {
			this.container.logger.error('Error handling task suggestion interaction:', error);
			taskSuggest.releaseProposal(proposalId);
			const reply = { content: '❌ Something went wrong handling this suggestion.', ephemeral: true };
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
		if (!proposal.deadline || proposal.deadline <= Math.floor(Date.now() / 1000)) {
			taskSuggest.releaseProposal(proposalId);
			return interaction.reply({
				content: '❌ This suggestion has no future deadline. Use **Edit & create** to set one.',
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

		const title = interaction.fields.getTextInputValue('title')?.trim();
		const description = interaction.fields.getTextInputValue('description')?.trim() || null;
		const assignee = interaction.fields.getSelectedUsers('assignee')?.first();
		const deadlineStr = interaction.fields.getTextInputValue('deadline')?.trim();

		const invalid = message => {
			taskSuggest.releaseProposal(proposalId);
			return interaction.reply({ content: `${message}\nPress **Edit & create** to try again.`, ephemeral: true });
		};

		if (!title || title.length > 100) {
			return invalid('❌ Task title must be between 1 and 100 characters.');
		}
		if (!assignee) {
			return invalid('❌ Pick who the task is assigned to.');
		}

		let deadlineDate;
		try {
			deadlineDate = parseLocalDateToUTC(deadlineStr, TIMEZONE);
		} catch (error) {
			return invalid(`❌ ${error.message}`);
		}
		if (deadlineDate <= new Date()) {
			return invalid('❌ Deadline must be in the future.');
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
		// The row stays, so the model still knows this was not wanted.
		await interaction.deferUpdate();
		try {
			await interaction.message.delete();
		} catch (error) {
			this.container.logger.warn(`Could not delete dismissed suggestion card: ${error.message}`);
			const embed = new EmbedBuilder()
				.setColor(0x95a5a6)
				.setTitle('Suggestion dismissed')
				.setDescription(`~~${proposal.title}~~`)
				.setFooter({ text: `Dismissed by ${interaction.member?.displayName ?? interaction.user.username}` });
			await interaction.editReply({ embeds: [embed], components: [] });
		}
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
				.setTitle('✅ Task Created')
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
				embed.addFields({ name: 'Google Calendar', value: '📅 Synced to shared calendar', inline: false });
			}

			return interaction.editReply({ embeds: [embed], components: [] });
		} catch (error) {
			this.container.logger.error('Error creating task from suggestion:', error);
			if (error.message?.includes('Blockchain')) {
				taskSuggest.releaseProposal(proposal.id);
				return interaction.followUp({
					content:
						'❌ Could not anchor the task on the blockchain. No task was created, so you can try again.',
					ephemeral: true
				});
			}
			// The block was anchored, so the task exists; never offer the card again.
			taskSuggest.finishProposal(proposal.id, { status: 'created', handledBy: interaction.user.id, taskId });
			return interaction.followUp({
				content: `⚠️ The task was anchored, but the confirmation could not be completed. Task ID: \`${taskId}\`. Please use /task list to verify it.`,
				ephemeral: true
			});
		}
	}
}

module.exports = { TaskSuggestInteractionListener };
