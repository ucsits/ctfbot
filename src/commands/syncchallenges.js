const { Command } = require('@sapphire/framework');
const { getIdHints } = require('../lib/utils');
const { ctfOperations, challengeOperations, registrationOperations } = require('../database');
const { createPlatformClient } = require('../lib/platform');

/**
 * Sync challenges and solves from whichever CTF platform the channel is bound to.
 *
 * The two platforms differ in one way that shapes this command: CTFd reports
 * solves per user, while noCTF reports them per team (its per-challenge solve
 * endpoint omits user_id entirely). The scoreboard endpoint is the only noCTF
 * source that attributes a solve to a user, so the 'users' source prefers it and
 * falls back to the per-user walk when the platform offers no bulk listing.
 *
 * That noCTF scoreboard is division-wide, and the credential cannot narrow it:
 * the platform grants scoreboard and user reads publicly and never filters by
 * the caller's membership. Scope therefore comes from the registrations in this
 * channel. Solves belonging to a registered Discord user are always recorded,
 * and an unregistered solver is only parked when their platform team is one of
 * the registered teams, so a sync never imports the rest of the division.
 */
class SyncChallengesCommand extends Command {
	constructor(context, options) {
		super(context, {
			...options,
			name: 'syncchallenges',
			description: 'Sync challenges and solves from the configured CTF platform'
		});
	}

	registerApplicationCommands(registry) {
		registry.registerChatInputCommand(
			builder =>
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
				content: 'This command can only be used in a CTF channel.',
				ephemeral: true
			});
		}

		if (!ctf.api_token || !(ctf.api_base_url || ctf.ctf_base_url)) {
			return interaction.editReply(
				'The platform API token or base URL is not configured for this CTF. Set them with `/setctfplatform`.'
			);
		}

		try {
			const client = createPlatformClient(ctf.platform, ctf.api_base_url || ctf.ctf_base_url, ctf.api_token, {
				divisionId: ctf.platform_division_id
			});
			const newChallenges = [];

			const nameToLocalIdMap = await this.loadExistingChallenges(ctf);

			// The 'users' source is the fallback for when the challenge listing
			// is unusable, so it deliberately does not require it.
			let challenges = [];
			if (source !== 'users') {
				challenges = await this.syncChallenges(interaction, ctf, client, nameToLocalIdMap, newChallenges);
			} else {
				await interaction.editReply('Syncing solves from users...');
			}

			const { solvesSynced, newSolves } = await this.syncSolves(
				interaction,
				ctf,
				client,
				source,
				nameToLocalIdMap,
				challenges,
				newChallenges
			);

			return this.formatSyncResponse(interaction, source, solvesSynced, newChallenges, newSolves);
		} catch (error) {
			this.container.logger.error(error);
			return interaction.editReply(`Error syncing challenges: ${error.message}`);
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

	/**
	 * Upsert every challenge the platform reports.
	 *
	 * @returns {Promise<Array>} Normalized challenges, with platform ids intact
	 */
	async syncChallenges(interaction, ctf, client, nameToLocalIdMap, newChallenges) {
		await interaction.editReply('Fetching challenges from the platform...');
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
				points: chal.points,
				created_by: interaction.user.id
			});

			const dbChal = challengeOperations.getChallengeByName(ctf.id, chal.name);
			if (dbChal) {
				nameToLocalIdMap.set(chal.name, dbChal.id);
			}
		}
		await interaction.editReply(`Synced ${challenges.length} challenges. Syncing solves...`);
		return challenges;
	}

	async syncSolves(interaction, ctf, client, source, nameToLocalIdMap, challenges = [], newChallenges = []) {
		const registrations = registrationOperations.getRegistrationsByCTF(ctf.id);

		// Registrations made before a platform credential existed have no platform
		// user id, so their solves can never be matched. Repair those links before
		// the lookup map is built, otherwise the whole run treats those members as
		// strangers.
		const linked = await this.linkUnlinkedRegistrations(ctf, client, registrations);
		if (linked > 0) {
			this.container.logger.info(`Linked ${linked} registration(s) to their platform account`);
		}

		const platformUserMap = this.buildUserMap(registrations);
		const userRegMap = new Map(registrations.map(r => [r.user_id, r]));

		let solvesSynced = 0;
		const newSolves = [];

		if (source === 'users') {
			const bulk = await this.syncSolvesFromBulkListing(
				ctf,
				client,
				platformUserMap,
				nameToLocalIdMap,
				userRegMap,
				newChallenges
			);

			if (bulk) {
				return { solvesSynced: bulk.count, newSolves: bulk.solves };
			}

			for (const reg of registrations) {
				const result = await this.syncSolvesForUser(ctf, client, reg, nameToLocalIdMap, userRegMap);
				solvesSynced += result.count;
				newSolves.push(...result.solves);
			}
		} else {
			for (const chal of challenges) {
				const result = await this.syncSolvesForChallenge(
					ctf,
					client,
					chal,
					platformUserMap,
					nameToLocalIdMap,
					userRegMap
				);
				solvesSynced += result.count;
				newSolves.push(...result.solves);
			}
		}

		return { solvesSynced, newSolves };
	}

	/**
	 * Map platform user ids onto Discord ids.
	 *
	 * ctfd_user_id stores whatever the platform reported, which may have been
	 * written as a float by SQLite's TEXT affinity, so it is normalised through
	 * parseInt on both sides of the lookup.
	 */
	buildUserMap(registrations) {
		const platformUserMap = new Map();
		for (const reg of registrations) {
			if (reg.ctfd_user_id === null || reg.ctfd_user_id === undefined || reg.ctfd_user_id === '') {
				continue;
			}
			platformUserMap.set(String(parseInt(reg.ctfd_user_id, 10)), reg.user_id);
		}
		return platformUserMap;
	}

	/**
	 * Resolve the platform account for registrations that do not have one yet.
	 *
	 * A registration is only linked when the platform returns the exact username
	 * that was registered: both adapters fall back to the first fuzzy match when
	 * nothing matches exactly, and linking the wrong person would attribute their
	 * solves to a Discord user who never solved them. A failed or inexact lookup
	 * is skipped, never fatal, so one bad registration cannot block the sync.
	 *
	 * The registrations array is mutated in place so buildUserMap, which runs
	 * next, sees the link without a second database read.
	 *
	 * @returns {Promise<number>} How many registrations were linked
	 */
	async linkUnlinkedRegistrations(ctf, client, registrations) {
		const unlinked = registrations.filter(reg => !reg.ctfd_user_id);
		if (unlinked.length === 0) {
			return 0;
		}

		let linked = 0;
		for (const reg of unlinked) {
			let user;
			try {
				user = await client.findUser(reg.username);
			} catch (error) {
				this.container.logger.warn(`Could not link ${reg.username} to the platform: ${error.message}`);
				continue;
			}

			if (!user || user.userId === null || user.userId === undefined) {
				continue;
			}

			const wanted = String(reg.username || '')
				.trim()
				.toLowerCase();
			const found = String(user.username || '')
				.trim()
				.toLowerCase();
			if (!wanted || found !== wanted) {
				this.container.logger.warn(
					`Platform user "${user.username}" does not match registration "${reg.username}"; leaving it unlinked`
				);
				continue;
			}

			const teamName = user.teamName || null;
			registrationOperations.updatePlatformLink(ctf.id, reg.user_id, {
				ctfd_user_id: user.userId,
				ctfd_team_name: teamName
			});

			// Solves already parked under the synthetic platform id now belong to a
			// known Discord user, so claim them instead of leaving duplicates behind.
			challengeOperations.transferPendingSolves(ctf.id, user.userId, reg.user_id, ctf.platform);

			reg.ctfd_user_id = String(user.userId);
			reg.ctfd_team_name = teamName;
			linked += 1;
		}

		return linked;
	}

	/**
	 * Solve attribution through the platform's bulk listing.
	 *
	 * Only noCTF offers this. It is the accurate path there because the
	 * per-challenge endpoint drops user_id.
	 *
	 * The listing is division-wide, so the solves it returns are filtered against
	 * the teams this channel has registrations for. A solver linked to a Discord
	 * account is recorded regardless of team, because their registration is the
	 * scope. An unlinked solver is only parked (and only named) when their team is
	 * one of the registered ones; everyone else in the division is ignored. When
	 * the platform cannot resolve team names the scope is empty and nothing
	 * unregistered is parked, which fails closed rather than importing the
	 * division.
	 *
	 * @returns {Promise<{count: number, solves: string[]}|null>} null when the
	 *   platform does not support it, so the caller falls back
	 */
	async syncSolvesFromBulkListing(ctf, client, platformUserMap, nameToLocalIdMap, userRegMap, newChallenges) {
		let solves;
		try {
			solves = await client.getAllSolves();
		} catch (error) {
			this.container.logger.info(
				`Bulk solve listing unavailable (${error.message}); falling back to per-user sync`
			);
			return null;
		}

		// The bulk listing carries platform challenge ids only, so the challenge
		// list is needed to translate them. A challenge missing from it was not
		// visible to this credential, and its solves cannot be attributed.
		const challenges = await client.getChallenges();
		const platformChallengeMap = new Map();
		for (const chal of challenges) {
			let localId = nameToLocalIdMap.get(chal.name);

			if (!localId) {
				challengeOperations.upsertChallenge({
					ctf_id: ctf.id,
					chal_name: chal.name,
					chal_category: chal.category,
					points: chal.points,
					created_by: 'platform_sync'
				});
				const dbChal = challengeOperations.getChallengeByName(ctf.id, chal.name);
				localId = dbChal ? dbChal.id : null;
				if (localId) {
					nameToLocalIdMap.set(chal.name, localId);
					newChallenges.push(chal.name);
				}
			}

			if (localId) {
				platformChallengeMap.set(chal.id, { localId, name: chal.name });
			}
		}

		let count = 0;
		const newSolves = [];

		// The listing covers the whole division, so the teams that matter have to
		// be worked out before anything is written. A team id is a candidate only
		// when it carries a solve from someone who is not linked to a Discord
		// account, since a linked solver is recorded on their registration alone.
		const unlinkedTeamIds = new Set();
		for (const solve of solves) {
			if (solve.userId === null || solve.userId === undefined) {
				continue;
			}
			if (solve.teamId === null || solve.teamId === undefined) {
				continue;
			}
			if (!platformChallengeMap.has(solve.challengeId)) {
				continue;
			}
			const platformUserId = String(parseInt(solve.userId, 10));
			if (!platformUserMap.has(platformUserId)) {
				unlinkedTeamIds.add(String(solve.teamId));
			}
		}

		const scopedTeamIds = await this._scopedTeamIds(client, userRegMap, unlinkedTeamIds);

		// The bulk listing identifies a solver by a numeric user id only. Resolve
		// the names for the solvers who are not linked to a Discord account and are
		// in scope, once, so the announcement and the stored row can name a person
		// instead of a number. Solvers whose challenge is not visible, or whose team
		// is outside the channel, are excluded because their solve is skipped below
		// and the lookup would be wasted.
		const unresolvedIds = new Set();
		for (const solve of solves) {
			if (solve.userId === null || solve.userId === undefined) {
				continue;
			}
			if (!platformChallengeMap.has(solve.challengeId)) {
				continue;
			}
			if (!scopedTeamIds.has(String(solve.teamId))) {
				continue;
			}
			const platformUserId = String(parseInt(solve.userId, 10));
			if (!platformUserMap.has(platformUserId)) {
				unresolvedIds.add(platformUserId);
			}
		}

		let userNames = new Map();
		if (unresolvedIds.size > 0 && typeof client.resolveUserNames === 'function') {
			try {
				userNames = await client.resolveUserNames([...unresolvedIds]);
			} catch (error) {
				this.container.logger.warn(`Could not resolve unregistered solver names: ${error.message}`);
			}
		}

		for (const solve of solves) {
			const challenge = platformChallengeMap.get(solve.challengeId);
			if (!challenge) {
				continue;
			}

			const platformUserId =
				solve.userId === null || solve.userId === undefined ? null : String(parseInt(solve.userId, 10));
			const discordUserId = platformUserId ? platformUserMap.get(platformUserId) : null;

			if (discordUserId) {
				const message = this._recordForRegisteredUser(
					ctf,
					challenge.localId,
					discordUserId,
					solve,
					userRegMap,
					challenge.name,
					platformUserId
				);
				if (message) {
					count++;
					newSolves.push(message);
				}
			} else if (platformUserId) {
				// Someone in the division who is not registered here. Only the teams
				// this channel actually has registrations for are in scope; the rest of
				// the scoreboard is not this CTF's business.
				if (!scopedTeamIds.has(String(solve.teamId))) {
					continue;
				}
				if (challengeOperations.hasCtfdUserSolved(challenge.localId, platformUserId, ctf.platform)) {
					continue;
				}
				const platformUsername = userNames.get(platformUserId) || null;
				challengeOperations.markChallengeSolvedForCtfdUser(
					challenge.localId,
					platformUserId,
					platformUsername,
					solve.solvedAt,
					ctf.platform
				);
				count++;
				const label = platformUsername || `platform user ${platformUserId}`;
				newSolves.push(`${label} (unregistered) solved **${challenge.name}**`);
			}
		}

		return { count, solves: newSolves };
	}

	/**
	 * The platform team ids that belong to this channel's registrations.
	 *
	 * The division-wide bulk listing reports a solve's team by id only, so the
	 * ids have to be translated to names before they can be compared with what
	 * members registered. Only the ids whose name matches a registered team come
	 * back, so the caller can treat membership in the result as "in scope".
	 *
	 * An empty result means nothing is in scope, which is also what an unavailable
	 * resolver produces: without a name to compare, an unregistered solver must
	 * not be parked, so this fails closed.
	 *
	 * @param {Object} client - Platform client
	 * @param {Map<string, Object>} userRegMap - Registrations by Discord user id
	 * @param {Set<string>} candidateTeamIds - Team ids to test
	 * @returns {Promise<Set<string>>} Team ids whose name is registered
	 */
	async _scopedTeamIds(client, userRegMap, candidateTeamIds) {
		const scoped = new Set();
		const registeredTeams = this._registeredTeamNames(userRegMap);

		if (registeredTeams.size === 0 || candidateTeamIds.size === 0) {
			return scoped;
		}

		if (typeof client.resolveTeamNames !== 'function') {
			this.container.logger.warn(
				`Platform "${client.platform}" cannot resolve team names; not parking any unregistered solve`
			);
			return scoped;
		}

		try {
			const teamNames = await client.resolveTeamNames([...candidateTeamIds]);
			for (const [teamId, teamName] of teamNames) {
				if (registeredTeams.has(teamName)) {
					scoped.add(teamId);
				}
			}
		} catch (error) {
			// Unlike the adapter, which reports a name failure by omission, a client
			// that throws leaves scope undetermined. Parking on an unknown scope is
			// what imported the whole division, so an error means nothing is parked.
			this.container.logger.warn(`Could not scope solves to the registered teams: ${error.message}`);
		}

		return scoped;
	}

	/**
	 * Every team name this channel's registrations claim.
	 *
	 * Both columns are collected and compared exactly, which is the same rule
	 * _findRegisteredMember applies: team_name is what the member typed and
	 * ctfd_team_name is what the platform reported, and either can be the one that
	 * matches.
	 *
	 * @param {Map<string, Object>} userRegMap - Registrations by Discord user id
	 * @returns {Set<string>} Non-empty team names
	 */
	_registeredTeamNames(userRegMap) {
		const names = new Set();
		for (const reg of userRegMap.values()) {
			for (const candidate of [reg.team_name, reg.ctfd_team_name]) {
				if (candidate) {
					names.add(candidate);
				}
			}
		}
		return names;
	}

	/**
	 * Solve attribution per challenge. CTFd reports the solver; noCTF reports the
	 * team, which is matched back to a registered member.
	 */
	async syncSolvesForChallenge(ctf, client, chal, platformUserMap, nameToLocalIdMap, userRegMap) {
		const localChalId = nameToLocalIdMap.get(chal.name);
		if (!localChalId) {
			return { count: 0, solves: [] };
		}

		let count = 0;
		const solves = [];

		try {
			const challengeSolves = await client.getChallengeSolves(chal.id);
			for (const solve of challengeSolves) {
				if (solve.userId !== null && solve.userId !== undefined) {
					const platformUserId = String(parseInt(solve.userId, 10));
					const discordUserId = platformUserMap.get(platformUserId);

					if (discordUserId) {
						const message = this._recordForRegisteredUser(
							ctf,
							localChalId,
							discordUserId,
							solve,
							userRegMap,
							chal.name,
							platformUserId
						);
						if (message) {
							count++;
							solves.push(message);
						}
					} else {
						if (challengeOperations.hasCtfdUserSolved(localChalId, platformUserId, ctf.platform)) {
							continue;
						}
						const label = solve.username || `platform user ${platformUserId}`;
						challengeOperations.markChallengeSolvedForCtfdUser(
							localChalId,
							platformUserId,
							solve.username,
							solve.solvedAt,
							ctf.platform
						);
						count++;
						solves.push(`${label} (unregistered) solved **${chal.name}**`);
					}
					continue;
				}

				// Team-level solve: resolve the team, then attribute it to a
				// registered member of that team.
				const teamName = await client.resolveTeamName(solve.teamId);
				const member = this._findRegisteredMember(teamName, userRegMap);
				if (!member) {
					continue;
				}

				const message = this._recordForRegisteredUser(
					ctf,
					localChalId,
					member.user_id,
					solve,
					userRegMap,
					chal.name
				);
				if (message) {
					count++;
					solves.push(message);
				}
			}
		} catch (err) {
			this.container.logger.error(`Failed to fetch solves for challenge ${chal.name}:`, err);
		}

		return { count, solves };
	}

	/**
	 * Per-user solve walk. This is the CTFd path, which needs the raw client
	 * because the normalized interface has no per-user endpoint (noCTF has none).
	 */
	async syncSolvesForUser(ctf, client, reg, nameToLocalIdMap, userRegMap) {
		if (!reg.ctfd_user_id) {
			return { count: 0, solves: [] };
		}

		if (!client.raw || typeof client.raw.getUserSolves !== 'function') {
			this.container.logger.warn(
				`Platform "${ctf.platform}" has no per-user solve listing; skipping ${reg.username}`
			);
			return { count: 0, solves: [] };
		}

		let count = 0;
		const solves = [];

		try {
			const userSolves = await client.raw.getUserSolves(parseInt(reg.ctfd_user_id, 10));
			for (const solve of userSolves) {
				if (solve.type && solve.type !== 'correct') {
					continue;
				}
				if (!solve.challenge) {
					continue;
				}

				const chalName = solve.challenge.name;
				let localChalId = nameToLocalIdMap.get(chalName);

				if (!localChalId) {
					challengeOperations.upsertChallenge({
						ctf_id: ctf.id,
						chal_name: chalName,
						chal_category: solve.challenge.category || 'Unknown',
						points: solve.challenge.value || 0,
						created_by: 'platform_sync'
					});
					const dbChal = challengeOperations.getChallengeByName(ctf.id, chalName);
					if (dbChal) {
						localChalId = dbChal.id;
						nameToLocalIdMap.set(chalName, localChalId);
					}
				}

				if (!localChalId) {
					continue;
				}

				const message = this._recordForRegisteredUser(
					ctf,
					localChalId,
					reg.user_id,
					{ solvedAt: solve.date },
					userRegMap,
					chalName,
					reg.ctfd_user_id
				);
				if (message) {
					count++;
					solves.push(message);
				}
			}
		} catch (err) {
			this.container.logger.error(`Failed to fetch solves for user ${reg.ctfd_user_id}:`, err);
		}

		return { count, solves };
	}

	/**
	 * Find the registration belonging to a platform team name.
	 *
	 * team_name is what the member typed; ctfd_team_name is what the platform
	 * reported. Either can be the one that matches.
	 */
	_findRegisteredMember(teamName, userRegMap) {
		if (!teamName) {
			return null;
		}
		for (const reg of userRegMap.values()) {
			if (reg.team_name === teamName || reg.ctfd_team_name === teamName) {
				return reg;
			}
		}
		return null;
	}

	/**
	 * Record a solve for a Discord user, honouring the one-solve-per-team rule.
	 *
	 * @param {string|null} [platformUserId] - Platform id of the solver when known.
	 *   Supplied so a solve that was already parked under `<prefix>:<id>` can be
	 *   claimed instead of duplicated once the member's link is known.
	 * @returns {string|null} Announcement line, or null when the solve was
	 *   already covered by this user or another member of their team
	 */
	_recordForRegisteredUser(ctf, challengeId, discordUserId, solve, userRegMap, chalName, platformUserId = null) {
		if (challengeOperations.hasUserSolved(challengeId, discordUserId)) {
			return null;
		}

		// The platform recorded this same solve earlier, under the synthetic id,
		// because no registration was linked at the time. Move that row over
		// instead of inserting a second one for the same solve. The id is
		// normalised through parseInt because a registration written before the
		// link repair can hold a float-shaped string such as '1706.0'.
		const normalisedPlatformUserId =
			platformUserId === null || platformUserId === undefined ? null : String(parseInt(platformUserId, 10));
		if (
			normalisedPlatformUserId &&
			challengeOperations.hasCtfdUserSolved(challengeId, normalisedPlatformUserId, ctf.platform)
		) {
			challengeOperations.transferPendingSolves(ctf.id, normalisedPlatformUserId, discordUserId, ctf.platform);
			if (challengeOperations.hasUserSolved(challengeId, discordUserId)) {
				return null;
			}
		}

		const reg = userRegMap.get(discordUserId);

		if (ctf.team_mode && reg && reg.team_name) {
			const teamMembers = registrationOperations.getTeamMembers(ctf.id, reg.team_name);
			const alreadySolved = teamMembers.some(
				m => m.user_id !== discordUserId && challengeOperations.hasUserSolved(challengeId, m.user_id)
			);
			if (alreadySolved) {
				return null;
			}
		}

		const teamKey = ctf.team_mode && reg ? reg.team_name || null : null;
		if (!this._recordSolve(challengeId, discordUserId, solve.solvedAt, teamKey)) {
			return null;
		}

		return `<@${discordUserId}> solved **${chalName}**`;
	}

	/**
	 * Record a synced solve, returning false when it is already covered.
	 *
	 * Team mode stores the team name as the solve's team key, so the partial
	 * unique index on (challenge_id, team_key) is the real guarantee behind the
	 * one-solve-per-team rule. A collision means another member of the same team
	 * was already recorded, which is a skip rather than an error.
	 *
	 * @returns {boolean} true when a new solve row was written
	 */
	_recordSolve(challengeId, userId, solvedAt, teamKey) {
		try {
			challengeOperations.markChallengeSolved(challengeId, userId, solvedAt, teamKey);
			return true;
		} catch (err) {
			if (err.message.includes('UNIQUE constraint failed')) {
				return false;
			}
			throw err;
		}
	}

	formatSyncResponse(interaction, source, solvesSynced, newChallenges, newSolves) {
		let response = `Sync complete (Source: ${source})!\n- Challenges processed: ${newChallenges.length}\n- New solves recorded: ${solvesSynced}`;

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
