/**
 * Centralized message constants for consistent user-facing text
 * @module constants/messages
 */

module.exports = {
	// Error Messages
	ERRORS: {
		PERMISSION_DENIED: 'You need the "{permission}" permission to use this command.',
		INVALID_DATE_FORMAT: 'Invalid date format. Use DD-MM-YYYY HH:MM or a Unix timestamp (Discord @time compatible). E.g. 31-12-2025 20:00 or 1735689600',
		INVALID_TIMEZONE: 'Invalid timezone. Please use a valid IANA timezone (e.g., Asia/Jakarta, Europe/London, America/New_York)',
		DATE_IN_PAST: 'Event date must be in the future.',
		END_BEFORE_START: 'End date must be after start date.',
		CATEGORY_NOT_FOUND: 'CTF category not found. Please set CTF_CATEGORY_ID in your environment variables.',
		NOT_CTF_CHANNEL: 'This command can only be used in CTF channels (channels starting with `ctf-`).',
		NOT_IN_GUILD: 'This command can only be used in a guild channel.',
		NOT_IN_TEXT_CHANNEL: 'This command must be used in a text channel.',
		MANAGE_CHANNELS_PERMISSION: 'You need the "Manage Channels" permission to use this command.',
		MANAGE_EVENTS_PERMISSION: 'You need the "Manage Events" permission to use this command.',
		CTF_NOT_FOUND: 'This channel is not registered as a CTF channel in the database.',
		CTF_ALREADY_ARCHIVED: 'This CTF is already archived.',
		TEAM_NAME_REQUIRED: 'This is a team-based CTF. Please provide your team name using the `team_name` parameter.',
		NOT_REGISTERED: 'You must register for this CTF first using `/registerctf`.',
		REGISTRATION_FAILED: 'Failed to register. Please try again later.',
		INVALID_URL: 'Invalid URL format. Please provide a valid URL starting with http:// or https://',
		DATABASE_ERROR: 'A database error occurred. Please contact an administrator.',
		CTFD_FETCH_FAILED: 'Could not fetch CTFd data, but registration was successful.',
		GENERIC_ERROR: 'An error occurred. Please try again later.'
	},

	// Success Messages
	SUCCESS: {
		EVENT_CREATED: 'Event **{name}** has been scheduled!',
		CTF_CREATED: 'CTF channel **{channel}** has been created and event scheduled!',
		REGISTRATION_SUCCESS: 'Registration Successful',
		REGISTRATION_UPDATED: 'Registration Updated'
	},

	// Info Messages
	INFO: {
		PROCESSING: 'Processing your request...',
		CREATING_CHANNEL: 'Creating CTF channel...',
		CREATING_EVENT: 'Scheduling event...',
		FETCHING_CTFD_DATA: 'Fetching CTFd data...'
	},

	// Embed Descriptions
	EMBEDS: {
		PING_DESCRIPTION: 'Measures the bot\'s response time.',
		HELP_DESCRIPTION: 'Available commands for CTFBot',
		EVENT_SCHEDULED: 'Event has been successfully scheduled.',
		CTF_WELCOME: 'Welcome to {name}!',
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
		EVENT_TITLE: 'Event',
		START_TIME: 'Start Time',
		END_TIME: 'End Time',
		LOCATION: 'Location',
		DESCRIPTION: 'Description',
		REGISTRATION: 'Register',
		DISCORD_USER: 'Discord User',
		CTF_USERNAME: 'CTF Username',
		CTFD_USER_ID: 'CTFd User ID',
		TEAM_NAME: 'Team Name',
		VIEW_EVENT: 'Event'
	}
};
