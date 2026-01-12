function formatError(error) {
	if (error && error.message) {
		return error.message;
	}
	return '❌ An unknown error occurred. Please try again later.';
}

async function handleCommandError(interaction, error, context = 'command') {
	const logger = interaction?.client?.logger || console;

	logger.error(`Error in ${context}:`, error);

	const errorMessage = formatError(error);
	const isReplied = interaction.replied || interaction.deferred;

	try {
		if (isReplied) {
			return await interaction.editReply(errorMessage);
		}
		return await interaction.reply(errorMessage);
	} catch (replyError) {
		logger.error('Failed to reply to user:', replyError);
	}
}

function isKnownError(error) {
	const errorNames = [
		'ConfigurationError',
		'CTFChannelError',
		'PermissionError',
		'CTFNotFoundError',
		'ValidationError',
		'DatabaseError',
		'ExternalAPIError'
	];

	return errorNames.includes(error.name);
}

module.exports = {
	formatError,
	handleCommandError,
	isKnownError
};
