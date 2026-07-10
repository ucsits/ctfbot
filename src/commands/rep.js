const { Command } = require('@sapphire/framework');
const { EmbedBuilder } = require('discord.js');
const reputationRepository = require('../database/repositories/reputation.repository');
const luce = require('../lib/luce');

class RepCommand extends Command {
	constructor(context, options) {
		super(context, {
			...options,
			name: 'rep',
			description: 'Give reputation to a user (+1 / -1)'
		});
	}

	registerApplicationCommands(registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription(this.description)
				.addBooleanOption(opt =>
					opt.setName('downvote')
						.setDescription('Set to true for -1 (downvote). Omit or false for +1.')
						.setRequired(false)
				),
			{
				idHints: require('../lib/utils/commandIds').getIdHints('rep')
			}
		);
	}

	async chatInputRun(interaction) {
		// Must be used while replying to someone's message.
		// Detect this by fetching channel message history and checking
		// if the user's most recent message before the command was a reply.
		await interaction.deferReply({ ephemeral: true });

		let targetUser;

		try {
			// Fetch recent messages to find the user's last reply
			const messages = await interaction.channel.messages.fetch({ limit: 20 });
			const userMsg = messages.find(
				m => m.author.id === interaction.user.id
				  && m.type === 0  // TYPE.DEFAULT — only regular messages
				  && m.reference   // has a reply reference
			);

			if (!userMsg || !userMsg.reference?.messageId) {
				return interaction.editReply({
					content: '❌ You must reply to a user\'s message before using `/rep`. Click reply on a message, then type `/rep`.'
				});
			}

			const repliedTo = await interaction.channel.messages.fetch(userMsg.reference.messageId);
			if (!repliedTo.author || repliedTo.author.bot) {
				return interaction.editReply({
					content: '❌ You can only give rep to other users, not bots.'
				});
			}

			if (repliedTo.author.id === interaction.user.id) {
				return interaction.editReply({
					content: '❌ You cannot give rep to yourself.'
				});
			}

			targetUser = repliedTo.author;
		} catch (err) {
			this.container.logger.error('Error fetching reply context:', err);
			return interaction.editReply({
				content: '❌ Could not determine who you\'re replying to. Make sure you reply to a message first.'
			});
		}

		const downvote = interaction.options.getBoolean('downvote') || false;
		const amount = downvote ? -1 : 1;

		// Daily limit check
		if (reputationRepository.hasGivenRepToday(interaction.user.id)) {
			return interaction.editReply({
				content: '❌ You\'ve already given rep today! Try again tomorrow.'
			});
		}

		try {
			const data = JSON.stringify({
				type: 'rep',
				v: 1,
				toUser: targetUser.id,
				fromUser: interaction.user.id,
				amount,
				reason: '',
				date: new Date().toISOString().slice(0, 10)
			});

			const block = await luce.appendBlock({
				author: interaction.user.id,
				data
			});

			reputationRepository.addReputation({
				userId: targetUser.id,
				fromUser: interaction.user.id,
				amount,
				reason: null,
				blockHeight: block.height
			});

			const verb = amount > 0 ? '⬆️ +1' : '⬇️ -1';
			const label = amount > 0 ? 'upvote' : 'downvote';

			const embed = new EmbedBuilder()
				.setColor(amount > 0 ? 0x00FF00 : 0xFF0000)
				.setTitle(`${verb} Rep given`)
				.setDescription(`${interaction.user} gave ${label} rep to ${targetUser}`)
				.addFields(
					{ name: 'Block', value: `#${block.height}`, inline: true }
				)
				.setTimestamp();

			return interaction.editReply({ embeds: [embed] });
		} catch (error) {
			this.container.logger.error('Error giving rep:', error);
			return interaction.editReply({
				content: '❌ Failed to record rep. Blockchain error: ' + error.message
			});
		}
	}
}

module.exports = { RepCommand };
