const { Command } = require('@sapphire/framework');
const { getIdHints } = require('../lib/utils');
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
			const newChallenges = [];

			const nameToLocalIdMap = await this.loadExistingChallenges(ctf);

			if (source !== 'users') {
				await this.syncChallenges(interaction, ctf, client, nameToLocalIdMap, newChallenges);
			} else {
				await interaction.editReply('🔄 Syncing solves from users...');
			}

			const { solvesSynced, newSolves } = await this.syncSolves(interaction, ctf, client, source, nameToLocalIdMap);

			return this.formatSyncResponse(interaction, source, solvesSynced, newChallenges, newSolves);

		} catch (error) {
			this.container.logger.error(error);
			return interaction.editReply(`❌ Error syncing challenges: ${error.message}`);
		}
	}

	async loadExistingChallenges(ctf) {
		const existingChallenges = challengeOperations.getChallengesByCTF(ctf.id);
		const nameToLocalIdMap = new Map();
		for (const chal of existingChallenges) {
			nameToLocalIdMap.set(chal.chal_name, chal.id);
		}
		return nameToLocalIdMap;
	}

	async syncChallenges(interaction, ctf, client, nameToLocalIdMap, newChallenges) {
		await interaction.editReply('🔄 Fetching challenges from CTFd...');
		const challenges = await client.getChallenges();

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

			const dbChal = challengeOperations.getChallengeByName(ctf.id, chal.name);
			if (dbChal) {
				nameToLocalIdMap.set(chal.name, dbChal.id);
			}
		}
		await interaction.editReply(`✅ Synced ${challenges.length} challenges. 🔄 Syncing solves...`);
		return challenges;
	}

	async syncSolves(interaction, ctf, client, source, nameToLocalIdMap) {
		const registrations = registrationOperations.getRegistrationsByCTF(ctf.id);
		const ctfdUserMap = this.buildUserMap(registrations);

		let solvesSynced = 0;
		const newSolves = [];

		if (source === 'direct') {
			const challenges = await client.getChallenges();
			for (const chal of challenges) {
				const result = await this.syncSolvesForChallenge(ctf, client, chal, ctfdUserMap, nameToLocalIdMap);
				solvesSynced += result.count;
				newSolves.push(...result.solves);
			}
		} else {
			for (const reg of registrations) {
				const result = await this.syncSolvesForUser(ctf, client, reg, nameToLocalIdMap);
				solvesSynced += result.count;
				newSolves.push(...result.solves);
			}
		}

		return { solvesSynced, newSolves };
	}

	buildUserMap(registrations) {
		const ctfdUserMap = new Map();
		for (const reg of registrations) {
			if (reg.ctfd_user_id) {
				ctfdUserMap.set(String(parseInt(reg.ctfd_user_id)), reg.user_id);
			}
		}
		return ctfdUserMap;
	}

	async syncSolvesForChallenge(ctf, client, chal, ctfdUserMap, nameToLocalIdMap) {
		const localChalId = nameToLocalIdMap.get(chal.name);
		if (!localChalId) return { count: 0, solves: [] };

		let count = 0;
		const solves = [];

		try {
			const challengeSolves = await client.getChallengeSolves(chal.id);
			for (const solve of challengeSolves) {
				const ctfdUserId = String(parseInt(solve.user_id));
				const discordUserId = ctfdUserMap.get(ctfdUserId);

				if (discordUserId && !challengeOperations.hasUserSolved(localChalId, discordUserId)) {
					challengeOperations.markChallengeSolved(localChalId, discordUserId);
					count++;
					solves.push(`<@${discordUserId}> solved **${chal.name}**`);
				}
			}
		} catch (err) {
			this.container.logger.error(`Failed to fetch solves for challenge ${chal.name}:`, err);
		}

		return { count, solves };
	}

	async syncSolvesForUser(ctf, client, reg, nameToLocalIdMap) {
		if (!reg.ctfd_user_id) return { count: 0, solves: [] };

		let count = 0;
		const solves = [];

		try {
			const userSolves = await client.getUserSolves(parseInt(reg.ctfd_user_id));
			for (const solve of userSolves) {
				if (solve.type && solve.type !== 'correct') continue;
				if (!solve.challenge) continue;

				const chalName = solve.challenge.name;
				let localChalId = nameToLocalIdMap.get(chalName);

				if (!localChalId) {
					challengeOperations.upsertChallenge({
						ctf_id: ctf.id,
						chal_name: chalName,
						chal_category: solve.challenge.category || 'Unknown',
						points: solve.challenge.value || 0,
						created_by: null
					});
					const dbChal = challengeOperations.getChallengeByName(ctf.id, chalName);
					if (dbChal) {
						localChalId = dbChal.id;
						nameToLocalIdMap.set(chalName, localChalId);
					}
				}

				if (localChalId && !challengeOperations.hasUserSolved(localChalId, reg.user_id)) {
					challengeOperations.markChallengeSolved(localChalId, reg.user_id);
					count++;
					solves.push(`<@${reg.user_id}> solved **${chalName}**`);
				}
			}
		} catch (err) {
			this.container.logger.error(`Failed to fetch solves for user ${reg.ctfd_user_id}:`, err);
		}

		return { count, solves };
	}

	formatSyncResponse(interaction, source, solvesSynced, newChallenges, newSolves) {
		let response = `✅ Sync complete (Source: ${source})!\n- Challenges processed: ${newChallenges.length}\n- New solves recorded: ${solvesSynced}`;

		if (newChallenges.length > 0) {
			response += `\n\n**New Challenges:**\n${newChallenges.join('\n')}`;
		}
		if (newSolves.length > 0) {
			response += `\n\n**New Solves:**\n${newSolves.join('\n')}`;
		}
		if (response.length > 2000) {
			response = response.substring(0, 1997) + '...';
		}
		return interaction.editReply(response);
	}
}

module.exports = SyncChallengesCommand;
