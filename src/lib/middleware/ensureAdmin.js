const config = require('../../config');
const { adminRepository } = require('../../database');

async function isAdmin(userId) {
	if (config.admin.isEnvConfigured) {
		return config.admin.ids.includes(userId);
	}

	return adminRepository.exists(userId);
}

async function ensureAdminReply(interaction) {
	const isAdminUser = await isAdmin(interaction.user.id);

	if (!isAdminUser) {
		await interaction.reply({
			content: '❌ You do not have admin permissions.',
			ephemeral: true
		});
		return true;
	}

	return false;
}

async function ensureAdminReplyWithReason(interaction, reason = 'admin access') {
	const isAdminUser = await isAdmin(interaction.user.id);

	if (!isAdminUser) {
		await interaction.reply({
			content: `❌ You need ${reason} to use this command.`,
			ephemeral: true
		});
		return true;
	}

	return false;
}

module.exports = {
	isAdmin,
	ensureAdminReply,
	ensureAdminReplyWithReason
};
