const { EmbedBuilder } = require('discord.js');

const COLORS = {
	SUCCESS: 0x00FF00,
	ERROR: 0xFF0000,
	INFO: 0x0099FF,
	WARNING: 0xFFAA00,
	PRIMARY: 0x0099FF
};

function createBaseEmbed() {
	return new EmbedBuilder().setTimestamp();
}

function createSuccessEmbed(title, description, fields = []) {
	const embed = createBaseEmbed()
		.setColor(COLORS.SUCCESS)
		.setTitle(`✅ ${title}`);

	if (description) {
		embed.setDescription(description);
	}

	if (fields.length > 0) {
		embed.addFields(fields);
	}

	return embed;
}

function createErrorEmbed(title, description, fields = []) {
	const embed = createBaseEmbed()
		.setColor(COLORS.ERROR)
		.setTitle(`❌ ${title}`);

	if (description) {
		embed.setDescription(description);
	}

	if (fields.length > 0) {
		embed.addFields(fields);
	}

	return embed;
}

function createInfoEmbed(title, description, fields = []) {
	const embed = createBaseEmbed()
		.setColor(COLORS.INFO)
		.setTitle(`ℹ️ ${title}`);

	if (description) {
		embed.setDescription(description);
	}

	if (fields.length > 0) {
		embed.addFields(fields);
	}

	return embed;
}

function createWarningEmbed(title, description, fields = []) {
	const embed = createBaseEmbed()
		.setColor(COLORS.WARNING)
		.setTitle(`⚠️ ${title}`);

	if (description) {
		embed.setDescription(description);
	}

	if (fields.length > 0) {
		embed.addFields(fields);
	}

	return embed;
}

module.exports = {
	createBaseEmbed,
	createSuccessEmbed,
	createErrorEmbed,
	createInfoEmbed,
	createWarningEmbed,
	COLORS
};
