/**
 * Centralized message constants for consistent user-facing text
 * @module constants/messages
 */

module.exports = {
	// Error Messages
	ERRORS: {
		PERMISSION_DENIED: '❌ You need the "{permission}" permission to use this command.',
		INVALID_DATE_FORMAT: '❌ Invalid date format. Please use: DD-MM-YYYY HH:MM (e.g., 31-12-2025 20:00)',
		INVALID_TIMEZONE: '❌ Invalid timezone. Please use a valid IANA timezone (e.g., Asia/Jakarta, Europe/London, America/New_York)',
		DATE_IN_PAST: '❌ Event date must be in the future.',
		CATEGORY_NOT_FOUND: '❌ CTF category not found. Please set CTF_CATEGORY_ID in your environment variables.',
		NOT_CTF_CHANNEL: '❌ This command can only be used in CTF channels (channels starting with `ctf-`).',
		CTF_NOT_FOUND: '❌ This channel is not registered as a CTF channel in the database.',
		REGISTRATION_FAILED: '❌ Failed to register. Please try again later.',
		INVALID_URL: '❌ Invalid URL format. Please provide a valid URL starting with http:// or https://',
		DATABASE_ERROR: '❌ A database error occurred. Please contact an administrator.',
		CTFD_FETCH_FAILED: '⚠️ Could not fetch CTFd data, but registration was successful.'
	},

	// Success Messages
	SUCCESS: {
		EVENT_CREATED: '✅ Event **{name}** has been scheduled!',
		CTF_CREATED: '✅ CTF channel **{channel}** has been created and event scheduled!',
		REGISTRATION_SUCCESS: '✅ Registration Successful',
		REGISTRATION_UPDATED: '✅ Registration Updated'
	},

	// Info Messages
	INFO: {
		PROCESSING: '⏳ Processing your request...',
		CREATING_CHANNEL: '🔨 Creating CTF channel...',
		CREATING_EVENT: '📅 Scheduling event...',
		FETCHING_CTFD_DATA: '🔍 Fetching CTFd data...'
	},

	// Embed Descriptions
	EMBEDS: {
		PING_DESCRIPTION: 'Measures the bot\'s response time.',
		HELP_DESCRIPTION: 'Available commands for CTFBot',
		EVENT_SCHEDULED: 'Event has been successfully scheduled.',
		CTF_WELCOME: '🚩 Welcome to {name}!',
		REGISTRATION_DESCRIPTION: 'You have been registered for **{ctfName}**!'
	},

	// Command Descriptions
	COMMANDS: {
		PING: {
			NAME: 'ping',
			DESCRIPTION: 'Check bot responsiveness and latency'
		},
		HELP: {
			NAME: 'help',
			DESCRIPTION: 'Display all available commands and their usage'
		},
		SCHEDULE: {
			NAME: 'schedule',
			DESCRIPTION: 'Schedule custom events with timezone support'
		},
		CREATE_CTF: {
			NAME: 'createctf',
			DESCRIPTION: 'Create a CTF text channel and schedule its event'
		},
		REGISTER_CTF: {
			NAME: 'registerctf',
			DESCRIPTION: 'Register your participation for the CTF in this channel'
		}
	},

	// Field Labels
	FIELDS: {
		EVENT_TITLE: '📅 Event',
		START_TIME: '📅 Start Time',
		END_TIME: '⏰ End Time',
		LOCATION: '📍 Location',
		DESCRIPTION: '📝 Description',
		REGISTRATION: '📝 Register',
		DISCORD_USER: '👤 Discord User',
		CTF_USERNAME: '🏷️ CTF Username',
		CTFD_USER_ID: '🆔 CTFd User ID',
		TEAM_NAME: '👥 Team Name',
		VIEW_EVENT: '🔗 Event'
	}
};
