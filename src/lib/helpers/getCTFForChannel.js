const { ctfOperations } = require('../../database');
const { CTFBotError } = require('../errors');

class CTFNotFoundError extends CTFBotError {
	constructor(message) {
		super(message);
	}
}

function getCTFForChannel(channelId) {
	const ctf = ctfOperations.getCTFByChannelId(channelId);

	if (!ctf) {
		throw new CTFNotFoundError('❌ This channel is not registered as a CTF channel in the database.');
	}

	return ctf;
}

async function getCTFForChannelReply(interaction) {
	try {
		const channelId = interaction.channel?.id;
		if (!channelId) {
			throw new CTFNotFoundError('❌ This command must be used in a text channel.');
		}

		const ctf = getCTFForChannel(channelId);
		return { ctf, cancelled: false };
	} catch (error) {
		if (error instanceof CTFNotFoundError) {
			await interaction.editReply(error.message);
			return { ctf: null, cancelled: true };
		}
		throw error;
	}
}

module.exports = {
	getCTFForChannel,
	getCTFForChannelReply,
	CTFNotFoundError
};
