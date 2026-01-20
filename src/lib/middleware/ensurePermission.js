const { PermissionFlagsBits } = require('discord.js');
const { CTFBotError } = require('../errors');

class PermissionError extends CTFBotError {
	constructor(message) {
		super(message);
	}
}

function checkPermission(interaction, permission, permissionName) {
	if (!interaction.member) {
		throw new PermissionError('❌ This command can only be used in a guild.');
	}

	if (!interaction.member.permissions.has(permission)) {
		throw new PermissionError(`❌ You need the "${permissionName}" permission to use this command.`);
	}

	return true;
}

async function checkPermissionReply(interaction, permission, permissionName) {
	try {
		checkPermission(interaction, permission, permissionName);
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
