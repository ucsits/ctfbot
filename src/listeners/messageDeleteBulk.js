const { Listener } = require('@sapphire/framework');
const taskSuggest = require('../services/taskSuggest');

/**
 * Same as messageDelete, for messages removed together (e.g. a purge).
 */
class MessageDeleteBulkListener extends Listener {
	constructor(context, options) {
		super(context, {
			...options,
			event: 'messageDeleteBulk'
		});
	}

	run(messages, channel) {
		for (const id of messages.keys()) {
			try {
				taskSuggest.forgetMessage(channel.id, id);
			} catch (error) {
				this.container.logger.error('Error forgetting deleted message for task suggestions:', error);
			}
		}
	}
}

module.exports = { MessageDeleteBulkListener };
