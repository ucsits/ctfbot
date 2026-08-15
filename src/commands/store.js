const { Command } = require('@sapphire/framework');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { activityRepository } = require('../database');
const { getIdHints } = require('../lib/utils');
const { renderCatalogImage } = require('../lib/store');

// Custom ID namespaces used by the store's interactive buy flow.
const STORE_IDS = {
	buy: 'ap_store_buy', // ap_store_buy:<slug>
	payAp: 'ap_store_pay_ap', // ap_store_pay_ap:<slug>
	payRp: 'ap_store_pay_rp' // ap_store_pay_rp:<slug>
};

// Local product imagery served by the bot, keyed by store slug.
// Each entry maps to a file under assets/store/<slug>/.
const STORE_IMAGES = {
	jacket: {
		hero: 'Screenshot_20260815_093409.png',
		gallery: ['Screenshot_20260815_093409.png', 'Screenshot_20260815_093421.png', 'Screenshot_20260815_093429.png']
	}
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
		registry.registerChatInputCommand(
			builder =>
				builder
					.setName(this.name)
					.setDescription(this.description)
					// No subcommands: bare /store shows the catalog directly.
					// The admin-only confirmation lives in its own /store-confirm command
					// because Discord does not allow invoking a container command that
					// has subcommands.
					.addStringOption(opt =>
						opt
							.setName('action')
							.setDescription('Browse the store')
							.addChoices({ name: 'Browse', value: 'view' })
					),
			{
				idHints: getIdHints(this.name)
			}
		);
	}

	async chatInputRun(interaction) {
		const action = interaction.options.getString('action');
		// Bare /store (no option) = view. Also accept explicit "view".
		if (!action || action === 'view') {
			return this._view(interaction);
		}
		return this._view(interaction);
	}

	async _view(interaction) {
		await interaction.deferReply();

		try {
			const items = activityRepository.getStoreItems();

			// Linear one-line-per-item listing, emojis kept:
			// `1. Sticker (💰 10 AP / 💵 Rp 1.000)`
			const lines = items.map(
				(item, i) =>
					`**${i + 1}. ${item.name}** (💰 ${item.ap_price} AP / 💵 Rp ${item.rp_price.toLocaleString('id-ID')})`
			);

			const embed = new EmbedBuilder()
				.setColor(0x00e5ff)
				.setTitle('🛍️ Activity Merchandise Store')
				.setDescription(
					'Spend your activity points (AP) or pay with Rp.\nChoose an item below to buy it.\n\n' +
						lines.join('\n')
				)
				.setTimestamp();

			// Compose a single combined image (silhouettes of every item, or a
			// card grid fallback) and show it *inside* the embed.
			const poster = await renderCatalogImage(items);
			embed.setImage('attachment://catalog.png');

			const row = new ActionRowBuilder().addComponents(
				items.map(item =>
					new ButtonBuilder()
						.setCustomId(`${STORE_IDS.buy}:${item.slug}`)
						.setLabel(`Buy ${item.name}`)
						.setStyle(ButtonStyle.Primary)
				)
			);

			return interaction.editReply({
				embeds: [embed],
				components: [row],
				files: [{ name: 'catalog.png', attachment: poster }]
			});
		} catch (error) {
			this.container.logger.error('Error showing store:', error);
			return interaction.editReply('❌ Failed to load the store.');
		}
	}
}

module.exports = {
	StoreCommand,
	STORE_IDS,
	STORE_IMAGES
};
