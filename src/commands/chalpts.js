const { Command } = require('@sapphire/framework');
const { EmbedBuilder } = require('discord.js');
const { getIdHints } = require('../lib/utils');
const { ctfOperations, challengeOperations } = require('../database');
const config = require('../config');

class ChalPtsCommand extends Command {
	constructor(context, options) {
		super(context, {
			...options,
			name: 'chalpts',
			description: 'Set points for a specific Challenge'
		});
	}

	registerApplicationCommands(registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription(this.description)
				.addStringOption(option =>
					option
						.setName('chalname')
						.setDescription('Name of the challenge')
						.setRequired(true)
				)
				.addIntegerOption(option =>
					option
						.setName('pts')
						.setDescription('Points for the challenge')
						.setRequired(true)
				),
		{
			idHints: getIdHints(this.name)
		}
		);
	}

	async chatInputRun(interaction) {
		const channel = interaction.channel;

		if (channel.parentId !== config.ctf.categoryId) {
			return interaction.reply({
				content: '❌ This command can only be used in CTF channels (channels within the CTF category).',
				ephemeral: true
			});
		}

		await interaction.deferReply();

		const chalName = interaction.options.getString('chalname');
		const points = interaction.options.getInteger('pts');

		try {
			// Get CTF from database
			const ctf = ctfOperations.getCTFByChannelId(channel.id);
			if (!ctf) {
				return interaction.editReply('❌ This channel is not registered as a CTF channel in the database.');
			}

			// Get challenge
			const challenge = challengeOperations.getChallengeByName(ctf.id, chalName);
			if (!challenge) {
				return interaction.editReply(`❌ Challenge **${chalName}** not found in this CTF.`);
			}

			// Update points
			challengeOperations.updateChallengePoints(challenge.id, points);

			const embed = new EmbedBuilder()
				.setColor(0x00FF00)
				.setTitle('✅ Points Updated')
				.setDescription(`Points for challenge **${chalName}** have been updated.`)
				.addFields(
					{ name: '📝 Challenge', value: chalName, inline: true },
					{ name: '💯 Points', value: points.toString(), inline: true }
				)
				.setTimestamp();

			await interaction.editReply({ embeds: [embed] });

		} catch (error) {
			this.container.logger.error(error);
			return interaction.editReply('❌ An error occurred while updating challenge points.');
		}
	}
}

module.exports = {
	ChalPtsCommand
};
