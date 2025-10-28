const { Command } = require('@sapphire/framework');
const { PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { getIdHints, parseLocalDateToUTC } = require('../utils');

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
						.setDescription('Event date and time (DD-MM-YYYY HH:MM in your timezone)')
						.setRequired(true)
				)
				.addStringOption(option =>
					option
						.setName('timezone')
						.setDescription('Your timezone (e.g., Asia/Jakarta, Europe/London)')
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
			// Parse date and convert to UTC
			let eventDate;
			try {
				eventDate = parseLocalDateToUTC(dateStr, timezone);
			} catch (error) {
				return interaction.editReply(`❌ ${error.message}`);
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
