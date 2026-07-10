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

	// Governance channel categories (where task & document commands are allowed)
	GOVERNANCE_CATEGORIES: [
		'1386740819545030676',
		'1403399481696714843',
		'1392005579865587754',
		'1392006043806076959',
		'1392005958904971305',
		'1392006872520724521',
		'1448569466194759751'
	],

	// Database
	DATABASE: {
		FILE_NAME: 'ctfbot.db',
		BACKUP_INTERVAL: 24 * 60 * 60 * 1000 // 24 hours
	},

	// Luce Blockchain
	LUCE: {
		DEFAULT_PORT: '5500'
	},

	// Reminder Channel
	REMINDER_CHANNEL_ID: '1524933314119467200',

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
