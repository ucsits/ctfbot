const { EmbedBuilder } = require('discord.js');

async function sendResponse(interaction, embed, options = {}) {
	const { ephemeral = false, defer = true } = options;

	if (defer) {
		await interaction.deferReply({ ephemeral });
		return interaction.editReply({ embeds: [embed] });
	}

	return interaction.reply({ embeds: [embed], ephemeral });
}

async function sendErrorResponse(interaction, message, options = {}) {
	const { ephemeral = true, defer = false } = options;

	const embed = new EmbedBuilder()
		.setColor(0xFF0000)
		.setTitle('❌ Error')
		.setDescription(message)
		.setTimestamp();

	if (defer) {
		await interaction.deferReply({ ephemeral });
		return interaction.editReply({ embeds: [embed] });
	}

	return interaction.reply({ embeds: [embed], ephemeral });
}

async function sendSuccessResponse(interaction, title, description, options = {}) {
	const { ephemeral = false, defer = true, fields = [] } = options;

	const embed = new EmbedBuilder()
		.setColor(0x00FF00)
		.setTitle(`✅ ${title}`)
		.setDescription(description)
		.setTimestamp();

	if (fields.length > 0) {
		embed.addFields(fields);
	}

	return sendResponse(interaction, embed, { ephemeral, defer });
}

module.exports = {
	sendResponse,
	sendErrorResponse,
	sendSuccessResponse
};
