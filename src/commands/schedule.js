const { Command } = require('@sapphire/framework');
const { PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { getIdHints } = require('../utils');

class ScheduleCommand extends Command {
	constructor(context, options) {
		super(context, {
			...options,
			name: 'schedule',
			description: 'Schedule a custom event'
		});
	}

	registerApplicationCommands(registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription(this.description)
				.addStringOption(option =>
					option
						.setName('event_title')
						.setDescription('The title of the event')
						.setRequired(true)
				)
				.addStringOption(option =>
					option
						.setName('event_description')
						.setDescription('Description of the event')
						.setRequired(true)
				)
				.addStringOption(option =>
					option
						.setName('event_date')
						.setDescription('Event date and time (YYYY-MM-DD HH:MM in your timezone)')
						.setRequired(true)
				)
				.addStringOption(option =>
					option
						.setName('timezone')
						.setDescription('Your timezone (e.g., Asia/Bangkok, America/New_York)')
						.setRequired(true)
				)
				.addAttachmentOption(option =>
					option
						.setName('event_banner')
						.setDescription('Banner image for the event')
						.setRequired(false)
				),
			{
				idHints: getIdHints(this.name)
			}
		);
	}

	async chatInputRun(interaction) {
		// Check for manage events permission
		if (!interaction.member.permissions.has(PermissionFlagsBits.ManageEvents)) {
			return interaction.reply({
				content: '❌ You need the "Manage Events" permission to use this command.',
				ephemeral: true
			});
		}

		await interaction.deferReply();

		const title = interaction.options.getString('event_title');
		const description = interaction.options.getString('event_description');
		const dateStr = interaction.options.getString('event_date');
		const timezone = interaction.options.getString('timezone');
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

			// Create scheduled event
			const scheduledEvent = await interaction.guild.scheduledEvents.create({
				name: title,
				description: description,
				scheduledStartTime: eventDate,
				scheduledEndTime: new Date(eventDate.getTime() + 3 * 60 * 60 * 1000), // Default 3 hours duration
				privacyLevel: 2, // GUILD_ONLY
				entityType: 3, // EXTERNAL
				entityMetadata: {
					location: 'Online'
				},
				image: banner ? banner.url : null
			});

			const embed = new EmbedBuilder()
				.setColor(0x00FF00)
				.setTitle('✅ Event Scheduled')
				.setDescription(`**${title}** has been scheduled!`)
				.addFields(
					{ name: '📅 Date & Time', value: `<t:${Math.floor(eventDate.getTime() / 1000)}:F>`, inline: false },
					{ name: '📝 Description', value: description, inline: false },
					{ name: '🔗 Event Link', value: `[View Event](${scheduledEvent.url})`, inline: false }
				)
				.setTimestamp();

			if (banner) {
				embed.setImage(banner.url);
			}

			return interaction.editReply({ embeds: [embed] });
		} catch (error) {
			this.container.logger.error('Error scheduling event:', error);
			return interaction.editReply('❌ Failed to schedule event. Please check the date format and try again.');
		}
	}
}

module.exports = { ScheduleCommand };
