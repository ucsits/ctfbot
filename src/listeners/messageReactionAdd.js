const { Listener } = require('@sapphire/framework');
const { awardReputation } = require('../services/reputation');
const chat = require('../services/chat');

const THUMBS_UP = '👍';
const THUMBS_DOWN = '👎';
// Reacting to one of the bot's messages with this mutes proactive chat in the
// channel until the next local midnight.
const MUTE = '🔇';

class MessageReactionAddListener extends Listener {
	constructor(context, options) {
		super(context, {
			...options,
			event: 'messageReactionAdd'
		});
	}

	async run(partialReaction, partialUser) {
		// Ignore bot reactions
		if (partialUser.bot) {
			return;
		}

		const emoji = partialReaction.emoji.name;
		if (emoji !== THUMBS_UP && emoji !== THUMBS_DOWN && emoji !== MUTE) {
			return;
		}

		let reaction;
		let user;
		let message;
		try {
			reaction = partialReaction.partial ? await partialReaction.fetch() : partialReaction;
			user = partialUser.partial ? await partialUser.fetch() : partialUser;
			message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
		} catch (error) {
			this.container.logger.debug(`Could not resolve reaction: ${error.message}`);
			return;
		}

		// Reactions on the bot's own messages drive proactive chat: 🔇 mutes the
		// channel, anything else tells the bot the channel is paying attention.
		if (message.author?.bot) {
			try {
				if (emoji === MUTE) {
					await chat.muteChannel(message.channelId, { by: user.id });
					await message.react('✅').catch(() => {});
				} else {
					chat.noteEngaged(message.channelId);
				}
			} catch (error) {
				this.container.logger.error('Error handling reaction on a bot message:', error);
			}
			return;
		}

		// The rest is reputation: only 👍 and 👎 count.
		if (emoji !== THUMBS_UP && emoji !== THUMBS_DOWN) {
			return;
		}

		// Don't let users rep themselves
		if (user.id === message.author.id) {
			return;
		}

		const amount = emoji === THUMBS_UP ? 1 : -1;

		try {
			// The daily slot is claimed atomically inside awardReputation before
			// the chain write, so a second reaction from the same user cannot
			// also append a block. 'already-given' is ignored silently here.
			await awardReputation({
				toUser: message.author.id,
				fromUser: user.id,
				amount,
				reason: 'reaction',
				toTag: message.author.tag,
				fromTag: user.tag
			});
		} catch (error) {
			this.container.logger.error('Error processing rep reaction:', error);
		}
	}
}

module.exports = { MessageReactionAddListener };
