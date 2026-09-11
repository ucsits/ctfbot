const { Command } = require('@sapphire/framework');
const { PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { getIdHints } = require('../lib/utils');
const { ctfOperations } = require('../database');
const { createPlatformClient, isKnownPlatform, PLATFORM_CHOICES, DEFAULT_PLATFORM, getPlatform } = require('../lib/platform');
const { validateURL } = require('../lib/validators');
const { checkPermissionReply } = require('../lib/middleware/ensurePermission');
const { ensureCTFChannelReply } = require('../lib/middleware/ensureCTFChannel');

/**
 * Bind a CTF channel to a platform.
 *
 * The platform is stored per channel rather than globally so two CTFs running at
 * the same time can use different platforms. Everything downstream
 * (/registerctf, /syncchallenges, /summarizectf) reads the stored value.
 */
class SetCTFPlatformCommand extends Command {
	constructor(context, options) {
		super(context, {
			...options,
			name: 'setctfplatform',
			description: 'Set or view the CTF platform this channel syncs from'
		});
	}

	registerApplicationCommands(registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription(this.description)
				.addStringOption(option =>
					option
						.setName('platform')
						.setDescription('Platform to use for this CTF channel')
						.setRequired(false)
						.addChoices(...PLATFORM_CHOICES)
				)
				.addStringOption(option =>
					option
						.setName('api_base_url')
						.setDescription('API base URL (e.g. https://api-k17ctf.secso.cc). Defaults to the CTF URL.')
						.setRequired(false)
				)
				.addStringOption(option =>
					option
						.setName('api_token')
						.setDescription('Platform API token or bearer token (optional)')
						.setRequired(false)
				)
				.addIntegerOption(option =>
					option
						.setName('division_id')
						.setDescription('Platform division / scoreboard id (optional)')
						.setRequired(false)
				)
				.addBooleanOption(option =>
					option
						.setName('show')
						.setDescription('Show the current platform configuration instead of changing it')
						.setRequired(false)
				),
		{
			idHints: getIdHints(this.name)
		}
		);
	}

	async chatInputRun(interaction) {
		// Both guards reply directly, so they must run before the deferral.
		const cancelled = await checkPermissionReply(interaction, PermissionFlagsBits.ManageChannels, 'Manage Channels');
		if (cancelled) {
			return;
		}

		const notInCtfChannel = await ensureCTFChannelReply(interaction);
		if (notInCtfChannel) {
			return;
		}

		await interaction.deferReply();

		const ctf = ctfOperations.getCTFByChannelId(interaction.channelId);
		if (!ctf) {
			return interaction.editReply('This channel is not registered as a CTF channel in the database.');
		}

		try {
			if (interaction.options.getBoolean('show')) {
				return await this.showCurrentPlatform(interaction, ctf);
			}
			return await this.updatePlatform(interaction, ctf);
		} catch (error) {
			this.container.logger.error('Error in setctfplatform command:', error);
			return interaction.editReply('Failed to update the CTF platform configuration. Please try again later.');
		}
	}

	/**
	 * The platform id to actually use, tolerating a NULL or unrecognised column
	 * value so a hand-edited database cannot crash the command.
	 *
	 * @private
	 * @param {Object} ctf
	 * @returns {string}
	 */
	_resolvePlatformId(ctf) {
		return isKnownPlatform(ctf.platform) ? ctf.platform : DEFAULT_PLATFORM;
	}

	/**
	 * Report the stored configuration and probe the platform live.
	 *
	 * @private
	 */
	async showCurrentPlatform(interaction, ctf) {
		const platformId = this._resolvePlatformId(ctf);
		const apiBaseUrl = ctf.api_base_url || ctf.ctf_base_url;
		const client = createPlatformClient(platformId, apiBaseUrl, ctf.api_token, {
			divisionId: ctf.platform_division_id
		});
		const connection = await client.testConnection();

		const embed = new EmbedBuilder()
			.setColor(connection.ok ? 0x0099FF : 0xFFA500)
			.setTitle(`CTF Platform for ${ctf.ctf_name}`)
			.addFields(
				{ name: 'Platform', value: getPlatform(platformId).label, inline: true },
				{ name: 'API Base URL', value: apiBaseUrl || 'Not set', inline: false },
				{ name: 'Token', value: ctf.api_token ? 'Set' : 'Not set', inline: true },
				{ name: 'Division', value: ctf.platform_division_id ? String(ctf.platform_division_id) : 'Auto', inline: true },
				{ name: 'Connection', value: this._describeConnection(connection), inline: false }
			)
			.setTimestamp();

		if (platformId === 'noctf' && !ctf.api_token) {
			embed.addFields({ name: 'Warning', value: this._noTokenWarning(), inline: false });
		}

		return interaction.editReply({ embeds: [embed] });
	}

	/**
	 * Validate the requested configuration, probe it, then persist it.
	 *
	 * @private
	 */
	async updatePlatform(interaction, ctf) {
		const platform = interaction.options.getString('platform');
		if (!platform) {
			return interaction.editReply(
				'Provide a `platform` to set, or pass `show: true` to view the current configuration.'
			);
		}

		const apiBaseUrlInput = interaction.options.getString('api_base_url');
		if (apiBaseUrlInput) {
			try {
				validateURL(apiBaseUrlInput);
			} catch (error) {
				return interaction.editReply(error.message);
			}
		}

		const apiTokenInput = interaction.options.getString('api_token');
		const divisionInput = interaction.options.getInteger('division_id');

		const previousPlatformId = this._resolvePlatformId(ctf);
		const apiBaseUrl = apiBaseUrlInput || ctf.api_base_url || ctf.ctf_base_url;
		const apiToken = apiTokenInput === null || apiTokenInput === undefined ? ctf.api_token : apiTokenInput;
		const divisionId = divisionInput === null || divisionInput === undefined ? ctf.platform_division_id : divisionInput;

		const client = createPlatformClient(platform, apiBaseUrl, apiToken, { divisionId });
		const connection = await client.testConnection();

		ctfOperations.setCTFPlatform(interaction.channelId, {
			platform,
			apiBaseUrl,
			apiToken,
			divisionId
		});

		this.container.logger.info(
			`CTF platform for channel ${interaction.channelId} set to ${platform} by ${interaction.user.tag}`
		);

		const embed = new EmbedBuilder()
			.setColor(connection.ok ? 0x00FF00 : 0xFFA500)
			.setTitle('CTF Platform Updated')
			.setDescription(`**${ctf.ctf_name}** now syncs from **${getPlatform(platform).label}**.`)
			.addFields(
				{ name: 'Previous Platform', value: getPlatform(previousPlatformId).label, inline: true },
				{ name: 'Platform', value: getPlatform(platform).label, inline: true },
				{ name: 'API Base URL', value: apiBaseUrl || 'Not set', inline: false },
				{ name: 'Token', value: apiToken ? 'Set' : 'Not set', inline: true },
				{ name: 'Division', value: divisionId ? String(divisionId) : 'Auto', inline: true },
				{ name: 'Connection', value: this._describeConnection(connection), inline: false }
			)
			.setTimestamp();

		if (platform === 'noctf' && !apiToken) {
			embed.addFields({ name: 'Warning', value: this._noTokenWarning(), inline: false });
		}

		return interaction.editReply({ embeds: [embed] });
	}

	/**
	 * Render a connection probe result without ever echoing the credential.
	 *
	 * @private
	 * @param {{ok: boolean, details: Object}} connection
	 * @returns {string}
	 */
	_describeConnection(connection) {
		if (!connection.ok) {
			return '❌ Could not reach the platform API. Check the API base URL and try again.';
		}

		const details = connection.details || {};
		const parts = ['✅ Connected'];

		if (details.active !== null && details.active !== undefined) {
			parts.push(details.active ? 'CTF is active' : 'CTF is not active yet');
		}
		if (details.startTime) {
			parts.push(`starts <t:${details.startTime}:f>`);
		}
		if (details.endTime) {
			parts.push(`ends <t:${details.endTime}:f>`);
		}
		if (details.divisionId) {
			parts.push(`division ${details.divisionId}`);
		}

		return parts.join(' - ');
	}

	/**
	 * noCTF refuses challenge and scoreboard reads outside the event window unless
	 * the token carries admin policies, so an operator who skips the token should
	 * know exactly what will not work.
	 *
	 * @private
	 * @returns {string}
	 */
	_noTokenWarning() {
		return 'No token is configured, so syncing before the CTF start time is not possible and hidden challenges will not be visible.';
	}
}

module.exports = { SetCTFPlatformCommand };
