const { Command } = require('@sapphire/framework');
const { EmbedBuilder } = require('discord.js');
const { getIdHints } = require('../utils');
const { pactOperations } = require('../database');

class PactCommand extends Command {
	constructor(context, options) {
		super(context, {
			...options,
			name: 'pact',
			description: 'Register your Name and NRP'
		});
	}

	registerApplicationCommands(registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription(this.description)
				.addStringOption(option =>
					option
						.setName('name')
						.setDescription('Your full name')
						.setRequired(true)
				)
				.addStringOption(option =>
					option
						.setName('nrp')
						.setDescription('Your NRP (must be a number)')
						.setRequired(true)
				),
			{
				idHints: getIdHints(this.name)
			}
		);
	}

	async chatInputRun(interaction) {
		const name = interaction.options.getString('name');
		const nrp = interaction.options.getString('nrp');
		const userId = interaction.user.id;

		// Validate NRP is an integer
		if (!/^\d+$/.test(nrp)) {
			return interaction.reply({
				content: '❌ NRP must be a valid integer number.',
				ephemeral: true
			});
		}

		try {
			pactOperations.createPact(userId, name, nrp);

			const embed = new EmbedBuilder()
				.setColor(0x00FF00)
				.setTitle('✅ Pact Registered')
				.setDescription('Your information has been securely saved.')
				.addFields(
					{ name: '👤 Name', value: name, inline: true },
					{ name: '🔢 NRP', value: nrp, inline: true }
				)
				.setTimestamp()
				.setFooter({ text: `User ID: ${userId}` });

			return interaction.reply({ embeds: [embed], ephemeral: true });
		} catch (error) {
			this.container.logger.error('Error creating pact:', error);
			return interaction.reply({
				content: '❌ Failed to register pact. Please try again later.',
				ephemeral: true
			});
		}
	}
}

module.exports = { PactCommand };
