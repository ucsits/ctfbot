const { Listener } = require('@sapphire/framework');
const { awardReputation } = require('../services/reputation');

// Patterns that trigger +1 or -1 when used as a reply
const UP_PATTERNS = /^(?:\+1|👍)$/;
const DOWN_PATTERNS = /^(?:\-1|👎)$/;

class MessageCreateListener extends Listener {
	constructor(context, options) {
		super(context, {
			...options,
			event: 'messageCreate'
		});
	}

	async run(message) {
		if (message.author.bot) return;

		this.container.logger.debug(`${message.author.tag}: ${message.content}`);

		// Reply-based rep detection:
		// check if this message is a reply and matches +1/-1/👍/👎
		if (message.reference?.messageId) {
			const trimmed = message.content.trim();
			let amount = null;

			if (UP_PATTERNS.test(trimmed)) amount = 1;
			else if (DOWN_PATTERNS.test(trimmed)) amount = -1;

			if (amount !== null) {
				await this._handleReplyRep(message, amount);
			}
		}
	}

	async _handleReplyRep(message, amount) {
		try {
			const repliedTo = await message.channel.messages.fetch(message.reference.messageId);

			// Guard: no self-rep, no bot-rep
			if (repliedTo.author.bot) return;
			if (repliedTo.author.id === message.author.id) return;

			// The daily slot is claimed atomically inside awardReputation before
			// the chain write, so two rapid replies cannot both append a block.
			const status = await awardReputation({
				toUser: repliedTo.author.id,
				fromUser: message.author.id,
				amount,
				reason: 'reply',
				toTag: repliedTo.author.tag,
				fromTag: message.author.tag
			});

			if (status === 'awarded') {
				// Confirm with a ✅ reaction
				await message.react('✅').catch(() => {});
				return;
			}

			// 'already-given' or 'failed': signal that nothing was recorded.
			await message.react('❌').catch(() => {});
		} catch (error) {
			this.container.logger.error('Error processing reply rep:', error);
			await message.react('❌').catch(() => {});
		}
	}
}

module.exports = { MessageCreateListener };
