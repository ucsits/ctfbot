const { Listener } = require('@sapphire/framework');

class MessageCreateListener extends Listener {
	constructor(context, options) {
		super(context, {
			...options,
			event: 'messageCreate'
		});
	}

	run(message) {
		if (message.author.bot) {
			return;
		}

		this.container.logger.debug(`${message.author.tag}: ${message.content}`);
	}
}

module.exports = { MessageCreateListener };
