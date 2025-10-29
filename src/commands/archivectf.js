const { Command } = require('@sapphire/framework');
const { PermissionFlagsBits, EmbedBuilder, ChannelType } = require('discord.js');
const { getIdHints } = require('../utils');
const { ctfOperations } = require('../database');

class ArchiveCTFCommand extends Command {
	constructor(context, options) {
		super(context, {
			...options,
			name: 'archivectf',
			description: 'Archive a CTF channel and move it to /lost+found/YYYY category'
		});
	}

	registerApplicationCommands(registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription(this.description),
			{
				idHints: getIdHints(this.name)
			}
		);
	}

	async chatInputRun(interaction) {
		// Check for manage channels permission
		if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
			return interaction.reply({
				content: '❌ You need the "Manage Channels" permission to use this command.',
				ephemeral: true
			});
		}

		await interaction.deferReply();

		const channel = interaction.channel;

		try {
			// Get CTF from database
			const ctf = ctfOperations.getCTFByChannelId(channel.id);
			if (!ctf) {
				return interaction.editReply('❌ This channel is not registered as a CTF channel in the database.');
			}

			if (ctf.archived) {
				return interaction.editReply('❌ This CTF is already archived.');
			}

			// Get current year for the category name
			const year = new Date().getFullYear();
			const archiveCategoryName = `/lost+found/${year}`;

			// Find or create the archive category
			let archiveCategory = interaction.guild.channels.cache.find(
				c => c.type === ChannelType.GuildCategory && c.name === archiveCategoryName
			);

			if (!archiveCategory) {
				// Find all /lost+found/ categories to determine position
				const lostFoundCategories = interaction.guild.channels.cache
					.filter(c => c.type === ChannelType.GuildCategory && c.name.startsWith('/lost+found/'))
					.sort((a, b) => a.position - b.position);

				// Position: below the most recent /lost+found/ category, or at the bottom
				let position = undefined;
				if (lostFoundCategories.size > 0) {
					const lastLostFound = lostFoundCategories.last();
					position = lastLostFound.position + 1;
				}

				// Create new archive category
				archiveCategory = await interaction.guild.channels.create({
					name: archiveCategoryName,
					type: ChannelType.GuildCategory,
					position: position,
					permissionOverwrites: [
						{
							id: interaction.guild.id,
							allow: [PermissionFlagsBits.ViewChannel],
							deny: [PermissionFlagsBits.SendMessages]
						}
					]
				});

				this.container.logger.info(`Created archive category: ${archiveCategoryName} (ID: ${archiveCategory.id})`);
			}

			// Move channel to archive category
			await channel.setParent(archiveCategory.id, {
				reason: `CTF archived by ${interaction.user.tag}`
			});

			// Mark as archived in database
			ctfOperations.archiveCTF(channel.id);

			const embed = new EmbedBuilder()
				.setColor(0xFFA500)
				.setTitle('📦 CTF Archived')
				.setDescription(`**${ctf.ctf_name}** has been archived!`)
				.addFields(
					{ name: '📁 Moved to', value: archiveCategoryName, inline: true },
					{ name: '📅 Archived on', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false }
				)
				.setTimestamp();

			await interaction.editReply({ embeds: [embed] });

			this.container.logger.info(`Archived CTF "${ctf.ctf_name}" (ID: ${ctf.id}) by ${interaction.user.tag}`);

		} catch (error) {
			this.container.logger.error('Error archiving CTF:', error);
			return interaction.editReply('❌ Failed to archive CTF. Please check permissions and try again.');
		}
	}
}

module.exports = { ArchiveCTFCommand };
