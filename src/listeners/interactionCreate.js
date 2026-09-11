const { Listener } = require('@sapphire/framework');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { randomUUID } = require('crypto');
const { activityRepository } = require('../database');
const luce = require('../lib/luce');
const { STORE_IDS } = require('../commands/store');
const storeLayout = require('../lib/store');
const { TASK_DONE_IDS, TASK_CANCEL_IDS } = require('../commands/task');
const taskRepository = require('../database/repositories/task.repository');

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

		// Task confirmation buttons (/task done & /task cancel):
		//   task_done_confirm:<taskId>[:score]     task_done_deny:<taskId>
		//   task_done_candidate:<taskId>:<score>  (picker re-render)
		//   task_cancel_confirm:<taskId>[:score]   task_cancel_deny:<taskId>
		//   task_cancel_candidate:<taskId>:<score>
		// Handled here so the confirm flow can run the same transition code
		// (_executeDone / _executeCancel) that the slash command uses.
		const taskIds = new Set([
			TASK_DONE_IDS.confirm,
			TASK_DONE_IDS.candidate,
			TASK_DONE_IDS.deny,
			TASK_CANCEL_IDS.confirm,
			TASK_CANCEL_IDS.candidate,
			TASK_CANCEL_IDS.deny
		]);
		if (taskIds.has(interaction.customId.split(':')[0])) {
			return this._handleTaskConfirm(interaction);
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
	 * Route /task done & /task cancel confirm/deny/candidate buttons.
	 *
	 * The original prompt is an ephemeral message (only the invoker can see
	 * it), but buttons on other components could in theory be re-used, so we
	 * verify the clicker is the same user who ran the command before acting.
	 * The button customId carries the initiating user id:
	 *   <namespace>:<taskId>[:<score>]:<userId>
	 */
	async _handleTaskConfirm(interaction) {
		const parts = interaction.customId.split(':');
		const namespace = parts[0];
		const taskId = parts[1];
		const score = parts[2] ? Number(parts[2]) : undefined;
		const initiatorId = parts[3];

		// Only the user who ran /task done|cancel may answer its prompt.
		if (!initiatorId || initiatorId !== interaction.user.id) {
			return interaction.reply({
				content:
					'❌ This confirmation belongs to someone else. Run `/task done` or `/task cancel` yourself to act on a task.',
				ephemeral: true
			});
		}

		// The button's customId encodes which TaskCommand instance produced it.
		// Find it via the Sapphire store so the shared transition methods run
		// on the same class instance as the slash command.
		const taskCommand = this.container.stores.get('commands').get('task');
		if (!taskCommand) {
			return interaction.reply({
				content: '❌ Task command is not loaded.',
				ephemeral: true
			});
		}

		let task;
		try {
			task = taskRepository.getTask(taskId);
		} catch (error) {
			this.container.logger.error('Task confirm: failed to load task:', error);
			return interaction.reply({ content: '❌ Failed to load the task.', ephemeral: true });
		}

		if (!task) {
			return interaction.reply({
				content: '❌ Task not found. It may have been removed.',
				ephemeral: true
			});
		}

		// ── Candidate picker: re-render a single-task confirmation for the
		// picked task. Nothing has been recorded yet. ──
		if (namespace === TASK_DONE_IDS.candidate || namespace === TASK_CANCEL_IDS.candidate) {
			const ids = namespace === TASK_DONE_IDS.candidate ? TASK_DONE_IDS : TASK_CANCEL_IDS;
			const verb = namespace === TASK_DONE_IDS.candidate ? 'Done' : 'Cancellation';
			const emoji = namespace === TASK_DONE_IDS.candidate ? '✅' : '🗑️';
			const color = namespace === TASK_DONE_IDS.candidate ? 0x00ff00 : 0xe74c3c;

			const embed = new EmbedBuilder()
				.setColor(color)
				.setTitle(`${emoji} Confirm ${verb}?`)
				.setDescription(
					`**${task.title}**\nThis will ${verb === 'Done' ? 'mark the task done' : 'cancel the task'} and record it on the blockchain.`
				)
				.addFields(
					{ name: 'Assigned To', value: `<@${task.assigned_to}>`, inline: true },
					{ name: 'Deadline', value: `<t:${task.deadline}:F>`, inline: true },
					...(typeof score === 'number' && !Number.isNaN(score)
						? [{ name: 'Match Confidence', value: `${Math.round(score * 100)}%`, inline: true }]
						: [])
				)
				.setTimestamp();
			if (task.description) {
				embed.addFields({ name: 'Description', value: task.description.slice(0, 1024), inline: false });
			}

			const row = new ActionRowBuilder().addComponents(
				new ButtonBuilder()
					.setCustomId(`${ids.confirm}:${task.task_id}:${score ?? ''}:${initiatorId}`)
					.setLabel(`Confirm ${verb}`)
					.setStyle(ButtonStyle.Success),
				new ButtonBuilder()
					.setCustomId(`${ids.deny}:${task.task_id}::${initiatorId}`)
					.setLabel('Deny')
					.setStyle(ButtonStyle.Danger)
			);

			return interaction.update({
				content: '⚠️ **Action requires confirmation.** Nothing has been recorded yet.',
				embeds: [embed],
				components: [row]
			});
		}

		// ── Deny: just close the prompt. Nothing was recorded. ──
		if (namespace === TASK_DONE_IDS.deny || namespace === TASK_CANCEL_IDS.deny) {
			return interaction.update({
				content: '✅ Action cancelled — nothing was recorded.',
				embeds: [],
				components: []
			});
		}

		// ── Confirm: execute the shared transition path. ──
		const isCancel = namespace === TASK_CANCEL_IDS.confirm;

		// Guard: never act on a task whose state changed since the prompt.
		if (task.status === 'done') {
			return interaction.update({
				content: '❌ This task is already marked as done.',
				embeds: [],
				components: []
			});
		}
		if (task.cancelled) {
			return interaction.update({
				content: '❌ This task has already been cancelled.',
				embeds: [],
				components: []
			});
		}

		const result = isCancel
			? await taskCommand._executeCancel(task, interaction)
			: await taskCommand._executeDone(task, interaction);

		// _execute* returns { content } on success or a plain string on failure.
		const content = typeof result === 'object' ? result.content : result;

		return interaction.update({
			content,
			embeds: [],
			components: []
		});
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

		// The payment buttons are one-shot: drop them as soon as this handler
		// owns the interaction so the same message cannot be clicked again.
		await interaction.message.edit({ components: [] }).catch(() => {});

		const item = activityRepository.getStoreItemBySlug(slug);
		if (!item) {
			return interaction.editReply('❌ That item is no longer available.');
		}

		const purchaseId = randomUUID();

		// 1. Reserve the points and the pending purchase row in one transaction.
		// This ordering is the fix: no block is anchored until the spend has
		// actually committed, so a rejected reservation can no longer leave an
		// orphan "completed purchase" block on the chain.
		const newBalance = activityRepository.reserveApPurchase({
			purchaseId,
			userId: interaction.user.id,
			itemId: item.id,
			apCost: item.ap_price
		});

		if (newBalance === null) {
			const balance = activityRepository.getBalance(interaction.user.id);
			return interaction.editReply(
				`❌ You need **${item.ap_price} AP** but you only have **${balance} AP**. Earn more activity points first!`
			);
		}

		try {
			// 2. Blockchain
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

			// 3. Stamp the confirmed height on the purchase and on its ledger row.
			activityRepository.finalizeApPurchase({ purchaseId, blockHeight: block.height });

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
			// Nothing usable was anchored, so hand the points back instead of
			// leaving the user debited for a purchase that never happened.
			activityRepository.releaseApPurchase({ purchaseId });
			return interaction.editReply('❌ Purchase failed. Blockchain error: ' + error.message);
		}
	}

	/**
	 * Pay with Rp: create a pending purchase (payment is offline), anchor a block.
	 * An admin later runs /store-confirm to finalize it.
	 */
	async _buyWithRp(interaction, slug) {
		await interaction.deferReply({ ephemeral: true });

		await interaction.message.edit({ components: [] }).catch(() => {});

		const item = activityRepository.getStoreItemBySlug(slug);
		if (!item) {
			return interaction.editReply('❌ That item is no longer available.');
		}

		const purchaseId = randomUUID();

		// 1. Create the pending purchase row BEFORE anchoring, so a block can
		// never exist for a purchase that was never recorded. The row is the
		// source of truth; the block is anchored against it.
		activityRepository.createPurchase({
			id: purchaseId,
			userId: interaction.user.id,
			itemId: item.id,
			paymentMethod: 'rp',
			status: 'pending',
			costAp: 0,
			costRp: item.rp_price,
			blockHeight: null
		});

		try {
			// 2. Blockchain
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

			// 3. Stamp the anchoring height onto the pending purchase.
			activityRepository.setPurchaseBlockHeight({ id: purchaseId, blockHeight: block.height });

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
			// No usable pending purchase means no phantom order: remove it.
			activityRepository.deletePendingPurchase(purchaseId);
			return interaction.editReply('❌ Purchase failed. Blockchain error: ' + error.message);
		}
	}
}

module.exports = { StoreInteractionListener };
