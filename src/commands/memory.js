const { Command } = require('@sapphire/framework');
const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { DateTime } = require('luxon');
const { getIdHints } = require('../lib/utils');
const { DEFAULT_TIMEZONE } = require('../lib/constants/config');
const memoryRepository = require('../database/repositories/actorMemory.repository');
const globalMemoryRepository = require('../database/repositories/globalMemory.repository');
const { isAdmin } = require('../lib/middleware/ensureAdmin');
const config = require('../config');

const GLOBAL_KINDS = ['personality', 'rule', 'correction', 'fact'];

/** Unix second of the start of the local day, for the per-member note limit. */
const startOfLocalDay = () => DateTime.now().setZone(DEFAULT_TIMEZONE).startOf('day').toUnixInteger();

/**
 * View and edit what the bot remembers about you. Notes are learned from
 * governance conversations by src/services/taskSuggest.js and shown to the
 * model on later passes. The language preference overrides the Indonesian
 * default of the bot's model-written replies.
 *
 * The `global` subcommands edit server-wide memory instead. That layer tunes
 * the bot's personality and house rules for every channel and every member.
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
									.setDescription('e.g. English. Leave it empty to go back to Indonesian')
									.setMaxLength(30)
									.setRequired(false)
							)
					)
					.addSubcommand(sub => sub.setName('clear').setDescription('Forget everything about yourself'))
					.addSubcommandGroup(group =>
						group
							.setName('global')
							.setDescription('Server-wide notes that tune the bot for everyone')
							.addSubcommand(sub => sub.setName('view').setDescription('Show the server-wide notes'))
							.addSubcommand(sub =>
								sub
									.setName('add')
									.setDescription('Teach the bot something that applies to the whole server')
									.addStringOption(opt =>
										opt
											.setName('note')
											.setDescription('e.g. "kalau ditegur, minta maaf dulu"')
											.setMaxLength(300)
											.setRequired(true)
									)
									.addStringOption(opt =>
										opt
											.setName('kind')
											.setDescription('What the note is for (default: personality)')
											.addChoices(...GLOBAL_KINDS.map(kind => ({ name: kind, value: kind })))
									)
							)
							.addSubcommand(sub =>
								sub
									.setName('remove')
									.setDescription('Remove a server-wide note (your own, or any as an admin)')
									.addIntegerOption(opt =>
										opt
											.setName('id')
											.setDescription('Note number from /memory global view')
											.setRequired(true)
									)
							)
							.addSubcommand(sub =>
								sub.setName('clear').setDescription('Remove every server-wide note (admin only)')
							)
					),
			{
				idHints: getIdHints(this.name)
			}
		);
	}

	async chatInputRun(interaction) {
		if (interaction.options.getSubcommandGroup(false) === 'global') {
			return this._global(interaction);
		}
		const sub = interaction.options.getSubcommand();
		const userId = interaction.user.id;
		const reply = content => interaction.reply({ content, ephemeral: true, allowedMentions: { parse: [] } });

		if (sub === 'view') {
			return this._view(interaction);
		}
		if (sub === 'remember') {
			const note = interaction.options.getString('note', true).replace(/\s+/g, ' ').trim();
			const id = memoryRepository.addNote(userId, note, { addedBy: userId });
			return reply(id ? `Saved as note #${id}.` : 'That is already remembered.');
		}
		if (sub === 'forget') {
			const id = interaction.options.getInteger('number', true);
			const note = memoryRepository.removeNote(userId, id);
			return reply(note ? `Forgot ${note}` : `You have no note #${id}.`);
		}
		if (sub === 'language') {
			const language = interaction.options.getString('language')?.trim() || null;
			memoryRepository.setLanguage(userId, language);
			return reply(
				language
					? `The bot will use ${language} with you.`
					: 'The bot will use Indonesian with you (the default).'
			);
		}
		if (sub === 'clear') {
			memoryRepository.clearUser(userId);
			return reply('Everything the bot remembered about you has been deleted.');
		}
	}

	/**
	 * Server-wide memory. Anyone may teach it, because personality is a shared
	 * thing. Writes are capped per member per day, and only an admin may wipe
	 * everything.
	 */
	async _global(interaction) {
		const sub = interaction.options.getSubcommand();
		const userId = interaction.user.id;
		const reply = content => interaction.reply({ content, ephemeral: true, allowedMentions: { parse: [] } });

		if (sub === 'view') {
			const notes = globalMemoryRepository.listNotes();
			const embed = new EmbedBuilder()
				.setColor(0x9b59b6)
				.setTitle('Server-wide memory')
				.setDescription(
					notes.length
						? notes
								.map(
									n => `**#${n.id}** [${n.kind}] ${n.note}${n.added_by ? ` (by ${n.added_by})` : ''}`
								)
								.join('\n')
								.slice(0, 4000)
						: 'Nothing yet. Teach it with /memory global add.'
				)
				.setFooter({
					text: `${notes.length}/${config.chat.globalMemory.max} notes. Remove one with /memory global remove.`
				});
			return interaction.reply({ embeds: [embed], ephemeral: true });
		}

		if (sub === 'add') {
			const note = interaction.options.getString('note', true);
			const kind = interaction.options.getString('kind') ?? 'personality';
			const limit = config.chat.globalMemory.perDay;
			const used = globalMemoryRepository.countByUserSince(userId, startOfLocalDay());
			if (used >= limit) {
				return reply(`You already added ${limit} server-wide notes today. Try again tomorrow.`);
			}
			const { id, reason } = globalMemoryRepository.addNote(note, {
				kind,
				addedBy: userId,
				max: config.chat.globalMemory.max
			});
			if (!id) {
				return reply(`Not saved: ${reason}.`);
			}
			return reply(`Saved as server-wide note #${id}. It applies in every channel from the next message on.`);
		}

		if (sub === 'remove') {
			const id = interaction.options.getInteger('id', true);
			const note = globalMemoryRepository.getNote(id);
			if (!note) {
				return reply(`There is no server-wide note #${id}.`);
			}
			const admin = await isAdmin(userId);
			if (note.added_by !== userId && !admin) {
				return reply('You can only remove a server-wide note you added yourself. Ask an admin for the rest.');
			}
			globalMemoryRepository.removeNote(id);
			return reply(`Removed server-wide note #${id}: ${note.note}`);
		}

		if (sub === 'clear') {
			if (!(await isAdmin(userId))) {
				return reply('Only a bot admin can clear server-wide memory.');
			}
			globalMemoryRepository.clear();
			return reply('Every server-wide note has been removed.');
		}
	}

	async _view(interaction) {
		const target = interaction.options.getUser('user') ?? interaction.user;
		if (
			target.id !== interaction.user.id &&
			!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)
		) {
			return interaction.reply({
				content: "You need the Manage Messages permission to view someone else's memory.",
				ephemeral: true
			});
		}

		const language = memoryRepository.getLanguage(target.id);
		const notes = memoryRepository.listNotes(target.id);
		const embed = new EmbedBuilder()
			.setColor(0x9b59b6)
			.setTitle(`What the bot remembers about ${target.displayName ?? target.username}`)
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
