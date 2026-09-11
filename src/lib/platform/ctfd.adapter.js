/**
 * CTFd adapter for the normalized platform interface.
 *
 * Wraps the existing CTFdClient without changing it, so the CTFd behaviour that
 * predates multi-platform support is preserved byte for byte while the rest of
 * the bot talks to one shape.
 *
 * @module platform/ctfd.adapter
 */

const { CTFdClient } = require('../ctfd');

/**
 * Build a normalized CTFd client.
 *
 * @param {string} baseUrl - CTFd base URL (API shares the origin)
 * @param {string|null} [apiToken] - CTFd API token
 * @returns {import('./index').PlatformClient} Normalized client
 */
function createCTFdAdapter(baseUrl, apiToken = null) {
	const client = new CTFdClient(baseUrl, apiToken);

	return {
		platform: 'ctfd',
		apiBaseUrl: baseUrl,
		raw: client,

		async getChallenges() {
			const challenges = await client.getChallenges();
			return (challenges || []).map(chal => ({
				id: chal.id,
				name: chal.name,
				slug: String(chal.id),
				category: chal.category || 'uncategorized',
				points: chal.value ?? 0
			}));
		},

		async getChallengeSolves(challengeId) {
			const solves = await client.getChallengeSolves(challengeId);
			return (solves || []).map(solve => ({
				teamId: solve.team_id ?? null,
				userId: solve.user_id === null || solve.user_id === undefined ? null : String(solve.user_id),
				username: solve.user?.name || null,
				solvedAt: solve.date || null,
				value: solve.value ?? null
			}));
		},

		/**
		 * CTFd has no bulk solve endpoint: /api/v1/solves is admin-only and
		 * paginates the whole competition, while the per-user endpoint is what
		 * the sync command already walks. Reject so the caller uses that path.
		 */
		async getAllSolves() {
			throw new Error('CTFd does not support bulk solve listing; use the per-user source instead');
		},

		async findUser(username) {
			const userData = await client.fetchUserData(username);
			return {
				userId: userData.userId,
				username: userData.username,
				teamName: userData.teamName,
				teamId: null
			};
		},

		/**
		 * CTFd's user listing is admin-only and returns full user objects, so there
		 * is no cheap id to name lookup to offer here. Returning an empty map lets
		 * callers keep one code path: they fall back to the id-based label.
		 */
		async resolveUserNames() {
			return new Map();
		},

		async getScoreboard() {
			const entries = await client.getScoreboard();
			return (entries || []).map(entry => ({
				name: entry.name,
				pos: entry.pos,
				score: entry.score
			}));
		},

		async resolveTeamName(teamId) {
			return client.fetchTeamName(teamId);
		},

		async testConnection() {
			const ok = await client.testConnection();
			return {
				ok,
				platform: 'ctfd',
				apiBaseUrl: baseUrl,
				details: {}
			};
		}
	};
}

module.exports = { createCTFdAdapter };
