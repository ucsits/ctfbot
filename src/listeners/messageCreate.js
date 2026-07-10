const { Listener } = require('@sapphire/framework');
const reputationRepository = require('../database/repositories/reputation.repository');
const luce = require('../lib/luce');

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

		// ── Reply-based rep detection ──
		// Check if this message is a reply and matches +1/-1/👍/👎
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

			// Daily limit check
			if (reputationRepository.hasGivenRepToday(message.author.id)) {
				// Add a ❌ reaction to the reply to signal failure
				await message.react('❌').catch(() => {});
				return;
			}

			const data = JSON.stringify({
				type: 'rep',
				v: 1,
				toUser: repliedTo.author.id,
				fromUser: message.author.id,
				amount,
				reason: 'reply',
				date: new Date().toISOString().slice(0, 10)
			});

			const block = await luce.appendBlock({
				author: message.author.id,
				data
			});

			reputationRepository.addReputation({
				userId: repliedTo.author.id,
				fromUser: message.author.id,
				amount,
				reason: 'reply',
				blockHeight: block.height
			});

			// Confirm with a ✅ reaction
			await message.react('✅').catch(() => {});

			this.container.logger.info(
				`Rep ${amount > 0 ? '+' : ''}${amount} from ${message.author.tag} to ${repliedTo.author.tag} (reply) — block #${block.height}`
			);
		} catch (error) {
			this.container.logger.error('Error processing reply rep:', error);
			await message.react('❌').catch(() => {});
		}
	}
}

module.exports = { MessageCreateListener };
