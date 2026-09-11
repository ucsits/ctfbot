/**
 * Synthetic user ids for solvers who have not linked a Discord account yet.
 *
 * A solve synced from a platform can belong to someone who has not run
 * /registerctf. Those rows are parked under `<prefix>:<platform user id>` so the
 * solve is preserved, and /registerctf claims them later by rewriting user_id to
 * the Discord id. The prefix is per platform because the same numeric id means
 * different people on different platforms, and a shared namespace would let one
 * platform's pending solve be claimed by the other's registration.
 *
 * @module platform/syntheticUser
 */

const { DEFAULT_PLATFORM } = require('../constants/platforms');

/** Prefixes are stable once shipped: existing rows already use them. */
const PREFIX_BY_PLATFORM = {
	ctfd: 'ctfd',
	noctf: 'noctf'
};

/**
 * @param {string} [platformId] - Platform id from ctfs.platform
 * @returns {string} Prefix to use for unregistered solvers on that platform
 */
function platformUserPrefix(platformId) {
	return PREFIX_BY_PLATFORM[platformId] || PREFIX_BY_PLATFORM[DEFAULT_PLATFORM];
}

/**
 * @param {string} [platformId] - Platform id from ctfs.platform
 * @param {string|number} platformUserId - The user id as reported by the platform
 * @returns {string} Synthetic user id, e.g. 'noctf:1875'
 */
function syntheticUserId(platformId, platformUserId) {
	return `${platformUserPrefix(platformId)}:${platformUserId}`;
}

module.exports = {
	platformUserPrefix,
	syntheticUserId
};
