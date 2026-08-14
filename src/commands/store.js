const { Command } = require('@sapphire/framework');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { activityRepository } = require('../database');
const { getIdHints } = require('../lib/utils');

// Custom ID namespaces used by the store's interactive buy flow.
const STORE_IDS = {
	buy: 'ap_store_buy',       // ap_store_buy:<slug>
	payAp: 'ap_store_pay_ap',  // ap_store_pay_ap:<slug>
	payRp: 'ap_store_pay_rp'   // ap_store_pay_rp:<slug>
};

class StoreCommand extends Command {
	constructor(context, options) {
		super(context, {
			...options,
			name: 'store',
			description: 'Browse and buy merchandise with activity points or Rp'
		});
	}

	registerApplicationCommands(registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription(this.description)
				.addSubcommand(sub =>
					sub
						.setName('view')
						.setDescription('Browse the store')
				)
				.addSubcommand(sub =>
					sub
						.setName('confirm')
						.setDescription('Confirm a pending RP purchase (admin only)')
						.addStringOption(opt =>
							opt
								.setName('purchase_id')
								.setDescription('The purchase ID to confirm')
								.setRequired(true)
						)
				),
		{
			idHints: getIdHints(this.name)
		}
		);
	}

	async chatInputRun(interaction) {
		const sub = interaction.options.getSubcommand();
		if (sub === 'confirm') {
			return this._confirm(interaction);
		}
		return this._view(interaction);
	}

	async _view(interaction) {
		await interaction.deferReply();

		try {
			const items = activityRepository.getStoreItems();

			const embed = new EmbedBuilder()
				.setColor(0x00E5FF)
				.setTitle('🛍️ Activity Merchandise Store')
				.setTimestamp();

			const lines = items.map((item, i) =>
				`**${i + 1}. ${item.name}**\n` +
				`💰 ${item.ap_price} AP · 💵 Rp ${item.rp_price.toLocaleString('id-ID')}\n`
			);
			embed.setDescription(
				'Spend your activity points (AP) or pay with Rp.\nChoose an item below to buy it.\n\n' +
				lines.join('\n')
			);

			const row = new ActionRowBuilder().addComponents(
				items.map(item =>
					new ButtonBuilder()
						.setCustomId(`${STORE_IDS.buy}:${item.slug}`)
						.setLabel(`Buy ${item.name}`)
						.setStyle(ButtonStyle.Primary)
				)
			);

			return interaction.editReply({ embeds: [embed], components: [row] });
		} catch (error) {
			this.container.logger.error('Error showing store:', error);
			return interaction.editReply('❌ Failed to load the store.');
		}
	}

	async _confirm(interaction) {
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

			// 2. DB
			activityRepository.confirmPurchase({
				id: purchaseId,
				confirmedBy: interaction.user.id,
				blockHeight: block.height
			});

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
			return interaction.editReply('❌ Failed to confirm purchase. Blockchain error: ' + error.message);
		}
	}
}

module.exports = {
	StoreCommand,
	STORE_IDS
};
