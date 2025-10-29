/**
 * Configuration constants for the bot
 * @module constants/config
 */

module.exports = {
	// Event Durations (in milliseconds)
	DURATIONS: {
		CTF_EVENT: 24 * 60 * 60 * 1000, // 24 hours
		GENERIC_EVENT: 3 * 60 * 60 * 1000, // 3 hours
		HOUR: 60 * 60 * 1000,
		DAY: 24 * 60 * 60 * 1000
	},

	// Discord Privacy Levels
	PRIVACY_LEVELS: {
		GUILD_ONLY: 2
	},

	// Discord Entity Types
	ENTITY_TYPES: {
		STAGE_INSTANCE: 1,
		VOICE: 2,
		EXTERNAL: 3
	},

	// Channel Prefixes
	CHANNEL_PREFIXES: {
		CTF: 'ctf-'
	},

	// Embed Colors
	COLORS: {
		SUCCESS: 0x00FF00,
		ERROR: 0xFF0000,
		INFO: 0x0099FF,
		WARNING: 0xFFAA00,
		PRIMARY: 0x0099FF
	},

	// Date Formats
	DATE_FORMATS: {
		INPUT: 'DD-MM-YYYY HH:MM',
		DISPLAY: '<t:{timestamp}:F>'
	},

	// Default Timezones (for autocomplete suggestions)
	COMMON_TIMEZONES: [
		'Asia/Jakarta',
		'Asia/Singapore',
		'Asia/Tokyo',
		'Asia/Seoul',
		'Asia/Bangkok',
		'Asia/Manila',
		'Asia/Kuala_Lumpur',
		'Europe/London',
		'Europe/Paris',
		'Europe/Berlin',
		'America/New_York',
		'America/Los_Angeles',
		'America/Chicago',
		'Australia/Sydney',
		'UTC'
	],

	// Database
	DATABASE: {
		FILE_NAME: 'ctfbot.db',
		BACKUP_INTERVAL: 24 * 60 * 60 * 1000 // 24 hours
	},

	// Rate Limits
	RATE_LIMITS: {
		COMMANDS_PER_MINUTE: 10,
		REGISTRATIONS_PER_USER: 50
	},

	// URLs
	URLS: {
		DOCUMENTATION: 'https://github.com/ucsits/ctfbot',
		SUPPORT: 'https://github.com/ucsits/ctfbot/issues'
	}
};
