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
		// Check if command is used in a CTF channel
		const channel = interaction.channel;
		if (!channel.name.startsWith('ctf-')) {
			return interaction.reply({
				content: '❌ This command can only be used in CTF channels (channels starting with `ctf-`).',
				ephemeral: true
			});
		}

		await interaction.deferReply({ ephemeral: true });

		const username = interaction.options.getString('username');
		const ctfdUrl = interaction.options.getString('ctfd_url');
		const userId = interaction.user.id;
		const userTag = interaction.user.tag;

		try {
			// Get CTF from database
			const ctf = ctfOperations.getCTFByChannelId(channel.id);
			if (!ctf) {
				return interaction.editReply('❌ This channel is not registered as a CTF channel in the database.');
			}

			// If CTFd URL is provided, attempt to fetch user details
			let ctfdData = null;
			const effectiveCtfdUrl = ctfdUrl || ctf.ctf_base_url;
			if (effectiveCtfdUrl) {
				try {
					// Note: CTFd integration requires authentication token
					// This is a placeholder for future implementation
					ctfdData = await this.fetchCTFdUserData(effectiveCtfdUrl, username);
				} catch (error) {
					this.container.logger.warn(`Failed to fetch CTFd data: ${error.message}`);
				}
			}

			// Store registration in database
			try {
				registrationOperations.registerUser({
					ctf_id: ctf.id,
					user_id: userId,
					username: username,
					ctfd_user_id: ctfdData?.userId || null,
					ctfd_team_name: ctfdData?.teamName || null
				});
				this.container.logger.info(`Registered ${userTag} for CTF "${ctf.ctf_name}"`);
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
			this.container.logger.info(`CTF Registration: ${userTag} (${userId}) registered as ${username} for ${ctfName}`);

		} catch (error) {
			this.container.logger.error('Error registering for CTF:', error);
			return interaction.editReply('❌ Failed to register. Please try again later.');
		}
	}

	/**
	 * Fetch user data from CTFd instance
	 * @param {string} ctfdUrl - The CTFd instance URL
	 * @param {string} username - The username to look up
	 * @returns {Promise<Object>} User data including userId and teamName
	 */
	async fetchCTFdUserData(ctfdUrl, username) {
		// This is a placeholder for CTFd integration
		// In a real implementation, you would:
		// 1. Use the @ctfdio/ctfd-js library
		// 2. Authenticate with CTFd API token (stored in environment variables)
		// 3. Fetch user details by username
		// 4. Fetch team details if user is in a team
		
		// Example implementation (requires CTFd API token):
		/*
		const { CTFd } = require('@ctfdio/ctfd-js');
		const ctfd = new CTFd(ctfdUrl, process.env.CTFD_API_TOKEN);
		
		// Search for user
		const users = await ctfd.getUsers({ q: username });
		if (users.length === 0) {
			throw new Error('User not found on CTFd');
		}
		
		const user = users[0];
		let teamName = null;
		
		// Fetch team if user has one
		if (user.team_id) {
			const team = await ctfd.getTeam(user.team_id);
			teamName = team.name;
		}
		
		return {
			userId: user.id,
			teamName: teamName
		};
		*/

		// For now, return null to indicate CTFd integration is not configured
		throw new Error('CTFd integration requires API token configuration');
	}
}

module.exports = { RegisterCTFCommand };
