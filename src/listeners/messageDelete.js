const { Listener } = require('@sapphire/framework');
const taskSuggest = require('../services/taskSuggest');

/**
 * Keep deleted messages out of the task suggestion model's view, which
 * covers the buffered chat, the suggestion cards and the notes learned from
 * them. Works for uncached (partial) messages too, since only the ids are
 * needed.
 */
class MessageDeleteListener extends Listener {
	constructor(context, options) {
		super(context, {
			...options,
			event: 'messageDelete'
		});
	}

	run(message) {
		try {
			taskSuggest.forgetMessage(message.channelId, message.id);
		} catch (error) {
			this.container.logger.error('Error forgetting deleted message for task suggestions', error);
		}
	}
}

module.exports = { MessageDeleteListener };
