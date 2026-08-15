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

// Local product imagery served by the bot, keyed by store slug.
// Each entry maps to a file under assets/store/<slug>/.
const STORE_ASSET_DIR = require('path').join(__dirname, '..', '..', 'assets', 'store');
const STORE_IMAGES = {
	jacket: {
		hero: 'Screenshot_20260815_093409.png',
		gallery: [
			'Screenshot_20260815_093409.png',
			'Screenshot_20260815_093421.png',
			'Screenshot_20260815_093429.png'
		]
	}
};

/**
 * Resolve the local file path for a store item's hero image.
 * @param {string} slug
 * @returns {string|undefined} absolute path, or undefined when the slug has none
 */
function getStoreHeroImage(slug) {
	const entry = STORE_IMAGES[slug];
	if (!entry) {
		return undefined;
	}
	return require('path').join(STORE_ASSET_DIR, slug, entry.hero);
}

/**
 * Resolve the local file paths for a store item's full gallery.
 * @param {string} slug
 * @returns {Array<string>} absolute paths (empty when the item has none)
 */
function getStoreGallery(slug) {
	const entry = STORE_IMAGES[slug];
	if (!entry) {
		return [];
	}
	return entry.gallery.map(file => require('path').join(STORE_ASSET_DIR, slug, file));
}


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

			const embed = new EmbedBuilder()
				.setColor(0x00E5FF)
				.setTitle('🛍️ Activity Merchandise Store')
				.setTimestamp();

			// Attach product imagery (hero thumbnails) so the listing is visual.
			const imagePaths = items.map(item => getStoreHeroImage(item.slug)).filter(Boolean);
			const heroAttachments = imagePaths.map(path => ({
				name: require('path').basename(path),
				attachment: path
			}));

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

			return interaction.editReply({ embeds: [embed], components: [row], files: heroAttachments });
		} catch (error) {
			this.container.logger.error('Error showing store:', error);
			return interaction.editReply('❌ Failed to load the store.');
		}
	}
}

module.exports = {
	StoreCommand,
	STORE_IDS,
	getStoreHeroImage,
	getStoreGallery
};
