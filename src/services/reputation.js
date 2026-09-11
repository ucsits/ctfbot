/**
 * Reputation service
 *
 * Awards the once-per-day reputation point (or deduction) from one user to
 * another and anchors it on the Luce blockchain.
 *
 * The daily slot is claimed in the database BEFORE the block is appended, so
 * two concurrent reactions or replies can never both spend the same day. That
 * ordering is the whole point: previously each listener ran a
 * `hasGivenRepToday` read, then awaited the chain write, then inserted, and two
 * near-simultaneous events both passed the read, producing two blocks while the
 * `UNIQUE(from_user, date)` index silently dropped the second row.
 *
 * @module services/reputation
 */

const reputationRepository = require('../database/repositories/reputation.repository');
const luce = require('../lib/luce');
const { logger } = require('../lib/logger');

const repLog = logger.child('Rep');

/**
 * Award a reputation point, atomically enforcing the once-per-day rule.
 *
 * @param {object} params
 * @param {string} params.toUser - recipient Discord user ID
 * @param {string} params.fromUser - giver Discord user ID
 * @param {number} params.amount - 1 or -1
 * @param {string} params.reason - 'reaction' or 'reply'
 * @param {string} [params.toTag] - recipient tag, for logging only
 * @param {string} [params.fromTag] - giver tag, for logging only
 * @param {Function} [params.appendBlock] - blockchain writer (injectable for tests)
 * @param {object} [params.repository] - reputation repository (injectable for tests)
 * @returns {Promise<'awarded'|'already-given'|'failed'>}
 *   'already-given' when the giver already spent rep today, 'failed' when the
 *   claim was released because the blockchain append threw
 */
async function awardReputation({
	toUser,
	fromUser,
	amount,
	reason,
	toTag,
	fromTag,
	appendBlock = params => luce.appendBlock(params),
	repository = reputationRepository
}) {
	const { claimed, date } = repository.claimDailyReputation({
		userId: toUser,
		fromUser,
		amount,
		reason
	});

	if (!claimed) {
		return 'already-given';
	}

	try {
		const data = JSON.stringify({
			type: 'rep',
			v: 1,
			toUser,
			fromUser,
			amount,
			reason,
			date
		});

		const block = await appendBlock({ author: fromUser, data });

		repository.finalizeReputationBlock({ fromUser, date, blockHeight: block.height });

		repLog.info(
			`Rep ${amount > 0 ? '+' : ''}${amount} from ${fromTag || fromUser} to ${toTag || toUser} (${reason}) - block #${block.height}`
		);

		return 'awarded';
	} catch (error) {
		// Nothing reached the chain, so hand the day back for a retry.
		repository.releaseReputationClaim({ fromUser, date });
		repLog.error(`Failed to anchor rep from ${fromTag || fromUser}: ${error.message}`);
		return 'failed';
	}
}

module.exports = { awardReputation };
