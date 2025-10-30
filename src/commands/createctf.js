const { Command } = require('@sapphire/framework');
const { PermissionFlagsBits, EmbedBuilder, ChannelType } = require('discord.js');
const { getIdHints, parseLocalDateToUTC } = require('../utils');
const { ctfOperations } = require('../database');

class CreateCTFCommand extends Command {
	constructor(context, options) {
		super(context, {
			...options,
			name: 'createctf',
			description: 'Create a CTF text channel and schedule its event'
		});
	}

	registerApplicationCommands(registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription(this.description)
				.addStringOption(option =>
					option
						.setName('ctf_name')
						.setDescription('Name of the CTF competition')
						.setRequired(true)
				)
				.addStringOption(option =>
					option
						.setName('ctf_date')
						.setDescription('CTF start date and time (DD-MM-YYYY HH:MM in your timezone)')
						.setRequired(true)
				)
				.addStringOption(option =>
					option
						.setName('ctf_base_url')
						.setDescription('Base URL of the CTF (e.g., https://ctf.example.com)')
						.setRequired(true)
				)
				.addStringOption(option =>
					option
						.setName('timezone')
						.setDescription('Your timezone (e.g., Asia/Jakarta, Europe/London)')
						.setRequired(true)
				)
				.addStringOption(option =>
					option
						.setName('api_token')
						.setDescription('CTFd API token for automatic registration integration (optional)')
						.setRequired(false)
				)
				.addStringOption(option =>
					option
						.setName('ctf_end_date')
						.setDescription('CTF end date and time (DD-MM-YYYY HH:MM in your timezone, defaults to +24h)')
						.setRequired(false)
				)
				.addStringOption(option =>
					option
						.setName('event_description')
						.setDescription('Description of the CTF event')
						.setRequired(false)
				)
				.addAttachmentOption(option =>
					option
						.setName('event_banner')
						.setDescription('Banner image for the CTF event')
						.setRequired(false)
				)
				.addBooleanOption(option =>
					option
						.setName('team_mode')
						.setDescription('Is this a team-based CTF? (default: false)')
						.setRequired(false)
				),
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

		const ctfName = interaction.options.getString('ctf_name');
		const dateStr = interaction.options.getString('ctf_date');
		const endDateStr = interaction.options.getString('ctf_end_date');
		const ctfBaseUrl = interaction.options.getString('ctf_base_url');
		const timezone = interaction.options.getString('timezone');
		const apiToken = interaction.options.getString('api_token');
		const teamMode = interaction.options.getBoolean('team_mode') || false;
		const description = interaction.options.getString('event_description') || `Join us for ${ctfName}!`;
		const banner = interaction.options.getAttachment('event_banner');

		try {
			// Parse start date and convert to UTC
			let eventDate;
			try {
				eventDate = parseLocalDateToUTC(dateStr, timezone);
			} catch (error) {
				return interaction.editReply(`❌ ${error.message}`);
			}

			if (eventDate < new Date()) {
				return interaction.editReply('❌ Event start date must be in the future.');
			}

			// Parse end date if provided, otherwise default to +24 hours
			let eventEndDate;
			if (endDateStr) {
				try {
					eventEndDate = parseLocalDateToUTC(endDateStr, timezone);
				} catch (error) {
					return interaction.editReply(`❌ Invalid end date: ${error.message}`);
				}

				if (eventEndDate <= eventDate) {
					return interaction.editReply('❌ Event end date must be after the start date.');
				}
			} else {
				// Default to 24 hours after start
				eventEndDate = new Date(eventDate.getTime() + 24 * 60 * 60 * 1000);
			}

			// Get or create CTF category
			const categoryId = process.env.CTF_CATEGORY_ID;
			let category = null;

			if (categoryId) {
				category = interaction.guild.channels.cache.get(categoryId);
			}

			if (!category) {
				// Panic if category not found
				return interaction.editReply('❌ CTF category not found. Please set CTF_CATEGORY_ID in your environment variables.');
			}

			// Create channel name (lowercase, replace spaces with hyphens)
			const channelName = ctfName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

			// Create CTF text channel
			const ctfChannel = await interaction.guild.channels.create({
				name: `${channelName}`,
				type: ChannelType.GuildText,
				parent: category.id,
				topic: `${ctfName} - ${description}`,
				permissionOverwrites: [
					{
						id: interaction.guild.id,
						allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
					}
				]
			});

			// Create scheduled event
			const scheduledEvent = await interaction.guild.scheduledEvents.create({
				name: ctfName,
				description: description,
				scheduledStartTime: eventDate,
				scheduledEndTime: eventEndDate,
				privacyLevel: 2, // GUILD_ONLY
				entityType: 3, // EXTERNAL
				entityMetadata: {
					location: 'Online'
				},
				image: banner ? banner.url : null
			});

			// Send welcome message to the new channel
			const welcomeEmbed = new EmbedBuilder()
				.setColor(0x0099FF)
				.setTitle(`🚩 ${ctfName}`)
				.setDescription(description)
				.addFields(
					{ name: '⏰ Start Time', value: `<t:${Math.floor(eventDate.getTime() / 1000)}:F>`, inline: true },
					{ name: '⏱️ End Time', value: `<t:${Math.floor(eventEndDate.getTime() / 1000)}:F>`, inline: true },
					{ name: '🌐 CTF URL', value: ctfBaseUrl, inline: false },
					{ name: '🔗 Event', value: `[View Event](${scheduledEvent.url})`, inline: false },
					{ name: '📝 Register', value: 'Use `/registerctf <username>` to register your participation!', inline: false }
				)
				.setTimestamp();

			if (banner) {
				welcomeEmbed.setImage(banner.url);
			}

			await ctfChannel.send({ embeds: [welcomeEmbed] });

			// Store CTF details in database
			try {
				const ctfId = ctfOperations.createCTF({
					guild_id: interaction.guild.id,
					channel_id: ctfChannel.id,
					event_id: scheduledEvent.id,
					ctf_name: ctfName,
					ctf_base_url: ctfBaseUrl,
					ctf_date: eventDate.toISOString(),
					description: description,
					banner_url: banner ? banner.url : null,
					api_token: apiToken,
					team_mode: teamMode ? 1 : 0,
					created_by: interaction.user.id
				});
				this.container.logger.info(`Stored CTF "${ctfName}" in database (ID: ${ctfId}, channel: ${ctfChannel.id}, team_mode: ${teamMode})`);
			} catch (dbError) {
				this.container.logger.error('Failed to store CTF in database:', dbError);
				// Send warning message to the channel
				await ctfChannel.send({
					content: '⚠️ **Warning**: CTF was created but failed to register in the database. The `/registerctf` command may not work in this channel.\n\nError: ' + dbError.message
				});
			}

			// Reply to the command
			const embed = new EmbedBuilder()
				.setColor(0x00FF00)
				.setTitle('✅ CTF Created Successfully')
				.setDescription(`**${ctfName}** has been set up!`)
				.addFields(
					{ name: '📢 Channel', value: `${ctfChannel}`, inline: true },
					{ name: '📅 Start Time', value: `<t:${Math.floor(eventDate.getTime() / 1000)}:F>`, inline: false },
					{ name: '🔗 Event Link', value: `[View Event](${scheduledEvent.url})`, inline: false }
				)
				.setTimestamp();

			return interaction.editReply({ embeds: [embed] });
		} catch (error) {
			this.container.logger.error('Error creating CTF:', error);
			return interaction.editReply('❌ Failed to create CTF. Please check permissions and try again.');
		}
	}
}

module.exports = { CreateCTFCommand };
