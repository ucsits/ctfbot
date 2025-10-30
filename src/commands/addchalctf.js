const { Command } = require('@sapphire/framework');
const { EmbedBuilder } = require('discord.js');
const { getIdHints } = require('../utils');
const { ctfOperations, challengeOperations } = require('../database');

class AddChalCTFCommand extends Command {
	constructor(context, options) {
		super(context, {
			...options,
			name: 'addchalctf',
			description: 'Add a challenge to the CTF in this channel'
		});
	}

	registerApplicationCommands(registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription(this.description)
				.addStringOption(option =>
					option
						.setName('chal_name')
						.setDescription('Name of the challenge')
						.setRequired(true)
				)
				.addStringOption(option =>
					option
						.setName('chal_category')
						.setDescription('Category of the challenge (e.g., Web, Crypto, Pwn, Forensics)')
						.setRequired(true)
				),
			{
				idHints: getIdHints(this.name)
			}
		);
	}

	async chatInputRun(interaction) {
		// Check if command is used in a CTF channel (inside the CTF category)
		const channel = interaction.channel;
		const categoryId = process.env.CTF_CATEGORY_ID;
		
		if (!categoryId) {
			return interaction.reply({
				content: '❌ CTF category is not configured. Please set CTF_CATEGORY_ID in environment variables.',
				ephemeral: true
			});
		}

		if (channel.parentId !== categoryId) {
			return interaction.reply({
				content: '❌ This command can only be used in CTF channels (channels within the CTF category).',
				ephemeral: true
			});
		}

		await interaction.deferReply();

		const chalName = interaction.options.getString('chal_name');
		const chalCategory = interaction.options.getString('chal_category');
		const userId = interaction.user.id;
		const userTag = interaction.user.tag;

		try {
			// Get CTF from database
			const ctf = ctfOperations.getCTFByChannelId(channel.id);
			if (!ctf) {
				return interaction.editReply('❌ This channel is not registered as a CTF channel in the database.');
			}

			// Add challenge to database
			try {
				const chalId = challengeOperations.addChallenge({
					ctf_id: ctf.id,
					chal_name: chalName,
					chal_category: chalCategory,
					created_by: userId
				});
				this.container.logger.info(`Added challenge "${chalName}" (${chalCategory}) to CTF "${ctf.ctf_name}" by ${userTag}`);

				const embed = new EmbedBuilder()
					.setColor(0x00FF00)
					.setTitle('✅ Challenge Added')
					.setDescription(`Challenge **${chalName}** has been added to **${ctf.ctf_name}**!`)
					.addFields(
						{ name: '📝 Challenge Name', value: chalName, inline: true },
						{ name: '📁 Category', value: chalCategory, inline: true },
						{ name: '👤 Added by', value: `${interaction.user}`, inline: true }
					)
					.setTimestamp()
					.setFooter({ text: `Challenge ID: ${chalId}` });

				await interaction.editReply({ embeds: [embed] });

				// Announce in channel
				const announceEmbed = new EmbedBuilder()
					.setColor(0x0099FF)
					.setDescription(`🎯 New challenge added: **${chalName}** (${chalCategory})`)
					.setTimestamp();

				await channel.send({ embeds: [announceEmbed] });

			} catch (dbError) {
				if (dbError.message.includes('UNIQUE constraint failed')) {
					return interaction.editReply(`❌ Challenge **${chalName}** already exists in this CTF.`);
				}
				this.container.logger.error('Failed to add challenge:', dbError);
				return interaction.editReply('❌ Failed to add challenge. Please try again later.');
			}

		} catch (error) {
			this.container.logger.error('Error adding challenge:', error);
			return interaction.editReply('❌ Failed to add challenge. Please try again later.');
		}
	}
}

module.exports = { AddChalCTFCommand };
