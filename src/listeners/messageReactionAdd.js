const { Listener } = require('@sapphire/framework');
const { awardReputation } = require('../services/reputation');

const THUMBS_UP = '👍';
const THUMBS_DOWN = '👎';

class MessageReactionAddListener extends Listener {
	constructor(context, options) {
		super(context, {
			...options,
			event: 'messageReactionAdd'
		});
	}

	async run(partialReaction, partialUser) {
		// Ignore bot reactions
		if (partialUser.bot) return;

		// Only handle 👍 or 👎
		const emoji = partialReaction.emoji.name;
		if (emoji !== THUMBS_UP && emoji !== THUMBS_DOWN) return;

		// Fetch full reaction and user objects
		const reaction = partialReaction.partial ? await partialReaction.fetch() : partialReaction;
		const user = partialUser.partial ? await partialUser.fetch() : partialUser;

		// Don't let users rep themselves
		if (user.id === reaction.message.author.id) return;

		// Don't let users rep bots
		if (reaction.message.author.bot) return;

		const amount = emoji === THUMBS_UP ? 1 : -1;

		try {
			// The daily slot is claimed atomically inside awardReputation before
			// the chain write, so a second reaction from the same user cannot
			// also append a block. 'already-given' is ignored silently here.
			await awardReputation({
				toUser: reaction.message.author.id,
				fromUser: user.id,
				amount,
				reason: 'reaction',
				toTag: reaction.message.author.tag,
				fromTag: user.tag
			});
		} catch (error) {
			this.container.logger.error('Error processing rep reaction:', error);
		}
	}
}

module.exports = { MessageReactionAddListener };
