const { Command } = require('@sapphire/framework');
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { randomUUID } = require('crypto');
const documentRepository = require('../database/repositories/document.repository');
const luce = require('../lib/luce');
const { checkPermissionReply } = require('../lib/middleware/ensurePermission');
const { ensureGovernanceChannelReply } = require('../lib/middleware/ensureGovernanceChannel');
const { PermissionFlagsBits } = require('discord.js');

/**
 * Maximum file size for anchored documents (8 MB).
 * Discord bot file attachments can be up to ~25 MB, but keeping
 * binary data in the blockchain ledger benefits from a sane limit.
 */
const MAX_FILE_SIZE = 8 * 1024 * 1024;

class DocumentCommand extends Command {
	constructor(context, options) {
		super(context, {
			...options,
			name: 'document',
			description: 'Anchoring documents & files to the blockchain'
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
						.setDescription('Anchor a document or file to the blockchain')
						.addStringOption(opt =>
							opt.setName('title').setDescription('Document title').setRequired(true)
						)
						.addStringOption(opt =>
							opt.setName('content').setDescription('Document content (plain text) — ignored if a file is attached')
						)
						.addAttachmentOption(opt =>
							opt.setName('file').setDescription('File to anchor (optional — max 8 MB)')
						)
				)

				// ── subcommand: get ──
				.addSubcommand(sub =>
					sub
						.setName('get')
						.setDescription('Retrieve an anchored document or file by ID')
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
		if (cancelled) {
			return;
		}

		const sub = interaction.options.getSubcommand();
		if (sub === 'add') {
			return this._add(interaction);
		}
		if (sub === 'get') {
			return this._get(interaction);
		}
	}

	async _add(interaction) {
		// Require Manage Messages for adding documents
		const cancelled = await checkPermissionReply(interaction, PermissionFlagsBits.ManageMessages, 'Manage Messages');
		if (cancelled) {
			return;
		}

		await interaction.deferReply();

		const title = interaction.options.getString('title');
		const content = interaction.options.getString('content');
		const attachment = interaction.options.getAttachment('file');

		// Must have either text content or a file attachment
		if (!content && !attachment) {
			return interaction.editReply('❌ You must provide either text content or attach a file.');
		}

		const docId = randomUUID();

		try {
			let data;
			let mimeType = 'text/plain';
			let filename = null;
			let fileSize = null;
			let fileBuffer = null;
			const storedContent = content || null;

			if (attachment) {
				// ── File attachment mode ──
				if (attachment.size > MAX_FILE_SIZE) {
					return interaction.editReply(
						`❌ File too large. Maximum allowed size is **${(MAX_FILE_SIZE / 1024 / 1024).toFixed(1)} MB**.`
					);
				}

				mimeType = attachment.contentType || 'application/octet-stream';
				filename = attachment.name;
				fileSize = attachment.size;

				// Download the file binary
				const res = await fetch(attachment.url);
				if (!res.ok) {
					throw new Error(`Failed to download attachment: HTTP ${res.status}`);
				}
				const arrayBuffer = await res.arrayBuffer();
				fileBuffer = Buffer.from(arrayBuffer);

				// For the blockchain JSON: base64-encode the binary content
				const base64Content = fileBuffer.toString('base64');

				data = JSON.stringify({
					type: 'document',
					v: 2,
					docId,
					title,
					author: interaction.user.id,
					mimeType,
					filename,
					fileSize,
					content: base64Content,
					encoding: 'base64'
				});
			} else {
				// ── Plain text mode ──
				data = JSON.stringify({
					type: 'document',
					v: 1,
					docId,
					title,
					content: storedContent,
					author: interaction.user.id,
					mimeType: 'text/plain'
				});
			}

			const block = await luce.appendBlock({
				author: interaction.user.id,
				data
			});

			documentRepository.createDocument({
				docId,
				title,
				content: storedContent,
				author: interaction.user.id,
				mimeType,
				blockHeight: block.height,
				fileData: fileBuffer,
				filename,
				fileSize
			});

			// Build success embed
			const embed = new EmbedBuilder()
				.setColor(0x9B59B6)
				.setTitle('📄 Document Anchored')
				.setDescription(`**${title}** has been anchored to the blockchain.`)
				.addFields(
					{ name: 'Block Height', value: `#${block.height}`, inline: true },
					{ name: 'Type', value: attachment ? '📎 File' : '📝 Text', inline: true }
				);

			if (attachment) {
				embed.addFields(
					{ name: 'Filename', value: filename, inline: true },
					{ name: 'Size', value: formatFileSize(fileSize), inline: true }
				);
			}

			embed.addFields(
				{ name: 'Document ID', value: `\`${docId}\``, inline: false }
			);

			embed.setTimestamp();

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

			// ── File document: send the file back ──
			if (doc.file_data) {
				const ext = doc.filename ? doc.filename.split('.').pop() : 'bin';
				const attachmentName = doc.filename || `document-${docId}.${ext}`;

				const fileAttachment = new AttachmentBuilder(doc.file_data, {
					name: attachmentName,
					description: doc.title
				});

				const embed = new EmbedBuilder()
					.setColor(0x9B59B6)
					.setTitle(`📄 ${doc.title}`)
					.setDescription('📎 File document anchored on the blockchain')
					.addFields(
						{ name: 'Author', value: authorStr, inline: true },
						{ name: 'Filename', value: doc.filename || 'Unknown', inline: true },
						{ name: 'Size', value: formatFileSize(doc.file_size), inline: true },
						{ name: 'MIME Type', value: `\`${doc.mime_type}\``, inline: true },
						{ name: 'Block Height', value: `#${doc.block_height}`, inline: true },
						{ name: 'Document ID', value: `\`${doc.doc_id}\``, inline: false }
					)
					.setTimestamp(doc.created_at * 1000);

				return interaction.editReply({ embeds: [embed], files: [fileAttachment] });
			}

			// ── Text document: show content in embed ──
			const embed = new EmbedBuilder()
				.setColor(0x9B59B6)
				.setTitle(`📄 ${doc.title}`)
				.setDescription(doc.content && doc.content.length > 2000
					? doc.content.slice(0, 2000) + '…'
					: (doc.content || '*No content*')
				)
				.addFields(
					{ name: 'Author', value: authorStr, inline: true },
					{ name: 'Block Height', value: `#${doc.block_height}`, inline: true },
					{ name: 'MIME Type', value: `\`${doc.mime_type}\``, inline: true },
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

/**
 * Format a byte count into a human-readable string.
 * @param {number} bytes
 * @returns {string}
 */
function formatFileSize(bytes) {
	if (!bytes) {
		return '0 B';
	}
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

module.exports = { DocumentCommand };
