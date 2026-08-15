const { Listener } = require('@sapphire/framework');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { randomUUID } = require('crypto');
const { activityRepository } = require('../database');
const luce = require('../lib/luce');
const { STORE_IDS } = require('../commands/store');
const storeLayout = require('../lib/store');

// Cache gallery posters per item slug so repeated buys don't re-compose.
const galleryCache = new Map();

async function galleryPosterFor(item) {
	const key = item.slug;
	if (galleryCache.has(key)) {
		return galleryCache.get(key);
	}
	const photos = storeLayout.getStoreGallery(item.slug);
	const poster = await storeLayout.renderGalleryPoster(item, photos);
	galleryCache.set(key, poster);
	return poster;
}

/**
 * Listen for store button interactions and drive the AP/Rp purchase flow.
 * Steps:
 *   Buy <item> → choose Pay with AP / Pay with Rp → execute and confirm.
 */
class StoreInteractionListener extends Listener {
	constructor(context, options) {
		super(context, {
			...options,
			event: 'interactionCreate',
			name: 'store-interaction-handler'
		});
	}

	async run(interaction) {
		if (!interaction.isButton()) {
			return;
		}

		const [namespace, slug] = interaction.customId.split(':');

		if (!slug) {
			return;
		}

		if (namespace === STORE_IDS.buy) {
			return this._choosePayment(interaction, slug);
		}
		if (namespace === STORE_IDS.payAp) {
			return this._buyWithAp(interaction, slug);
		}
		if (namespace === STORE_IDS.payRp) {
			return this._buyWithRp(interaction, slug);
		}
	}

	/**
	 * After "Buy <item>", show AP vs Rp choice buttons.
	 */
	async _choosePayment(interaction, slug) {
		const item = activityRepository.getStoreItemBySlug(slug);
		if (!item) {
			return interaction.reply({ content: '❌ That item is no longer available.', ephemeral: true });
		}

		const row = new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`${STORE_IDS.payAp}:${item.slug}`)
				.setLabel(`Pay with ${item.ap_price} AP`)
				.setStyle(ButtonStyle.Success),
			new ButtonBuilder()
				.setCustomId(`${STORE_IDS.payRp}:${item.slug}`)
				.setLabel(`Pay with Rp ${item.rp_price.toLocaleString('id-ID')}`)
				.setStyle(ButtonStyle.Secondary)
		);

		const embed = new EmbedBuilder()
			.setColor(0x00e5ff)
			.setTitle(`🛍️ Buy ${item.name}`)
			.setDescription(`How would you like to pay for **${item.name}**?`)
			.addFields(
				{ name: 'Activity Points', value: `**${item.ap_price} AP**`, inline: true },
				{ name: 'Rp (offline)', value: `**Rp ${item.rp_price.toLocaleString('id-ID')}**`, inline: true }
			);

		// Show the composed gallery poster inside the payment-choice embed too,
		// so the buyer sees the item before picking a payment method.
		const hero = await galleryPosterFor(item);
		embed.setImage('attachment://gallery.png');

		return interaction.reply({
			embeds: [embed],
			components: [row],
			ephemeral: true,
			files: [{ name: 'gallery.png', attachment: hero }]
		});
	}

	/**
	 * Pay with AP: deduct balance, complete immediately, anchor a block.
	 */
	async _buyWithAp(interaction, slug) {
		await interaction.deferReply({ ephemeral: true });

		const item = activityRepository.getStoreItemBySlug(slug);
		if (!item) {
			return interaction.editReply('❌ That item is no longer available.');
		}

		const balance = activityRepository.getBalance(interaction.user.id);
		if (balance < item.ap_price) {
			return interaction.editReply(
				`❌ You need **${item.ap_price} AP** but you only have **${balance} AP**. Earn more activity points first!`
			);
		}

		try {
			const purchaseId = randomUUID();

			// 1. Blockchain
			const data = JSON.stringify({
				type: 'ap_purchase',
				v: 1,
				user: interaction.user.id,
				itemName: item.name,
				paymentMethod: 'ap',
				costAp: item.ap_price,
				status: 'completed'
			});
			const block = await luce.appendBlock({ author: interaction.user.id, data });

			// 2. DB — spend the points and record the completed purchase atomically
			const newBalance = activityRepository.completeApPurchase({
				purchaseId,
				userId: interaction.user.id,
				itemId: item.id,
				apCost: item.ap_price,
				blockHeight: block.height
			});

			if (newBalance === null) {
				return interaction.editReply('❌ Insufficient activity points.');
			}

			const embed = new EmbedBuilder()
				.setColor(0x00ff00)
				.setTitle('✅ Purchase Complete!')
				.setDescription(`You bought **${item.name}** with **${item.ap_price} AP**!`)
				.addFields(
					{ name: 'Item', value: item.name, inline: true },
					{ name: 'Cost', value: `${item.ap_price} AP`, inline: true },
					{ name: 'Remaining Balance', value: `**${newBalance} AP**`, inline: true },
					{ name: 'Block Height', value: `#${block.height}`, inline: true },
					{ name: 'Purchase ID', value: `\`${purchaseId}\``, inline: false }
				)
				.setTimestamp();

			// Gallery poster composed from all photos of the item, inside the embed.
			const poster = await galleryPosterFor(item);
			embed.setImage('attachment://gallery.png');

			return interaction.editReply({ embeds: [embed], files: [{ name: 'gallery.png', attachment: poster }] });
		} catch (error) {
			this.container.logger.error('Error buying with AP:', error);
			return interaction.editReply('❌ Purchase failed. Blockchain error: ' + error.message);
		}
	}

	/**
	 * Pay with Rp: create a pending purchase (payment is offline), anchor a block.
	 * An admin later runs /store-confirm to finalize it.
	 */
	async _buyWithRp(interaction, slug) {
		await interaction.deferReply({ ephemeral: true });

		const item = activityRepository.getStoreItemBySlug(slug);
		if (!item) {
			return interaction.editReply('❌ That item is no longer available.');
		}

		try {
			const purchaseId = randomUUID();

			// 1. Blockchain
			const data = JSON.stringify({
				type: 'ap_purchase',
				v: 1,
				user: interaction.user.id,
				itemName: item.name,
				paymentMethod: 'rp',
				costRp: item.rp_price,
				status: 'pending'
			});
			const block = await luce.appendBlock({ author: interaction.user.id, data });

			// 2. DB — create pending purchase
			activityRepository.createPurchase({
				id: purchaseId,
				userId: interaction.user.id,
				itemId: item.id,
				paymentMethod: 'rp',
				status: 'pending',
				costAp: 0,
				costRp: item.rp_price,
				blockHeight: block.height
			});

			const embed = new EmbedBuilder()
				.setColor(0xffaa00)
				.setTitle('⏳ Purchase Requested')
				.setDescription(`You requested **${item.name}** for **Rp ${item.rp_price.toLocaleString('id-ID')}**.`)
				.addFields(
					{ name: 'Item', value: item.name, inline: true },
					{ name: 'Cost', value: `Rp ${item.rp_price.toLocaleString('id-ID')}`, inline: true },
					{ name: 'Status', value: 'Pending payment', inline: true },
					{ name: 'Block Height', value: `#${block.height}`, inline: true },
					{ name: 'Purchase ID', value: `\`${purchaseId}\``, inline: false }
				)
				.setTimestamp();

			// Gallery poster composed from all photos of the item, inside the embed.
			const poster = await galleryPosterFor(item);
			embed.setImage('attachment://gallery.png');

			// Tell user to complete payment offline and share the ID with an admin.
			return interaction.editReply({
				content:
					'Pay an admin **Rp ' +
					item.rp_price.toLocaleString('id-ID') +
					'** offline, then give them this **Purchase ID** to confirm: `' +
					purchaseId +
					'`',
				embeds: [embed],
				files: [{ name: 'gallery.png', attachment: poster }]
			});
		} catch (error) {
			this.container.logger.error('Error buying with Rp:', error);
			return interaction.editReply('❌ Purchase failed. Blockchain error: ' + error.message);
		}
	}
}

module.exports = { StoreInteractionListener };
