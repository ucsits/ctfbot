const { Command } = require('@sapphire/framework');
const { PermissionFlagsBits, EmbedBuilder, ChannelType } = require('discord.js');
const { getIdHints, parseLocalDateToUTC } = require('../lib/utils');
const { ctfOperations } = require('../database');
const config = require('../config');
const { checkPermissionReply } = require('../lib/middleware/ensurePermission');

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
		const cancelled = await checkPermissionReply(interaction, PermissionFlagsBits.ManageChannels, 'Manage Channels');
		if (cancelled) return;

		await interaction.deferReply();

		const options = this.parseOptions(interaction);

		try {
			const dates = this.parseDates(options);
			this.validateDates(dates);

			const category = this.getCategory(interaction);
			const channelName = this.formatChannelName(options.ctfName);
			const ctfChannel = await this.createChannel(interaction, channelName, category, options);
			const scheduledEvent = await this.createEvent(interaction, options, dates);
			await this.sendWelcomeMessage(ctfChannel, options, dates, scheduledEvent);
			await this.saveToDatabase(interaction, ctfChannel, scheduledEvent, options, dates);

			return this.sendConfirmation(interaction, ctfChannel, scheduledEvent, options);

		} catch (error) {
			this.container.logger.error('Error creating CTF:', error);
			return interaction.editReply('❌ Failed to create CTF. Please check permissions and try again.');
		}
	}

	parseOptions(interaction) {
		return {
			ctfName: interaction.options.getString('ctf_name'),
			dateStr: interaction.options.getString('ctf_date'),
			endDateStr: interaction.options.getString('ctf_end_date'),
			ctfBaseUrl: interaction.options.getString('ctf_base_url'),
			timezone: interaction.options.getString('timezone'),
			apiToken: interaction.options.getString('api_token'),
			teamMode: interaction.options.getBoolean('team_mode') || false,
			description: interaction.options.getString('event_description') || `Join us for ${interaction.options.getString('ctf_name')}!`,
			banner: interaction.options.getAttachment('event_banner')
		};
	}

	parseDates(options) {
		let eventDate;
		try {
			eventDate = parseLocalDateToUTC(options.dateStr, options.timezone);
		} catch (error) {
			throw new Error(`❌ ${error.message}`);
		}

		let eventEndDate;
		if (options.endDateStr) {
			try {
				eventEndDate = parseLocalDateToUTC(options.endDateStr, options.timezone);
			} catch (error) {
				throw new Error(`❌ Invalid end date: ${error.message}`);
			}
		} else {
			eventEndDate = new Date(eventDate.getTime() + 24 * 60 * 60 * 1000);
		}

		return { eventDate, eventEndDate };
	}

	validateDates(dates) {
		if (dates.eventDate < new Date()) {
			throw new Error('❌ Event start date must be in the future.');
		}
		if (dates.eventEndDate <= dates.eventDate) {
			throw new Error('❌ Event end date must be after the start date.');
		}
	}

	getCategory(interaction) {
		const category = interaction.guild.channels.cache.get(config.ctf.categoryId);
		if (!category) {
			throw new Error('❌ CTF category not found. Please set CTF_CATEGORY_ID in your environment variables.');
		}
		return category;
	}

	formatChannelName(ctfName) {
		return ctfName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
	}

	async createChannel(interaction, channelName, category, options) {
		return interaction.guild.channels.create({
			name: channelName,
			type: ChannelType.GuildText,
			parent: category.id,
			topic: `${options.ctfName} - ${options.description}`,
			permissionOverwrites: [
				{
					id: interaction.guild.id,
					allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
				}
			]
		});
	}

	async createEvent(interaction, options, dates) {
		return interaction.guild.scheduledEvents.create({
			name: options.ctfName,
			description: options.description,
			scheduledStartTime: dates.eventDate,
			scheduledEndTime: dates.eventEndDate,
			privacyLevel: 2,
			entityType: 3,
			entityMetadata: { location: 'Online' },
			image: options.banner?.url
		});
	}

	async sendWelcomeMessage(channel, options, dates, scheduledEvent) {
		const embed = new EmbedBuilder()
			.setColor(0x0099FF)
			.setTitle(`🚩 ${options.ctfName}`)
			.setDescription(options.description)
			.addFields(
				{ name: '⏰ Start Time', value: `<t:${Math.floor(dates.eventDate.getTime() / 1000)}:F>`, inline: true },
				{ name: '⏱️ End Time', value: `<t:${Math.floor(dates.eventEndDate.getTime() / 1000)}:F>`, inline: true },
				{ name: '🌐 CTF URL', value: options.ctfBaseUrl, inline: false },
				{ name: '🔗 Event', value: `[View Event](${scheduledEvent.url})`, inline: false },
				{ name: '📝 Register', value: 'Use `/registerctf <username>` to register your participation!', inline: false }
			)
			.setTimestamp();

		if (options.banner) {
			embed.setImage(options.banner.url);
		}

		return channel.send({ embeds: [embed] });
	}

	async saveToDatabase(interaction, channel, event, options, dates) {
		try {
			const ctfId = ctfOperations.createCTF({
				guild_id: interaction.guild.id,
				channel_id: channel.id,
				event_id: event.id,
				ctf_name: options.ctfName,
				ctf_base_url: options.ctfBaseUrl,
				ctf_date: dates.eventDate.toISOString(),
				description: options.description,
				banner_url: options.banner?.url,
				api_token: options.apiToken,
				team_mode: options.teamMode ? 1 : 0,
				created_by: interaction.user.id
			});
			this.container.logger.info(`Stored CTF "${options.ctfName}" in database (ID: ${ctfId})`);
		} catch (dbError) {
			this.container.logger.error('Failed to store CTF in database:', dbError);
			await channel.send({
				content: '⚠️ **Warning**: CTF was created but failed to register in the database. Error: ' + dbError.message
			});
		}
	}

	sendConfirmation(interaction, channel, event, options) {
		const embed = new EmbedBuilder()
			.setColor(0x00FF00)
			.setTitle('✅ CTF Created Successfully')
			.setDescription(`**${options.ctfName}** has been set up!`)
			.addFields(
				{ name: '📢 Channel', value: `${channel}`, inline: true },
				{ name: '📅 Start Time', value: `<t:${Math.floor(event.scheduledStartTime.getTime() / 1000)}:F>`, inline: false },
				{ name: '🔗 Event Link', value: `[View Event](${event.url})`, inline: false }
			)
			.setTimestamp();

		return interaction.editReply({ embeds: [embed] });
	}
}

module.exports = { CreateCTFCommand };
