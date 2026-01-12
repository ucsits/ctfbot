const { Command } = require('@sapphire/framework');
const { EmbedBuilder } = require('discord.js');
const { getIdHints } = require('../lib/utils');
const { ctfOperations, registrationOperations, challengeOperations } = require('../database');
const config = require('../config');

class SolveCTFCommand extends Command {
	constructor(context, options) {
		super(context, {
			...options,
			name: 'solvectf',
			description: 'Mark a challenge as solved by you'
		});
	}

	registerApplicationCommands(registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription(this.description)
				.addStringOption(option =>
					option
						.setName('chal_name')
						.setDescription('Name of the challenge you solved')
						.setRequired(true)
						.setAutocomplete(true)
				),
		{
			idHints: getIdHints(this.name)
		}
		);
	}

	async autocompleteRun(interaction) {
		const focusedValue = interaction.options.getFocused().toLowerCase();
		const channel = interaction.channel;

		try {
			// Get CTF from database
			const ctf = ctfOperations.getCTFByChannelId(channel.id);
			if (!ctf) {
				return interaction.respond([]);
			}

			// Get all challenges for this CTF
			const challenges = challengeOperations.getChallengesByCTF(ctf.id);

			// Filter challenges based on user input
			const filtered = challenges
				.filter(chal => chal.chal_name.toLowerCase().includes(focusedValue))
				.slice(0, 25) // Discord allows max 25 autocomplete options
				.map(chal => ({
					name: `${chal.chal_name} (${chal.chal_category})`,
					value: chal.chal_name
				}));

			await interaction.respond(filtered);
		} catch (error) {
			this.container.logger.error('Error in autocomplete:', error);
			await interaction.respond([]);
		}
	}

	async chatInputRun(interaction) {
		const channel = interaction.channel;

		if (channel.parentId !== config.ctf.categoryId) {
			return interaction.reply({
				content: '❌ This command can only be used in CTF channels (channels within the CTF category).',
				ephemeral: true
			});
		}

		await interaction.deferReply();

		const chalName = interaction.options.getString('chal_name');
		const userId = interaction.user.id;
		const userTag = interaction.user.tag;

		try {
			// Get CTF from database
			const ctf = ctfOperations.getCTFByChannelId(channel.id);
			if (!ctf) {
				return interaction.editReply('❌ This channel is not registered as a CTF channel in the database.');
			}

			// Check if user is registered for this CTF
			const registration = registrationOperations.getUserRegistration(ctf.id, userId);
			if (!registration) {
				return interaction.editReply('❌ You must register for this CTF first using `/registerctf`.');
			}

			// Get challenge from database
			const challenge = challengeOperations.getChallengeByName(ctf.id, chalName);
			if (!challenge) {
				return interaction.editReply(`❌ Challenge **${chalName}** does not exist. Make sure it was added with \`/addchalctf\` first.`);
			}

			// Check if user already solved this challenge
			const alreadySolved = challengeOperations.hasUserSolved(challenge.id, userId);
			if (alreadySolved) {
				return interaction.editReply(`❌ You have already marked **${chalName}** as solved.`);
			}

			// For team-based CTFs, check if any team member already solved it
			if (ctf.team_mode && registration.team_name) {
				const teamMembers = registrationOperations.getTeamMembers(ctf.id, registration.team_name);
				const teamMemberIds = teamMembers.map(m => m.user_id);

				// Check if any team member has solved this challenge
				for (const memberId of teamMemberIds) {
					if (memberId !== userId && challengeOperations.hasUserSolved(challenge.id, memberId)) {
						const solver = teamMembers.find(m => m.user_id === memberId);
						return interaction.editReply(
							`❌ Your team member **${solver.username}** has already solved **${chalName}**. Only one solve per team is allowed.`
						);
					}
				}
			}

			// Mark challenge as solved
			try {
				challengeOperations.markChallengeSolved(challenge.id, userId);
				this.container.logger.info(`${userTag} solved challenge "${chalName}" in CTF "${ctf.ctf_name}"`);

				// Get all solvers for this challenge
				const solvers = challengeOperations.getChallengeSolvers(challenge.id);
				const solverCount = solvers.length;
				const isFirstBlood = solverCount === 1;

				const embed = new EmbedBuilder()
					.setColor(isFirstBlood ? 0xFF0000 : 0x00FF00)
					.setTitle(isFirstBlood ? '🩸 First Blood!' : '✅ Challenge Solved')
					.setDescription(`**${chalName}** solved by ${interaction.user}!`)
					.addFields(
						{ name: '📁 Category', value: challenge.chal_category, inline: true },
						{ name: '👤 Solver', value: registration.username, inline: true },
						{ name: '🏆 Solve Count', value: `${solverCount} solve${solverCount !== 1 ? 's' : ''}`, inline: true }
					)
					.setTimestamp();

				if (registration.ctfd_team_name) {
					embed.addFields({ name: '👥 Team', value: registration.ctfd_team_name, inline: true });
				}

				await interaction.editReply({ embeds: [embed] });

				// Announce in channel
				/*const announceEmbed = new EmbedBuilder()
					.setColor(isFirstBlood ? 0xFF0000 : 0x0099FF)
					.setDescription(
						isFirstBlood
							? `🩸 **FIRST BLOOD!** ${interaction.user} solved **${chalName}** (${challenge.chal_category})`
							: `✅ ${interaction.user} solved **${chalName}** (${challenge.chal_category})`
					)
					.setTimestamp();

				await channel.send({ embeds: [announceEmbed] });*/

			} catch (dbError) {
				if (dbError.message.includes('UNIQUE constraint failed')) {
					return interaction.editReply(`❌ You have already marked **${chalName}** as solved.`);
				}
				this.container.logger.error('Failed to mark challenge as solved:', dbError);
				return interaction.editReply('❌ Failed to mark challenge as solved. Please try again later.');
			}

		} catch (error) {
			this.container.logger.error('Error solving challenge:', error);
			return interaction.editReply('❌ Failed to solve challenge. Please try again later.');
		}
	}
}

module.exports = { SolveCTFCommand };
