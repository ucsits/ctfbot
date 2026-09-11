/**
 * Supported CTF platform identifiers.
 *
 * Each entry describes one adapter the bot can drive. The `id` is what gets
 * persisted in ctfs.platform, so treat these strings as stable.
 *
 * @module constants/platforms
 */

/**
 * @typedef {Object} PlatformDefinition
 * @property {string} id - Stable identifier stored in ctfs.platform
 * @property {string} label - Human readable name for Discord output
 * @property {string} description - One line summary of the adapter
 * @property {string} authScheme - How the credential is presented to the API
 */

/** @type {Record<string, PlatformDefinition>} */
const PLATFORMS = {
	ctfd: {
		id: 'ctfd',
		label: 'CTFd',
		description: 'CTFd instances, where the web UI and the API share one origin.',
		authScheme: 'Token <api_token>'
	},
	noctf: {
		id: 'noctf',
		label: 'noCTF',
		description: 'noCTF instances, which serve the API from a separate origin and need a Bearer token.',
		authScheme: 'Bearer <session_token>'
	}
};

/**
 * Used whenever a CTF has no platform recorded, so every pre-existing row keeps
 * behaving exactly as it did before multi-platform support.
 */
const DEFAULT_PLATFORM = 'ctfd';

/**
 * Discord chat input choices built from the registry, so adding a platform in
 * one place updates the command option too.
 */
const PLATFORM_CHOICES = Object.values(PLATFORMS).map(({ id, label, description }) => ({
	name: `${label} - ${description}`,
	value: id
}));

/**
 * @param {string} [id] - Candidate platform id
 * @returns {boolean} True when the id names a registered platform
 */
function isKnownPlatform(id) {
	return Boolean(id) && Object.prototype.hasOwnProperty.call(PLATFORMS, id);
}

module.exports = {
	PLATFORMS,
	DEFAULT_PLATFORM,
	PLATFORM_CHOICES,
	isKnownPlatform
};
