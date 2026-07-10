const { Command } = require('@sapphire/framework');
const { EmbedBuilder } = require('discord.js');
const { randomUUID } = require('crypto');
const documentRepository = require('../database/repositories/document.repository');
const luce = require('../lib/luce');
const { checkPermissionReply } = require('../lib/middleware/ensurePermission');
const { ensureGovernanceChannelReply } = require('../lib/middleware/ensureGovernanceChannel');
const { PermissionFlagsBits } = require('discord.js');

class DocumentCommand extends Command {
	constructor(context, options) {
		super(context, {
			...options,
			name: 'document',
			description: 'Anchoring documents to the blockchain'
		});
	}

	registerApplicationCommands(registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription(this.description)

				// ── subcommand: add ──
				.addSubcommand(sub =>
					sub
						.setName('add')
						.setDescription('Anchor a document to the blockchain')
						.addStringOption(opt =>
							opt.setName('title').setDescription('Document title').setRequired(true)
						)
						.addStringOption(opt =>
							opt.setName('content').setDescription('Document content (plain text)').setRequired(true)
						)
				)

				// ── subcommand: get ──
				.addSubcommand(sub =>
					sub
						.setName('get')
						.setDescription('Retrieve an anchored document by ID')
						.addStringOption(opt =>
							opt.setName('doc_id').setDescription('Document UUID').setRequired(true)
						)
				),
			{
				idHints: require('../lib/utils/commandIds').getIdHints('document')
			}
		);
	}

	async chatInputRun(interaction) {
		// Restrict to governance channel categories
		const cancelled = await ensureGovernanceChannelReply(interaction);
		if (cancelled) return;

		const sub = interaction.options.getSubcommand();
		if (sub === 'add') return this._add(interaction);
		if (sub === 'get') return this._get(interaction);
	}

	async _add(interaction) {
		// Require Manage Messages for adding documents
		const cancelled = await checkPermissionReply(interaction, PermissionFlagsBits.ManageMessages, 'Manage Messages');
		if (cancelled) return;

		await interaction.deferReply();

		const title = interaction.options.getString('title');
		const content = interaction.options.getString('content');
		const docId = randomUUID();

		try {
			const data = JSON.stringify({
				type: 'document',
				v: 1,
				docId,
				title,
				content,
				author: interaction.user.id,
				mimeType: 'text/plain'
			});

			const block = await luce.appendBlock({
				author: interaction.user.id,
				data
			});

			documentRepository.createDocument({
				docId,
				title,
				content,
				author: interaction.user.id,
				mimeType: 'text/plain',
				blockHeight: block.height
			});

			const embed = new EmbedBuilder()
				.setColor(0x9B59B6)
				.setTitle('📄 Document Anchored')
				.setDescription(`**${title}** has been anchored to the blockchain.`)
				.addFields(
					{ name: 'Block Height', value: `#${block.height}`, inline: true },
					{ name: 'Document ID', value: `\`${docId}\``, inline: false }
				)
				.setTimestamp();

			return interaction.editReply({ embeds: [embed] });
		} catch (error) {
			this.container.logger.error('Error anchoring document:', error);
			return interaction.editReply('❌ Failed to anchor document. Blockchain error: ' + error.message);
		}
	}

	async _get(interaction) {
		await interaction.deferReply();

		const docId = interaction.options.getString('doc_id');

		try {
			const doc = documentRepository.getDocument(docId);
			if (!doc) {
				return interaction.editReply('❌ Document not found. Check the document ID.');
			}

			const author = await interaction.client.users.fetch(doc.author).catch(() => null);
			const authorStr = author ? author.tag : `\`${doc.author}\``;

			const embed = new EmbedBuilder()
				.setColor(0x9B59B6)
				.setTitle(`📄 ${doc.title}`)
				.setDescription(doc.content.length > 2000
					? doc.content.slice(0, 2000) + '…'
					: doc.content
				)
				.addFields(
					{ name: 'Author', value: authorStr, inline: true },
					{ name: 'Block Height', value: `#${doc.block_height}`, inline: true },
					{ name: 'Document ID', value: `\`${doc.doc_id}\``, inline: false }
				)
				.setTimestamp(doc.created_at * 1000);

			return interaction.editReply({ embeds: [embed] });
		} catch (error) {
			this.container.logger.error('Error fetching document:', error);
			return interaction.editReply('❌ Failed to fetch document.');
		}
	}
}

module.exports = { DocumentCommand };
