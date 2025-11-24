const { Command } = require('@sapphire/framework');
const { getIdHints } = require('../utils');
const { ctfOperations, challengeOperations, registrationOperations } = require('../database');
const { createCTFdClient } = require('../lib/ctfd');

class SyncChallengesCommand extends Command {
	constructor(context, options) {
		super(context, {
			...options,
			name: 'syncchallenges',
			description: 'Sync challenges and solves from CTFd to the local database'
		});
	}

	registerApplicationCommands(registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription(this.description)
				.addStringOption(option =>
					option
						.setName('source')
						.setDescription('Source to sync solves from (default: direct)')
						.setRequired(false)
						.addChoices(
							{ name: 'Direct (from Challenges)', value: 'direct' },
							{ name: 'Users (from User Profiles)', value: 'users' }
						)
				),
			{
				idHints: getIdHints(this.name)
			}
		);
	}

	async chatInputRun(interaction) {
		await interaction.deferReply();

		const source = interaction.options.getString('source') || 'direct';
		const ctf = ctfOperations.getCTFByChannelId(interaction.channelId);
		if (!ctf) {
			return interaction.editReply({
				content: '❌ This command can only be used in a CTF channel.',
				ephemeral: true
			});
		}

		if (!ctf.api_token || !ctf.ctf_base_url) {
			return interaction.editReply('❌ CTFd API token or Base URL is not configured for this CTF.');
		}

		try {
			const client = createCTFdClient(ctf.ctf_base_url, ctf.api_token);
			
			let challenges = [];
			const newChallenges = [];

			// Pre-load existing challenges to map by name
			const existingChallenges = challengeOperations.getChallengesByCTF(ctf.id);
			const nameToLocalIdMap = new Map();
			for (const chal of existingChallenges) {
				nameToLocalIdMap.set(chal.chal_name, chal.id);
			}

			// 1. Fetch and Sync Challenges
			if (source !== 'users') {
				await interaction.editReply('🔄 Fetching challenges from CTFd...');
				challenges = await client.getChallenges();

				for (const chal of challenges) {
					const existingId = nameToLocalIdMap.get(chal.name);
					if (!existingId) {
						newChallenges.push(chal.name);
					}

					challengeOperations.upsertChallenge({
						ctf_id: ctf.id,
						chal_name: chal.name,
						chal_category: chal.category,
						points: chal.value,
						created_by: interaction.user.id
					});
					
					// Get the local ID
					let dbChalId = existingId;
					if (!dbChalId) {
						const dbChal = challengeOperations.getChallengeByName(ctf.id, chal.name);
						if (dbChal) dbChalId = dbChal.id;
					}

					if (dbChalId) {
						nameToLocalIdMap.set(chal.name, dbChalId);
					}
				}
				await interaction.editReply(`✅ Synced ${challenges.length} challenges. 🔄 Syncing solves...`);
			} else {
				await interaction.editReply('🔄 Syncing solves from users...');
			}
            
            // Get all registrations to map CTFd user IDs to Discord IDs
            const registrations = registrationOperations.getRegistrationsByCTF(ctf.id);
            const ctfdUserMap = new Map(); // ctfd_user_id -> discord_user_id
            for (const reg of registrations) {
                if (reg.ctfd_user_id) {
                    // Ensure we use integer string for mapping
                    ctfdUserMap.set(String(parseInt(reg.ctfd_user_id)), reg.user_id);
                }
            }

            let solvesSynced = 0;
			const newSolves = [];

			// Method A: Iterate through challenges and get solves
			if (source === 'direct') {
				for (const chal of challenges) {
					const localChalId = nameToLocalIdMap.get(chal.name);
					if (!localChalId) continue;

					try {
						// We must use chal.id here because the API requires it
						const solves = await client.getChallengeSolves(chal.id);
						
						for (const solve of solves) {
							// solve.user_id is the user who solved it
							const ctfdUserId = String(parseInt(solve.user_id));
							const discordUserId = ctfdUserMap.get(ctfdUserId);

							if (discordUserId) {
								// Check if already solved locally
								const hasSolved = challengeOperations.hasUserSolved(localChalId, discordUserId);
								if (!hasSolved) {
									challengeOperations.markChallengeSolved(localChalId, discordUserId);
									solvesSynced++;
									newSolves.push(`<@${discordUserId}> solved **${chal.name}**`);
								}
							}
						}
					} catch (err) {
						console.error(`Failed to fetch solves for challenge ${chal.name} (ID: ${chal.id}):`, err);
						// Continue to next challenge
					}
				}
			}            // Method B: Iterate through registered users and get their solves
			if (source === 'users') {
				for (const reg of registrations) {
					if (!reg.ctfd_user_id) continue;

					try {
                        const ctfdUserId = parseInt(reg.ctfd_user_id);
						const userSolves = await client.getUserSolves(ctfdUserId);
						
						for (const solve of userSolves) {
							// Only process correct solves
							if (solve.type && solve.type !== 'correct') continue;

							if (!solve.challenge) continue;

							const chalName = solve.challenge.name;
							let localChalId = nameToLocalIdMap.get(chalName);
							console.log("[DEBUG] localChalId", localChalId);

							if (!localChalId) {
								const chalCategory = solve.challenge.category;
								const chalPoints = solve.challenge.value;

								// Upsert challenge
								challengeOperations.upsertChallenge({
									ctf_id: ctf.id,
									chal_name: chalName,
									chal_category: chalCategory || 'Unknown',
									points: chalPoints || 0,
									created_by: interaction.user.id
								});

								newChallenges.push(chalName);
								const dbChal = challengeOperations.getChallengeByName(ctf.id, chalName);
								if (dbChal) {
									localChalId = dbChal.id;
									nameToLocalIdMap.set(chalName, localChalId);
								}
							}

							if (localChalId) {
								const hasSolved = challengeOperations.hasUserSolved(localChalId, reg.user_id);
								if (!hasSolved) {
									challengeOperations.markChallengeSolved(localChalId, reg.user_id);
									solvesSynced++;
									newSolves.push(`<@${reg.user_id}> solved **${chalName}**`);
									console.log("[INFO]", `<@${reg.user_id}> solved **${chalName}**`);
								}
							}
						}
					} catch (err) {
						console.error(`Failed to fetch solves for user ${reg.ctfd_user_id}:`, err);
					}
				}
			}

			let response = `✅ Sync complete (Source: ${source})!\n- Challenges processed: ${challenges.length}\n- New solves recorded: ${solvesSynced}`;
			
			if (newChallenges.length > 0) {
				response += `\n\n**New Challenges:**\n${newChallenges.join('\n')}`;
			}

			if (newSolves.length > 0) {
				response += `\n\n**New Solves:**\n${newSolves.join('\n')}`;
			}

			// Truncate if too long
			if (response.length > 2000) {
				response = response.substring(0, 1997) + '...';
			}

			return interaction.editReply(response);

		} catch (error) {
			console.error(error);
			return interaction.editReply(`❌ Error syncing challenges: ${error.message}`);
		}
	}
}

module.exports = SyncChallengesCommand;
