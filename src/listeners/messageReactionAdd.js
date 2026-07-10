const { Listener } = require('@sapphire/framework');
const reputationRepository = require('../database/repositories/reputation.repository');
const luce = require('../lib/luce');

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

		// Daily limit check
		if (reputationRepository.hasGivenRepToday(user.id)) {
			// Silently ignore — the user already used rep today
			return;
		}

		const amount = emoji === THUMBS_UP ? 1 : -1;

		try {
			const data = JSON.stringify({
				type: 'rep',
				v: 1,
				toUser: reaction.message.author.id,
				fromUser: user.id,
				amount,
				reason: 'reaction',
				date: new Date().toISOString().slice(0, 10)
			});

			const block = await luce.appendBlock({
				author: user.id,
				data
			});

			reputationRepository.addReputation({
				userId: reaction.message.author.id,
				fromUser: user.id,
				amount,
				reason: 'reaction',
				blockHeight: block.height
			});

			this.container.logger.info(
				`Rep ${amount > 0 ? '+' : ''}${amount} from ${user.tag} to ${reaction.message.author.tag} (reaction) — block #${block.height}`
			);
		} catch (error) {
			this.container.logger.error('Error processing rep reaction:', error);
		}
	}
}

module.exports = { MessageReactionAddListener };
