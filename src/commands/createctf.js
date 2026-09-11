const { Command } = require('@sapphire/framework');
const { PermissionFlagsBits, EmbedBuilder, ChannelType } = require('discord.js');
const { getIdHints, parseLocalDateToUTC, formatDateInterpretation } = require('../lib/utils');
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
						.setDescription('CTF start date: DD-MM-YYYY HH:MM or Unix timestamp (@time compatible)')
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
						.setDescription('Your timezone (default: Asia/Jakarta)')
						.setRequired(false)
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
						.setDescription('CTF end date: DD-MM-YYYY HH:MM or Unix timestamp (@time compatible, defaults +24h)')
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
				)
				.addChannelOption(option =>
					option
						.setName('voice_channel')
						.setDescription('Voice or Stage channel for the event (optional, creates external event if omitted)')
						.setRequired(false)
						.addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
				),
		{
			idHints: getIdHints(this.name)
		}
		);
	}

	async chatInputRun(interaction) {
		const cancelled = await checkPermissionReply(interaction, PermissionFlagsBits.ManageChannels, 'Manage Channels');
		if (cancelled) {
			return;
		}

		await interaction.deferReply();

		const options = this.parseOptions(interaction);

		// Track what has been created so a later failure can be compensated rather
		// than leaving an orphan channel, orphan event, or both behind.
		let ctfChannel = null;
		let scheduledEvent = null;
		let ctfId = null;

		try {
			const dates = this.parseDates(options);
			this.validateDates(dates);

			const category = this.getCategory(interaction);
			const channelName = this.formatChannelName(options.ctfName);

			ctfChannel = await this.createChannel(interaction, channelName, category, options);
			scheduledEvent = await this.createEvent(interaction, options, dates);

			await this.sendWelcomeMessage(ctfChannel, options, dates, scheduledEvent);

			// The success reply must be unreachable until the CTF is persisted.
			// saveToDatabase rethrows on failure, so a database error lands in the
			// catch below and triggers the rollback.
			ctfId = await this.saveToDatabase(interaction, ctfChannel, scheduledEvent, options, dates);

			return this.sendConfirmation(interaction, ctfChannel, scheduledEvent, options);

		} catch (error) {
			this.container.logger.error('Error creating CTF:', error);
			await this._compensateCreate(interaction, ctfChannel, scheduledEvent, ctfId);
			return interaction.editReply(
				'Failed to create CTF. The partial setup was rolled back. Please check permissions and try again.'
			);
		}
	}

	/**
	 * Undo whatever /createctf managed to create before it failed.
	 *
	 * Without this the command could fail and still leave a channel, a scheduled
	 * event, and a welcome message in place with no CTF row behind them, while the
	 * admin had no way to clean up from Discord. Each step is guarded so a missing
	 * object or a Discord error cannot mask the original failure.
	 *
	 * The database row is removed first. saveToDatabase runs before
	 * sendConfirmation, so a failure in the confirmation step would otherwise
	 * leave a permanent ctfs row pointing at a channel and event that were just
	 * deleted. Deleting the row before the Discord objects keeps the database from
	 * outliving the objects it references.
	 *
	 * @param {import('discord.js').ChatInputCommandInteraction} interaction
	 * @param {object|null} ctfChannel
	 * @param {object|null} scheduledEvent
	 * @param {number|bigint|null} [ctfId] Row id returned by saveToDatabase
	 */
	async _compensateCreate(interaction, ctfChannel, scheduledEvent, ctfId = null) {
		if (ctfId !== null && ctfId !== undefined) {
			try {
				ctfOperations.deleteCTF(ctfId);
				this.container.logger.info(`Rolled back CTF row ${ctfId}`);
			} catch (error) {
				this.container.logger.warn(`Could not roll back CTF row ${ctfId}: ${error.message}`);
			}
		}

		if (scheduledEvent) {
			try {
				await interaction.guild.scheduledEvents.delete(scheduledEvent.id);
				this.container.logger.info(`Rolled back scheduled event ${scheduledEvent.id}`);
			} catch (error) {
				this.container.logger.warn(
					`Could not roll back scheduled event ${scheduledEvent.id}: ${error.message}`
				);
			}
		}

		if (ctfChannel) {
			try {
				await ctfChannel.delete('CTF creation failed; rolling back');
				this.container.logger.info(`Rolled back channel ${ctfChannel.id}`);
			} catch (error) {
				this.container.logger.warn(`Could not roll back channel ${ctfChannel.id}: ${error.message}`);
			}
		}
	}

	parseOptions(interaction) {
		return {
			ctfName: interaction.options.getString('ctf_name'),
			dateStr: interaction.options.getString('ctf_date'),
			endDateStr: interaction.options.getString('ctf_end_date'),
			ctfBaseUrl: interaction.options.getString('ctf_base_url'),
			timezone: interaction.options.getString('timezone') || 'Asia/Jakarta',
			apiToken: interaction.options.getString('api_token'),
			teamMode: interaction.options.getBoolean('team_mode') || false,
			description: interaction.options.getString('event_description') || `Join us for ${interaction.options.getString('ctf_name')}!`,
			banner: interaction.options.getAttachment('event_banner'),
			voiceChannel: interaction.options.getChannel('voice_channel')
		};
	}

	parseDates(options) {
		let eventDate;
		try {
			eventDate = parseLocalDateToUTC(options.dateStr, options.timezone);
		} catch (error) {
			throw new Error(`${error.message}`);
		}

		let eventEndDate;
		if (options.endDateStr) {
			try {
				eventEndDate = parseLocalDateToUTC(options.endDateStr, options.timezone);
			} catch (error) {
				throw new Error(`Invalid end date: ${error.message}`);
			}
		} else {
			eventEndDate = new Date(eventDate.getTime() + 24 * 60 * 60 * 1000);
		}

		return { eventDate, eventEndDate };
	}

	validateDates(dates) {
		if (dates.eventDate < new Date()) {
			throw new Error('Event start date must be in the future.');
		}
		if (dates.eventEndDate <= dates.eventDate) {
			throw new Error('Event end date must be after the start date.');
		}
	}

	getCategory(interaction) {
		const category = interaction.guild.channels.cache.get(config.ctf.categoryId);
		if (!category) {
			throw new Error('CTF category not found. Please set CTF_CATEGORY_ID in your environment variables.');
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
		const isVoiceEvent = options.voiceChannel !== null;

		if (isVoiceEvent) {
			return interaction.guild.scheduledEvents.create({
				name: options.ctfName,
				description: options.description,
				scheduledStartTime: dates.eventDate,
				scheduledEndTime: dates.eventEndDate,
				privacyLevel: 2,
				entityType: options.voiceChannel.type === ChannelType.GuildStageVoice ? 1 : 2,
				channel: options.voiceChannel.id,
				image: options.banner?.url
			});
		}

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
		const interpretation = formatDateInterpretation(options.dateStr, options.timezone, dates.eventDate);
		const embed = new EmbedBuilder()
			.setColor(0x0099FF)
			.setTitle(`${options.ctfName}`)
			.setDescription(`${options.description}\n\n${interpretation}`)
			.addFields(
				{ name: 'Start Time', value: `<t:${Math.floor(dates.eventDate.getTime() / 1000)}:F>`, inline: true },
				{ name: 'End Time', value: `<t:${Math.floor(dates.eventEndDate.getTime() / 1000)}:F>`, inline: true },
				{ name: 'CTF URL', value: options.ctfBaseUrl, inline: false },
				{ name: 'Event', value: `[View Event](${scheduledEvent.url})`, inline: false }
			)
			.setTimestamp();

		if (options.voiceChannel) {
			embed.addFields({ name: '🔊 Channel', value: options.voiceChannel.toString(), inline: true });
		}

		embed.addFields({ name: 'Register', value: 'Use `/registerctf <username>` to register your participation!', inline: false });

		if (options.banner) {
			embed.setImage(options.banner.url);
		}

		return channel.send({ embeds: [embed] });
	}

	async saveToDatabase(interaction, channel, event, options, dates) {
		// Deliberately NOT wrapped in try/catch: a failure here must abort the
		// command so the catch in chatInputRun can roll the Discord objects back.
		// Swallowing it used to let the command report "CTF Created Successfully"
		// with no database row behind it.
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
		return ctfId;
	}

	sendConfirmation(interaction, channel, event, options) {
		const interpretation = formatDateInterpretation(options.dateStr, options.timezone, event.scheduledStartAt);
		const embed = new EmbedBuilder()
			.setColor(0x00FF00)
			.setTitle('CTF Created Successfully')
			.setDescription(`**${options.ctfName}** has been set up!\n\n${interpretation}`)
			.addFields(
				{ name: 'Channel', value: `${channel}`, inline: true },
				{ name: 'Start Time', value: `<t:${Math.floor(event.scheduledStartAt.getTime() / 1000)}:F>`, inline: false }
			)
			.setTimestamp();

		if (options.voiceChannel) {
			embed.addFields({ name: '🔊 Voice Channel', value: options.voiceChannel.toString(), inline: true });
		}

		embed.addFields({ name: 'Event Link', value: `[View Event](${event.url})`, inline: false });

		return interaction.editReply({ embeds: [embed] });
	}
}

module.exports = { CreateCTFCommand };
