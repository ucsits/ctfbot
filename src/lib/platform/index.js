/**
 * Platform registry.
 *
 * Every CTF channel is bound to exactly one platform (ctfs.platform). Commands
 * never construct a platform client directly; they go through
 * createPlatformClient so a new platform only has to be registered here.
 *
 * ## Normalized client interface
 *
 * Each adapter returns an object with the following shape. Field names are
 * deliberately platform-neutral because the two platforms disagree on almost
 * everything (CTFd uses `value` for points and `name` for challenges, noCTF uses
 * `value` too but `title` and derives category from tags).
 *
 * @typedef {Object} NormalizedChallenge
 * @property {number|string} id - Platform challenge id
 * @property {string} name - Display name (noCTF: title, falling back to slug)
 * @property {string} slug - Stable identifier
 * @property {string} category - Challenge category, 'uncategorized' when unknown
 * @property {number} points - Current point value
 *
 * @typedef {Object} NormalizedSolve
 * @property {string|null} userId - Platform user id as a string, null when the
 *   platform only reports team-level solves
 * @property {number|string|null} teamId - Platform team id
 * @property {string|null} username - Platform username when known
 * @property {string|null} solvedAt - ISO timestamp
 * @property {number|null} value - Points awarded, when reported
 *
 * @typedef {Object} NormalizedScoreboardEntry
 * @property {string} name - Team name
 * @property {number} pos - Rank
 * @property {number} score - Total score
 *
 * @typedef {Object} PlatformClient
 * @property {string} platform - Platform id this client speaks
 * @property {string} apiBaseUrl - API origin in use
 * @property {Object} [raw] - The underlying platform client on adapters that wrap
 *   one (CTFd exposes its CTFdClient here). Absent on native clients, so callers
 *   must guard before using it, which is what the per-user sync path does.
 * @property {() => Promise<NormalizedChallenge[]>} getChallenges
 * @property {(challengeId: number|string) => Promise<NormalizedSolve[]>} getChallengeSolves
 * @property {() => Promise<NormalizedSolve[]>} getAllSolves - Bulk solve listing;
 *   rejects on platforms that do not offer one, and the caller falls back
 * @property {(username: string) => Promise<{userId: string, username: string, teamName: string|null, teamId: number|string|null}>} findUser
 * @property {() => Promise<NormalizedScoreboardEntry[]>} getScoreboard
 * @property {(teamId: number|string) => Promise<string|null>} resolveTeamName
 * @property {() => Promise<{ok: boolean, platform: string, apiBaseUrl: string, details: Object}>} testConnection
 *
 * @module platform
 */

const {
	PLATFORMS,
	DEFAULT_PLATFORM,
	PLATFORM_CHOICES,
	isKnownPlatform
} = require('../constants/platforms');

/**
 * Factories are resolved lazily so a platform whose module is missing only
 * breaks when it is actually selected, and so this registry can be required by
 * tests without pulling in every adapter.
 */
const FACTORIES = {
	ctfd: (baseUrl, token, options) =>
		require('./ctfd.adapter').createCTFdAdapter(baseUrl, token, options),
	noctf: (baseUrl, token, options) =>
		require('../noctf').createNoCTFClient(baseUrl, token, options)
};

/**
 * @returns {import('../constants/platforms').PlatformDefinition[]} Registered platforms
 */
function listPlatforms() {
	return Object.values(PLATFORMS);
}

/**
 * Look up a platform definition, falling back to the default for an unknown or
 * missing id so callers never have to guard against a NULL column.
 *
 * @param {string} [id] - Platform id
 * @returns {import('../constants/platforms').PlatformDefinition}
 */
function getPlatform(id) {
	return isKnownPlatform(id) ? PLATFORMS[id] : PLATFORMS[DEFAULT_PLATFORM];
}

/**
 * Build the normalized client for a platform.
 *
 * @param {string} platformId - Platform id from ctfs.platform
 * @param {string} apiBaseUrl - API origin to talk to
 * @param {string|null} [token] - Platform credential
 * @param {Object} [options] - Adapter options (e.g. divisionId for noCTF)
 * @returns {PlatformClient}
 * @throws {Error} When the platform id is not registered
 */
function createPlatformClient(platformId, apiBaseUrl, token = null, options = {}) {
	if (!isKnownPlatform(platformId)) {
		throw new Error(
			`Unknown CTF platform "${platformId}". Registered platforms: ${Object.keys(PLATFORMS).join(', ')}`
		);
	}

	return FACTORIES[platformId](apiBaseUrl, token, options);
}

module.exports = {
	listPlatforms,
	getPlatform,
	createPlatformClient,
	isKnownPlatform,
	PLATFORMS,
	PLATFORM_CHOICES,
	DEFAULT_PLATFORM
};
