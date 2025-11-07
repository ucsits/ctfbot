const { Command } = require('@sapphire/framework');
const { EmbedBuilder } = require('discord.js');
const { getIdHints } = require('../utils');
const { ctfOperations, registrationOperations } = require('../database');

class RegisterCTFCommand extends Command {
	constructor(context, options) {
		super(context, {
			...options,
			name: 'registerctf',
			description: 'Register your participation for the CTF in this channel'
		});
	}

	registerApplicationCommands(registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription(this.description)
				.addStringOption(option =>
					option
						.setName('username')
						.setDescription('Your username on the CTF platform')
						.setRequired(true)
				)
				.addStringOption(option =>
					option
						.setName('team_name')
						.setDescription('Your team name (required for team-based CTFs)')
						.setRequired(false)
				)
				.addStringOption(option =>
					option
						.setName('ctfd_url')
						.setDescription('CTFd instance URL (e.g., https://ctf.example.com)')
						.setRequired(false)
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

		await interaction.deferReply({ ephemeral: true });

		const username = interaction.options.getString('username');
		const teamName = interaction.options.getString('team_name');
		const ctfdUrl = interaction.options.getString('ctfd_url');
		const userId = interaction.user.id;
		const userTag = interaction.user.tag;

		try {
			// Get CTF from database
			const ctf = ctfOperations.getCTFByChannelId(channel.id);
			if (!ctf) {
				return interaction.editReply('❌ This channel is not registered as a CTF channel in the database.');
			}

			// Check if team name is required for team-based CTF
			if (ctf.team_mode && !teamName && !ctfdUrl) {
				return interaction.editReply('❌ This is a team-based CTF. Please provide your team name using the `team_name` parameter.');
			}

			// If CTFd URL is provided AND API token exists, attempt to fetch user details
			let ctfdData = null;
			const effectiveCtfdUrl = ctfdUrl || ctf.ctf_base_url;
			const hasApiToken = ctf.api_token && ctf.api_token.trim() !== '';
			
			if (effectiveCtfdUrl && hasApiToken) {
				try {
					// Note: CTFd integration requires authentication token
					// Pass the CTF object to access api_token
					ctfdData = await this.fetchCTFdUserData(effectiveCtfdUrl, username, ctf);
				} catch (error) {
					this.container.logger.warn(`Failed to fetch CTFd data: ${error.message}`);
					// Return error to user if CTFd verification fails
					return interaction.editReply({
						content: `❌ Failed to verify user on CTFd platform.\n**Error:** ${error.message}\n\nPlease check your username and try again.`
					});
				}
			} else if (effectiveCtfdUrl && !hasApiToken) {
				this.container.logger.info(`Skipping CTFd verification for ${username} - no API token configured`);
			}

			// Store registration in database
			try {
				registrationOperations.registerUser({
					ctf_id: ctf.id,
					user_id: userId,
					username: username,
					team_name: teamName || ctfdData?.teamName || null,
					ctfd_user_id: ctfdData?.userId || null,
					ctfd_team_name: ctfdData?.teamName || null
				});
				this.container.logger.info(`Registered ${userTag} for CTF "${ctf.ctf_name}" (team: ${teamName || ctfdData?.teamName || 'individual'})`);
			} catch (dbError) {
				this.container.logger.error('Failed to store registration:', dbError);
				return interaction.editReply('❌ Failed to register. Please try again later.');
			}

			const embed = new EmbedBuilder()
				.setColor(0x00FF00)
				.setTitle('✅ Registration Successful')
				.setDescription(`You have been registered for **${ctf.ctf_name}**!`)
				.addFields(
					{ name: '👤 Discord User', value: `${interaction.user}`, inline: true },
					{ name: '🏷️ CTF Username', value: username, inline: true }
				)
				.setTimestamp()
				.setFooter({ text: `User ID: ${userId}` });

			if (ctfdData) {
				embed.addFields(
					{ name: '🆔 CTFd User ID', value: ctfdData.userId.toString(), inline: true },
					{ name: '👥 Team', value: ctfdData.teamName || 'No team', inline: true }
				);
			} else if (teamName) {
				// Show team name from manual input if CTFd data not available
				embed.addFields(
					{ name: '👥 Team', value: teamName, inline: true }
				);
			}

			// Send confirmation to user
			await interaction.editReply({ embeds: [embed] });

			// Announce registration in channel
			const announceEmbed = new EmbedBuilder()
				.setColor(0x0099FF)
				.setDescription(`🚩 ${interaction.user} registered as **${username}**`)
				.setTimestamp();

			await channel.send({ embeds: [announceEmbed] });

			// Log registration
			this.container.logger.info(`CTF Registration: ${userTag} (${userId}) registered as ${username} for ${ctf.ctf_name}`);

		} catch (error) {
			this.container.logger.error('Error registering for CTF:', error);
			return interaction.editReply('❌ Failed to register. Please try again later.');
		}
	}

	/**
	 * Fetch user data from CTFd instance
	 * @param {string} ctfdUrl - The CTFd instance URL
	 * @param {string} username - The username to look up
	 * @param {Object} ctf - The CTF object from database
	 * @returns {Promise<Object>} User data including userId and teamName
	 */
	async fetchCTFdUserData(ctfdUrl, username, ctf) {
		const { CTFdClient } = require('../lib/ctfd');
		
		// Get API token from CTF record
		const apiToken = ctf.api_token;
		
		if (!apiToken) {
			throw new Error('CTFd API token not configured. Please provide api_token when creating this CTF with /createctf.');
		}
		
		try {
			// Initialize CTFd client
			const ctfd = new CTFdClient(ctfdUrl, apiToken);
			
			// Search for user by username
			this.container.logger.info(`Searching for user "${username}" on CTFd: ${ctfdUrl}`);
			const users = await ctfd.getUsers({ q: username });
			
			if (!users || users.length === 0) {
				throw new Error(`User "${username}" not found on CTFd platform. Make sure you're using the exact username from your CTFd account.`);
			}
			
			// Find exact match (case-insensitive)
			const user = users.find(u => u.name.toLowerCase() === username.toLowerCase()) || users[0];
			this.container.logger.info(`Found CTFd user: ${user.name} (ID: ${user.id})`);
			
			let teamName = null;
			
			// Fetch team if user has one
			if (user.team_id) {
				try {
					const team = await ctfd.getTeam(user.team_id);
					teamName = team.name;
					this.container.logger.info(`User is in team: ${teamName} (ID: ${user.team_id})`);
				} catch (teamError) {
					this.container.logger.warn(`Failed to fetch team info: ${teamError.message}`);
					// Don't fail registration if team fetch fails
				}
			}
			
			return {
				userId: user.id,
				teamName: teamName
			};
		} catch (error) {
			// Re-throw with more helpful error message
			if (error.message.includes('not found')) {
				throw error; // Already has a good message
			}
			if (error.status) {
				// HTTP error from CTFd API
				throw new Error(`CTFd API error (${error.status}): Failed to connect to CTFd`);
			}
			throw new Error(`Failed to verify on CTFd: ${error.message}`);
		}
	}
}

module.exports = { RegisterCTFCommand };
