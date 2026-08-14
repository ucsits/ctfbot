const { Command } = require('@sapphire/framework');
const { EmbedBuilder } = require('discord.js');
const { activityRepository } = require('../database');
const { getIdHints } = require('../lib/utils');

class ActivityPointsCommand extends Command {
	constructor(context, options) {
		super(context, {
			...options,
			name: 'activitypoints',
			description: 'View your (or another user\u2019s) activity points balance'
		});
	}

	registerApplicationCommands(registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription(this.description)
				.addUserOption(opt =>
					opt
						.setName('user')
						.setDescription('User whose balance to check (default: you)')
						.setRequired(false)
				),
		{
			idHints: getIdHints(this.name)
		}
		);
	}

	async chatInputRun(interaction) {
		await interaction.deferReply();

		const target = interaction.options.getUser('user') || interaction.user;

		try {
			const balance = activityRepository.getBalance(target.id);

			const embed = new EmbedBuilder()
				.setColor(0x9B59B6)
				.setTitle('🎯 Activity Points')
				.setDescription(`${target} has **${balance} AP**`)
				.addFields(
					{ name: 'User', value: target.toString(), inline: true },
					{ name: 'Balance', value: `**${balance} AP**`, inline: true }
				)
				.setTimestamp();

			return interaction.editReply({ embeds: [embed] });
		} catch (error) {
			this.container.logger.error('Error fetching activity points:', error);
			return interaction.editReply('❌ Failed to fetch activity points.');
		}
	}
}

module.exports = { ActivityPointsCommand };
