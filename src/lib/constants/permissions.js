/**
 * Permission constants
 * @module constants/permissions
 */

const { PermissionFlagsBits } = require('discord.js');

module.exports = {
	// Required permissions for commands
	COMMAND_PERMISSIONS: {
		CREATE_CTF: PermissionFlagsBits.ManageChannels,
		SCHEDULE_EVENT: PermissionFlagsBits.ManageEvents,
		DELETE_CTF: PermissionFlagsBits.ManageChannels
	},

	// Permission names for user-facing messages
	PERMISSION_NAMES: {
		[PermissionFlagsBits.ManageChannels]: 'Manage Channels',
		[PermissionFlagsBits.ManageEvents]: 'Manage Events',
		[PermissionFlagsBits.Administrator]: 'Administrator'
	}
};
