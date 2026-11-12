const { Command } = require('@sapphire/framework');
const { AttachmentBuilder } = require('discord.js');
const { getIdHints } = require('../lib/utils');

/**
 * Maximum file size for private transfers (8 MB).
 * Kept the same as /document for consistency with bot upload limits.
 */
const MAX_FILE_SIZE = 8 * 1024 * 1024;

/**
 * Discord API error codes that mean we cannot reach the recipient's DMs:
 *  - 50007: Cannot send messages to this user (DMs disabled / blocked / no mutual server)
 *  - 50013: Missing permissions to send the DM
 */
const DM_FAILURE_CODES = new Set([50007, 50013]);

class TelegramCommand extends Command {
	constructor(context, options) {
		super(context, {
			...options,
			name: 'telegram',
			description: 'Send a document privately to a user'
		});
	}

	registerApplicationCommands(registry) {
		registry.registerChatInputCommand(
			builder =>
				builder
					.setName(this.name)
					.setDescription(this.description)
					.addUserOption(opt =>
						opt.setName('recipient').setDescription('User to send the document to').setRequired(true)
					)
					.addAttachmentOption(opt =>
						opt.setName('document').setDescription('File to send privately').setRequired(true)
					)
					.addStringOption(opt =>
						opt.setName('note').setDescription('Optional private message to include with the file')
					),
			{
				idHints: getIdHints(this.name)
			}
		);
	}

	async chatInputRun(interaction) {
		const recipient = interaction.options.getUser('recipient');
		const attachment = interaction.options.getAttachment('document');
		const note = interaction.options.getString('note');

		if (!recipient) {
			return interaction.reply({ content: '❌ Recipient not found.', ephemeral: true });
		}

		if (attachment.size > MAX_FILE_SIZE) {
			return interaction.reply({
				content: `❌ File too large. Maximum allowed size is **${(MAX_FILE_SIZE / 1024 / 1024).toFixed(1)} MB**.`,
				ephemeral: true
			});
		}

		await interaction.deferReply({ ephemeral: true });

		try {
			const res = await fetch(attachment.url);
			if (!res.ok) {
				throw new Error(`Failed to download attachment: HTTP ${res.status}`);
			}
			const fileBuffer = Buffer.from(await res.arrayBuffer());
			const fileAttachment = new AttachmentBuilder(fileBuffer, {
				name: attachment.name,
				description: 'Document sent via /telegram'
			});

			const lines = [
				'📨 **Private file transfer**',
				`To: ${recipient.toString()}`,
				`From: ${interaction.user.toString()}`
			];
			if (note) {
				lines.push('', `💬 ${note}`);
			}
			lines.push('', '📎 File attached below.');

			await recipient.send({
				content: lines.join('\n'),
				files: [fileAttachment],
				allowedMentions: { parse: ['users'] }
			});

			return interaction.editReply({
				content: `✅ Sent privately to ${recipient}.`
			});
		} catch (error) {
			this.container.logger.error('Error in /telegram:', error);
			return this._handleDeliveryFailure(interaction, error, recipient);
		}
	}

	_handleDeliveryFailure(interaction, error, recipient) {
		if (typeof error.code === 'number' && DM_FAILURE_CODES.has(error.code)) {
			return interaction.editReply(
				`❌ Could not DM ${recipient}. They may have DMs disabled or have blocked the bot.`
			);
		}
		return interaction.editReply(`❌ Failed to send the document. ${error.message || 'Unknown error.'}`);
	}
}

module.exports = { TelegramCommand };
