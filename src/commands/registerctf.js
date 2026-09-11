const { Command } = require('@sapphire/framework');
const { EmbedBuilder } = require('discord.js');
const { getIdHints } = require('../lib/utils');
const { ctfOperations, registrationOperations, challengeOperations } = require('../database');
const { runInTransaction } = require('../database/connection');
const { ensureCTFChannelReply } = require('../lib/middleware/ensureCTFChannel');

class RegisterCTFCommand extends Command {
	constructor(context, options) {
		super(context, {
			...options,
			name: 'registerctf',
			description: 'Register your participation for the CTF in this channel'
		});
	}

	registerApplicationCommands(registry) {
		registry.registerChatInputCommand(
			builder =>
				builder
					.setName(this.name)
					.setDescription(this.description)
					.addStringOption(option =>
						option.setName('username').setDescription('Your username on the CTF platform').setRequired(true)
					)
					.addStringOption(option =>
						option
							.setName('team_name')
							.setDescription('Your team name (required for team-based CTFs)')
							.setRequired(false)
					)
					.addStringOption(option =>
						option
							.setName('platform_url')
							.setDescription('CTF platform URL (e.g., https://ctf.example.com)')
							.setRequired(false)
					),
			{
				idHints: getIdHints(this.name)
			}
		);
	}

	async chatInputRun(interaction) {
		const cancelled = await ensureCTFChannelReply(interaction);
		if (cancelled) {
			return;
		}

		await interaction.deferReply({ ephemeral: true });

		const channel = interaction.channel;
		const username = interaction.options.getString('username');
		const teamName = interaction.options.getString('team_name');
		const platformUrl = interaction.options.getString('platform_url');
		const userId = interaction.user.id;
		const userTag = interaction.user.tag;

		try {
			// Get CTF from database
			const ctf = ctfOperations.getCTFByChannelId(channel.id);
			if (!ctf) {
				return interaction.editReply('This channel is not registered as a CTF channel in the database.');
			}

			// Check if team name is required for team-based CTF
			if (ctf.team_mode && !teamName && !platformUrl) {
				return interaction.editReply(
					'This is a team-based CTF. Please provide your team name using the `team_name` parameter.'
				);
			}

			// When an API token is configured the username is verified against the
			// platform. Without a token there is nothing to verify against: CTFd
			// needs one for user lookups, and noCTF refuses anonymous reads before
			// the event starts. The registration is accepted unverified rather than
			// blocked, matching the behaviour before multi-platform support.
			let platformData = null;
			const effectivePlatformUrl = platformUrl || ctf.api_base_url || ctf.ctf_base_url;
			const hasApiToken = ctf.api_token && ctf.api_token.trim() !== '';

			if (effectivePlatformUrl && hasApiToken) {
				try {
					platformData = await this.fetchPlatformUserData(ctf, username, platformUrl);
				} catch (error) {
					this.container.logger.warn(`Failed to fetch platform data: ${error.message}`);
					// Return error to user if platform verification fails
					return interaction.editReply({
						content: `Failed to verify user on the CTF platform.\n**Error:** ${error.message}\n\nPlease check your username and try again.`
					});
				}
			} else if (effectivePlatformUrl && !hasApiToken) {
				this.container.logger.info(`Skipping platform verification for ${username} - no API token configured`);
			}

			// Store the registration and claim any pending platform solves in ONE
			// transaction. Registering without claiming the solves would leave them
			// orphaned under the synthetic platform user id, so the two must commit or
			// roll back together. transferPendingSolves opens its own (nested)
			// transaction, which better-sqlite3 promotes to a savepoint.
			let pendingSolvesResult = null;
			try {
				runInTransaction(() => {
					registrationOperations.registerUser({
						ctf_id: ctf.id,
						user_id: userId,
						username: username,
						team_name: teamName || platformData?.teamName || null,
						ctfd_user_id: platformData?.userId || null,
						ctfd_team_name: platformData?.teamName || null
					});

					if (platformData?.userId) {
						pendingSolvesResult = challengeOperations.transferPendingSolves(
							ctf.id,
							platformData.userId,
							userId,
							ctf.platform
						);
					}
				});
				this.container.logger.info(
					`Registered ${userTag} for CTF "${ctf.ctf_name}" (team: ${teamName || platformData?.teamName || 'individual'})`
				);
				if (pendingSolvesResult && pendingSolvesResult.transferred > 0) {
					this.container.logger.info(
						`Transferred ${pendingSolvesResult.transferred} pending solves for ${username}`
					);
				}
			} catch (dbError) {
				this.container.logger.error('Failed to store registration:', dbError);
				return interaction.editReply('Failed to register. Please try again later.');
			}

			const embed = new EmbedBuilder()
				.setColor(0x00ff00)
				.setTitle('Registration Successful')
				.setDescription(`You have been registered for **${ctf.ctf_name}**!`)
				.addFields(
					{ name: 'Discord User', value: `${interaction.user}`, inline: true },
					{ name: 'CTF Username', value: username, inline: true }
				)
				.setTimestamp()
				.setFooter({ text: `User ID: ${userId}` });

			if (platformData) {
				embed.addFields(
					{ name: 'Platform User ID', value: platformData.userId.toString(), inline: true },
					{ name: 'Team', value: platformData.teamName || 'No team', inline: true }
				);
			} else if (teamName) {
				// Show team name from manual input if platform data not available
				embed.addFields({ name: 'Team', value: teamName, inline: true });
			}

			if (pendingSolvesResult && pendingSolvesResult.transferred > 0) {
				embed.addFields({
					name: 'Solves Claimed',
					value: `${pendingSolvesResult.transferred} solve${pendingSolvesResult.transferred !== 1 ? 's' : ''} transferred from the platform`,
					inline: true
				});
			}

			// Send confirmation to user
			await interaction.editReply({ embeds: [embed] });

			// Announce registration in channel
			const announceEmbed = new EmbedBuilder()
				.setColor(0x0099ff)
				.setDescription(`${interaction.user} registered as **${username}**`)
				.setTimestamp();

			await channel.send({ embeds: [announceEmbed] });

			// Log registration
			this.container.logger.info(
				`CTF Registration: ${userTag} (${userId}) registered as ${username} for ${ctf.ctf_name}`
			);
		} catch (error) {
			this.container.logger.error('Error registering for CTF:', error);
			return interaction.editReply('Failed to register. Please try again later.');
		}
	}

	/**
	 * Verify a username against the CTF's configured platform.
	 *
	 * The client comes from the platform registry, so this works for CTFd and
	 * noCTF alike. Both adapters throw when the user cannot be found.
	 *
	 * @param {Object} ctf - The CTF object from the database
	 * @param {string} username - The username to look up
	 * @param {string|null} [platformUrlOverride] - Per-registration URL override
	 * @returns {Promise<Object>} User data including userId and teamName
	 */
	async fetchPlatformUserData(ctf, username, platformUrlOverride = null) {
		const { createPlatformClient } = require('../lib/platform');

		// Get API token from CTF record
		const apiToken = ctf.api_token;

		if (!apiToken) {
			throw new Error('Platform API token not configured. Set one with /setctfplatform before registering.');
		}

		const apiBaseUrl = platformUrlOverride || ctf.api_base_url || ctf.ctf_base_url;

		try {
			const client = createPlatformClient(ctf.platform, apiBaseUrl, apiToken, {
				divisionId: ctf.platform_division_id
			});

			this.container.logger.info(`Searching for user "${username}" on the CTF platform: ${client.apiBaseUrl}`);
			const user = await client.findUser(username);

			if (!user) {
				throw new Error(
					`User "${username}" not found on the CTF platform. Make sure you are using the exact username from your account.`
				);
			}

			this.container.logger.info(`Found platform user: ${user.username} (ID: ${user.userId})`);

			if (user.teamName) {
				this.container.logger.info(`User is in team: ${user.teamName}`);
			}

			return {
				userId: user.userId,
				username: user.username,
				teamName: user.teamName || null
			};
		} catch (error) {
			// Re-throw with a more helpful error message
			if (error.message.includes('not found')) {
				throw error; // Already has a good message
			}
			if (error.status) {
				throw new Error(`CTF platform API error (${error.status}): ${error.message}`);
			}
			throw new Error(`Failed to verify on the CTF platform: ${error.message}`);
		}
	}
}

module.exports = { RegisterCTFCommand };
