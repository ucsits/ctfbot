const { Command } = require('@sapphire/framework');
const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { getIdHints } = require('../lib/utils');
const memoryRepository = require('../database/repositories/actorMemory.repository');

/**
 * View and edit what the bot remembers about you. Notes are learned from
 * governance conversations by src/services/taskSuggest.js and shown to the
 * model on later passes; the language preference overrides the Indonesian
 * default of the bot's model-written replies.
 */
class MemoryCommand extends Command {
	constructor(context, options) {
		super(context, {
			...options,
			name: 'memory',
			description: 'See and edit what the bot remembers about you'
		});
	}

	registerApplicationCommands(registry) {
		registry.registerChatInputCommand(
			builder =>
				builder
					.setName(this.name)
					.setDescription(this.description)
					.addSubcommand(sub =>
						sub
							.setName('view')
							.setDescription('Show what the bot remembers')
							.addUserOption(opt =>
								opt
									.setName('user')
									.setDescription('Someone else (needs Manage Messages)')
									.setRequired(false)
							)
					)
					.addSubcommand(sub =>
						sub
							.setName('remember')
							.setDescription('Add a note about yourself')
							.addStringOption(opt =>
								opt
									.setName('note')
									.setDescription('e.g. "Prefers reminders at 20:00"')
									.setMaxLength(200)
									.setRequired(true)
							)
					)
					.addSubcommand(sub =>
						sub
							.setName('forget')
							.setDescription('Remove one note about yourself')
							.addIntegerOption(opt =>
								opt.setName('number').setDescription('Note number from /memory view').setRequired(true)
							)
					)
					.addSubcommand(sub =>
						sub
							.setName('language')
							.setDescription('Language the bot uses with you (default: Indonesian)')
							.addStringOption(opt =>
								opt
									.setName('language')
									.setDescription('e.g. English; leave empty to go back to Indonesian')
									.setMaxLength(30)
									.setRequired(false)
							)
					)
					.addSubcommand(sub => sub.setName('clear').setDescription('Forget everything about yourself')),
			{
				idHints: getIdHints(this.name)
			}
		);
	}

	async chatInputRun(interaction) {
		const sub = interaction.options.getSubcommand();
		const userId = interaction.user.id;
		const reply = content => interaction.reply({ content, ephemeral: true, allowedMentions: { parse: [] } });

		if (sub === 'view') {
			return this._view(interaction);
		}
		if (sub === 'remember') {
			const note = interaction.options.getString('note', true).replace(/\s+/g, ' ').trim();
			const id = memoryRepository.addNote(userId, note, { addedBy: userId });
			return reply(id ? `✅ Saved as note #${id}.` : 'ℹ️ That is already remembered.');
		}
		if (sub === 'forget') {
			const id = interaction.options.getInteger('number', true);
			const note = memoryRepository.removeNote(userId, id);
			return reply(note ? `🗑️ Forgot: ${note}` : `❌ You have no note #${id}.`);
		}
		if (sub === 'language') {
			const language = interaction.options.getString('language')?.trim() || null;
			memoryRepository.setLanguage(userId, language);
			return reply(
				language
					? `✅ The bot will use ${language} with you.`
					: '✅ The bot will use Indonesian with you (the default).'
			);
		}
		if (sub === 'clear') {
			memoryRepository.clearUser(userId);
			return reply('🗑️ Everything the bot remembered about you has been deleted.');
		}
	}

	async _view(interaction) {
		const target = interaction.options.getUser('user') ?? interaction.user;
		if (
			target.id !== interaction.user.id &&
			!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)
		) {
			return interaction.reply({
				content: "❌ You need the Manage Messages permission to view someone else's memory.",
				ephemeral: true
			});
		}

		const language = memoryRepository.getLanguage(target.id);
		const notes = memoryRepository.listNotes(target.id);
		const embed = new EmbedBuilder()
			.setColor(0x9b59b6)
			.setTitle(`🧠 What the bot remembers about ${target.displayName ?? target.username}`)
			.addFields(
				{ name: 'Language', value: language ?? 'Indonesian (default)', inline: false },
				{
					name: 'Notes',
					value: notes.length
						? notes
								.map(n => `**#${n.id}** ${n.note}`)
								.join('\n')
								.slice(0, 1024)
						: 'Nothing yet.',
					inline: false
				}
			)
			.setFooter({ text: 'Remove a note with /memory forget, or everything with /memory clear.' });
		return interaction.reply({ embeds: [embed], ephemeral: true });
	}
}

module.exports = { MemoryCommand };
