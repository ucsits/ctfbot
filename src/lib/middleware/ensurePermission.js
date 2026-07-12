const { PermissionFlagsBits } = require('discord.js');
const { CTFBotError } = require('../errors');
const { isAdmin } = require('./ensureAdmin');
const constants = require('../constants/config');

class PermissionError extends CTFBotError {
	constructor(message) {
		super(message);
	}
}

async function checkPermission(interaction, permission, permissionName) {
	if (!interaction.member) {
		throw new PermissionError('This command can only be used in a guild.');
	}

	const isAdminUser = await isAdmin(interaction.user.id);

	if (isAdminUser) {
		return true;
	}

	// Bypass permission check if user is in a governance category channel
	const channel = interaction.channel;
	if (channel && constants.GOVERNANCE_CATEGORIES.includes(channel.parentId)) {
		return true;
	}

	if (!interaction.member.permissions.has(permission)) {
		throw new PermissionError(`You need the "${permissionName}" permission to use this command.`);
	}

	return true;
}

async function checkPermissionReply(interaction, permission, permissionName) {
	try {
		await checkPermission(interaction, permission, permissionName);
		return false;
	} catch (error) {
		if (error instanceof PermissionError) {
			await interaction.reply({
				content: error.message,
				ephemeral: true
			});
			return true;
		}
		throw error;
	}
}

module.exports = {
	checkPermission,
	checkPermissionReply,
	PermissionError,
	PermissionFlagsBits
};
