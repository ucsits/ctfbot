const { Command } = require('@sapphire/framework');
const { EmbedBuilder } = require('discord.js');
const { activityRepository } = require('../database');
const { getIdHints } = require('../lib/utils');

/**
 * /store-confirm <purchase_id> — admin-only command to finalize a pending
 * Rp purchase once offline payment has arrived.
 *
 * This lives as its own top-level command (rather than a subcommand of /store)
 * because Discord does not allow bare invocation of a command that has
 * subcommands — /store must stay invocable with no arguments to show the
 * catalog.
 */
class StoreConfirmCommand extends Command {
	constructor(context, options) {
		super(context, {
			...options,
			name: 'store-confirm',
			description: 'Confirm a pending Rp purchase once offline payment arrives (admin only)'
		});
	}

	registerApplicationCommands(registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription(this.description)
				.addStringOption(opt =>
					opt
						.setName('purchase_id')
						.setDescription('The purchase ID to confirm')
						.setRequired(true)
				),
		{
			idHints: getIdHints(this.name)
		}
		);
	}

	async chatInputRun(interaction) {
		const { ensureAdminReply } = require('../lib/middleware/ensureAdmin');
		const cancelled = await ensureAdminReply(interaction);
		if (cancelled) {
			return;
		}

		await interaction.deferReply();

		const purchaseId = interaction.options.getString('purchase_id');
		const purchase = activityRepository.getPurchase(purchaseId);

		if (!purchase) {
			return interaction.editReply('❌ Purchase not found.');
		}
		if (purchase.status === 'completed') {
			return interaction.editReply('❌ That purchase is already confirmed.');
		}
		if (purchase.status !== 'pending') {
			return interaction.editReply('❌ That purchase cannot be confirmed.');
		}

		// Claim the purchase BEFORE anchoring anything. Two rapid confirmations
		// (or two admins) both used to read `pending` and both appended a
		// confirmation block while only one row changed. The claim makes the
		// loser stop here, without touching the chain.
		if (
			!activityRepository.claimPurchaseConfirmation({
				id: purchaseId,
				claimedBy: interaction.user.id
			})
		) {
			return interaction.editReply(
				'⏳ That purchase is already being confirmed by another action. Please try again in a moment.'
			);
		}

		try {
			const luce = require('../lib/luce');
			// 1. Blockchain
			const data = JSON.stringify({
				type: 'ap_confirm',
				v: 1,
				user: purchase.user_id,
				confirmedBy: interaction.user.id,
				itemName: purchase.item_name,
				paymentMethod: 'rp'
			});
			const block = await luce.appendBlock({ author: interaction.user.id, data });

			// 2. DB. The conditional update is authoritative: if it reports no row
			// was changed the claim was lost or the purchase moved on, so fail
			// loudly rather than claiming a success that did not happen.
			const confirmed = activityRepository.confirmPurchase({
				id: purchaseId,
				confirmedBy: interaction.user.id,
				blockHeight: block.height
			});

			if (!confirmed) {
				this.container.logger.warn(
					`Purchase ${purchaseId} was not confirmed after block #${block.height}; state changed concurrently`
				);
				return interaction.editReply(
					'⚠️ That purchase could not be confirmed because its state changed. Check its status before retrying.'
				);
			}

			const embed = new EmbedBuilder()
				.setColor(0x2ECC71)
				.setTitle('✅ Purchase Confirmed')
				.setDescription(`**${purchase.item_name}** confirmed for <@${purchase.user_id}>`)
				.addFields(
					{ name: 'Purchase ID', value: `\`${purchaseId}\``, inline: true },
					{ name: 'Paid', value: `Rp ${purchase.cost_rp.toLocaleString('id-ID')}`, inline: true },
					{ name: 'Block Height', value: `#${block.height}`, inline: true },
					{ name: 'Confirmed by', value: interaction.user.toString(), inline: true }
				)
				.setTimestamp();

			return interaction.editReply({ embeds: [embed] });
		} catch (error) {
			this.container.logger.error('Error confirming purchase:', error);
			// Nothing usable was written, so hand the claim back for a retry.
			activityRepository.releasePurchaseConfirmation({ id: purchaseId, claimedBy: interaction.user.id });
			return interaction.editReply('❌ Failed to confirm purchase. Blockchain error: ' + error.message);
		}
	}
}

module.exports = {
	StoreConfirmCommand
};
