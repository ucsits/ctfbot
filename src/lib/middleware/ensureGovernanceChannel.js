/**
 * Middleware to restrict governance commands (task, document) to
 * specific channel categories.
 * @module middleware/ensureGovernanceChannel
 */

const constants = require('../constants/config');
const { CTFBotError } = require('../errors');

class GovernanceChannelError extends CTFBotError {
	constructor(message) {
		super(message);
	}
}

function ensureGovernanceChannel(interaction) {
	const channel = interaction.channel;

	if (!channel) {
		throw new GovernanceChannelError('❌ This command can only be used in a guild channel.');
	}

	if (!constants.GOVERNANCE_CATEGORIES.includes(channel.parentId)) {
		throw new GovernanceChannelError(
			'❌ This command is not available in this channel category.'
		);
	}

	return channel;
}

async function ensureGovernanceChannelReply(interaction) {
	try {
		ensureGovernanceChannel(interaction);
		return false;
	} catch (error) {
		if (error instanceof GovernanceChannelError) {
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
	ensureGovernanceChannel,
	ensureGovernanceChannelReply,
	GovernanceChannelError
};
