const config = require('../../config');
const { CTFBotError } = require('../errors');

class CTFChannelError extends CTFBotError {
	constructor(message) {
		super(message);
	}
}

function ensureCTFChannel(interaction) {
	const channel = interaction.channel;

	if (!channel) {
		throw new CTFChannelError('❌ This command can only be used in a guild channel.');
	}

	if (channel.parentId !== config.ctf.categoryId) {
		throw new CTFChannelError('❌ This command can only be used in CTF channels (channels within the CTF category).');
	}

	return channel;
}

async function ensureCTFChannelReply(interaction) {
	try {
		ensureCTFChannel(interaction);
		return false;
	} catch (error) {
		if (error instanceof CTFChannelError) {
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
	ensureCTFChannel,
	ensureCTFChannelReply,
	CTFChannelError
};
