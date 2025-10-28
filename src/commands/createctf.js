const { Command } = require('@sapphire/framework');
const { PermissionFlagsBits, EmbedBuilder, ChannelType } = require('discord.js');
const { getIdHints } = require('../utils');

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
						.setDescription('CTF start date and time (YYYY-MM-DD HH:MM in your timezone)')
						.setRequired(true)
				)
				.addStringOption(option =>
					option
						.setName('timezone')
						.setDescription('Your timezone (e.g., Asia/Bangkok, America/New_York)')
						.setRequired(true)
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
		const timezone = interaction.options.getString('timezone');
		const description = interaction.options.getString('event_description') || `Join us for ${ctfName}!`;
		const banner = interaction.options.getAttachment('event_banner');

		try {
			// Parse date
			const dateMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
			if (!dateMatch) {
				return interaction.editReply('❌ Invalid date format. Please use: YYYY-MM-DD HH:MM (e.g., 2025-12-31 20:00)');
			}

			const [, year, month, day, hour, minute] = dateMatch;
			
			// Create date string with timezone
			const dateString = `${year}-${month}-${day}T${hour}:${minute}:00`;
			
			// Parse date in specified timezone
			let eventDate;
			try {
				// Use Intl API to parse date in specified timezone
				const formatter = new Intl.DateTimeFormat('en-US', {
					timeZone: timezone,
					year: 'numeric',
					month: '2-digit',
					day: '2-digit',
					hour: '2-digit',
					minute: '2-digit',
					second: '2-digit',
					hour12: false
				});
				
				// Create a date object and convert to UTC
				eventDate = new Date(`${dateString} ${timezone}`);
				
				// If the date is invalid, try parsing differently
				if (isNaN(eventDate.getTime())) {
					// Manual calculation using timezone offset
					const baseDate = new Date(`${year}-${month}-${day}T${hour}:${minute}:00Z`);
					const targetDate = new Date(baseDate.toLocaleString('en-US', { timeZone: timezone }));
					const offset = baseDate.getTime() - targetDate.getTime();
					eventDate = new Date(baseDate.getTime() - offset);
				}
			} catch (error) {
				return interaction.editReply('❌ Invalid timezone. Please use a valid timezone (e.g., Asia/Bangkok, America/New_York, Europe/London)');
			}

			if (eventDate < new Date()) {
				return interaction.editReply('❌ Event date must be in the future.');
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
				scheduledEndTime: new Date(eventDate.getTime() + 24 * 60 * 60 * 1000), // Default 24 hours duration
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
					{ name: '📅 Start Time', value: `<t:${Math.floor(eventDate.getTime() / 1000)}:F>`, inline: false },
					{ name: '🔗 Event', value: `[View Event](${scheduledEvent.url})`, inline: false },
					{ name: '📝 Register', value: 'Use `/registerctf <username>` to register your participation!', inline: false }
				)
				.setTimestamp();

			if (banner) {
				welcomeEmbed.setImage(banner.url);
			}

			await ctfChannel.send({ embeds: [welcomeEmbed] });

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
