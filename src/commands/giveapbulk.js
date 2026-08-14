const { Command } = require('@sapphire/framework');
const { EmbedBuilder } = require('discord.js');
const luce = require('../lib/luce');
const { activityRepository } = require('../database');
const { getIdHints } = require('../lib/utils');
const { ensureAdminReply } = require('../lib/middleware/ensureAdmin');

const MAX_FILE_SIZE = 1024 * 1024; // 1 MB

/**
 * Minimal row-based CSV parser. Handles quoted fields and commas/newlines
 * inside quotes. Ignores a header row whose first column matches a common
 * header name for "discord_id".
 *
 * @param {string} content - raw CSV text
 * @returns {Array<{discord_id: string, points: number}>}
 */
function parseCsv(content) {
	const rows = [];
	let field = '';
	let inQuotes = false;
	let record = [];

	const flushField = () => {
		record.push(field.trim());
		field = '';
	};
	const flushRecord = () => {
		flushField();
		if (record.some(cell => cell !== '')) {
			rows.push(record);
		}
		record = [];
	};

	for (let i = 0; i < content.length; i++) {
		const ch = content[i];
		if (inQuotes) {
			if (ch === '"') {
				if (content[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				field += ch;
			}
		} else if (ch === '"') {
			inQuotes = true;
		} else if (ch === ',') {
			flushField();
		} else if (ch === '\n' || ch === '\r') {
			// Handle \r\n as one line break
			if (ch === '\r' && content[i + 1] === '\n') {
				i++;
			}
			flushRecord();
		} else {
			field += ch;
		}
	}

	// Flush trailing record (no trailing newline)
	if (field.length > 0 || record.length > 0) {
		flushRecord();
	}

	if (rows.length === 0) {
		return [];
	}

	// Detect and skip header row: first cell is a non-numeric column name
	const firstCell = rows[0][0].toLowerCase();
	const looksLikeHeader = isNaN(Number(rows[0][0])) &&
		(firstCell.includes('id') || firstCell.includes('point') || firstCell.includes('discord'));
	const dataRows = looksLikeHeader ? rows.slice(1) : rows;

	// Map to objects; the first column is discord_id, second is points.
	return dataRows.map(row => ({
		discord_id: (row[0] || '').trim(),
		points: Number((row[1] || '').trim())
	}));
}

class GiveApBulkCommand extends Command {
	constructor(context, options) {
		super(context, {
			...options,
			name: 'giveapbulk',
			description: 'Grant activity points to many users from a CSV (admin only)'
		});
	}

	registerApplicationCommands(registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription(this.description)
				.addAttachmentOption(opt =>
					opt
						.setName('csv')
						.setDescription('CSV file with discord_id and points columns')
						.setRequired(true)
				),
		{
			idHints: getIdHints(this.name)
		}
		);
	}

	async chatInputRun(interaction) {
		const cancelled = await ensureAdminReply(interaction);
		if (cancelled) {
			return;
		}

		await interaction.deferReply();

		const attachment = interaction.options.getAttachment('csv');

		if (attachment.size > MAX_FILE_SIZE) {
			return interaction.editReply('❌ CSV file is too large. Maximum size is 1 MB.');
		}

		let content;
		try {
			const res = await fetch(attachment.url);
			if (!res.ok) {
				throw new Error(`Failed to download CSV: HTTP ${res.status}`);
			}
			content = await res.text();
		} catch (error) {
			return interaction.editReply(`❌ Could not read the CSV file: ${error.message}`);
		}

		const entries = parseCsv(content);
		const valid = entries.filter(e => e.discord_id && Number.isFinite(e.points) && e.points > 0);

		if (valid.length === 0) {
			return interaction.editReply(
				'❌ No valid rows found. The CSV should have two columns: `discord_id` and `points` (with a header row or without).'
			);
		}

		if (valid.length !== entries.length) {
			return interaction.editReply(
				`❌ ${entries.length - valid.length} row(s) were invalid (missing discord_id or non-positive points). No points were granted — fix the CSV and retry.`
			);
		}

		try {
			// 1. Write a single blockchain block for the whole batch
			const payload = valid.map(e => ({
				discord_id: e.discord_id,
				points: e.points
			}));

			const data = JSON.stringify({
				type: 'ap_grant',
				v: 2, // v2 = bulk grant (array payload)
				grantedBy: interaction.user.id,
				entries: payload,
				count: payload.length,
				total: payload.reduce((sum, e) => sum + e.points, 0)
			});

			const block = await luce.appendBlock({
				author: interaction.user.id,
				data
			});

			// 2. Apply each grant in the DB
			const results = [];
			for (const entry of valid) {
				const newBalance = activityRepository.grantPoints({
					userId: entry.discord_id,
					amount: entry.points,
					grantedBy: interaction.user.id,
					note: 'bulk grant',
					blockHeight: block.height
				});
				results.push({ discord_id: entry.discord_id, points: entry.points, balance: newBalance });
			}

			const granted = results.filter(r => r.balance >= 0).length;
			const preview = results.slice(0, 10)
				.map(r => `<@${r.discord_id}> — **+${r.points} AP**`)
				.join('\n');

			const embed = new EmbedBuilder()
				.setColor(0x9B59B6)
				.setTitle('🎯 Bulk Activity Points Granted')
				.setDescription(
					`**${granted}** user(s) received a total of **${payload.reduce((s, e) => s + e.points, 0)} AP** from the CSV.`
				)
				.addFields(
					{ name: 'Block Height', value: `#${block.height}`, inline: true },
					{ name: 'Granted by', value: interaction.user.toString(), inline: true }
				)
				.setTimestamp();

			if (results.length > 0) {
				embed.addFields({
					name: 'Preview',
					value: preview + (results.length > 10 ? `\n… and ${results.length - 10} more` : ''),
					inline: false
				});
			}

			return interaction.editReply({ embeds: [embed] });
		} catch (error) {
			this.container.logger.error('Error in bulk grant:', error);
			return interaction.editReply('❌ Failed to process bulk grant. Blockchain error: ' + error.message);
		}
	}
}

module.exports = { GiveApBulkCommand, parseCsv };
