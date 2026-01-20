const { Command } = require('@sapphire/framework');
const { EmbedBuilder } = require('discord.js');
const { getIdHints } = require('../lib/utils');
const { adminRepository } = require('../database');
const config = require('../config');
const { ensureAdminReply } = require('../lib/middleware/ensureAdmin');

class AdminCommand extends Command {
	constructor(context, options) {
		super(context, {
			...options,
			name: 'admin',
			description: 'Manage bot admins'
		});
	}

	registerApplicationCommands(registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription(this.description)
				.addSubcommand(subcommand =>
					subcommand
						.setName('add')
						.setDescription('Add a user as admin')
						.addUserOption(option =>
							option
								.setName('user')
								.setDescription('User to add as admin')
								.setRequired(true)
						)
				)
				.addSubcommand(subcommand =>
					subcommand
						.setName('remove')
						.setDescription('Remove a user from admin')
						.addUserOption(option =>
							option
								.setName('user')
								.setDescription('User to remove from admin')
								.setRequired(true)
						)
				)
				.addSubcommand(subcommand =>
					subcommand
						.setName('list')
						.setDescription('List all current admins')
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

		const subcommand = interaction.options.getSubcommand();

		try {
			switch (subcommand) {
			case 'add':
				return this.addAdmin(interaction);
			case 'remove':
				return this.removeAdmin(interaction);
			case 'list':
				return this.listAdmins(interaction);
			default:
				return interaction.editReply('Unknown subcommand.');
			}
		} catch (error) {
			this.container.logger.error('Error in admin command:', error);
			return interaction.editReply('An error occurred while processing the command.');
		}
	}

	async addAdmin(interaction) {
		const user = interaction.options.getUser('user');

		if (!user) {
			return interaction.editReply('User not found.');
		}

		if (config.admin.isEnvConfigured) {
			return interaction.editReply('❌ Cannot add admins when ADMIN_IDS environment variable is set. Remove it from .env to use database-based admin management.');
		}

		if (adminRepository.exists(user.id)) {
			return interaction.editReply(`❌ ${user.tag} is already an admin.`);
		}

		adminRepository.add(user.id, interaction.user.id);

		const embed = new EmbedBuilder()
			.setColor(0x00FF00)
			.setTitle('Admin Added')
			.setDescription(`${user.tag} has been added as an admin.`)
			.addFields(
				{ name: 'Added by', value: interaction.user.tag, inline: true },
				{ name: 'User ID', value: user.id, inline: true }
			)
			.setTimestamp();

		return interaction.editReply({ embeds: [embed] });
	}

	async removeAdmin(interaction) {
		const user = interaction.options.getUser('user');

		if (!user) {
			return interaction.editReply('User not found.');
		}

		if (config.admin.isEnvConfigured) {
			return interaction.editReply('❌ Cannot remove admins when ADMIN_IDS environment variable is set. Remove it from .env to use database-based admin management.');
		}

		if (!adminRepository.exists(user.id)) {
			return interaction.editReply(`❌ ${user.tag} is not an admin.`);
		}

		adminRepository.remove(user.id);

		const embed = new EmbedBuilder()
			.setColor(0xFFA500)
			.setTitle('Admin Removed')
			.setDescription(`${user.tag} has been removed from admins.`)
			.addFields(
				{ name: 'Removed by', value: interaction.user.tag, inline: true },
				{ name: 'User ID', value: user.id, inline: true }
			)
			.setTimestamp();

		return interaction.editReply({ embeds: [embed] });
	}

	async listAdmins(interaction) {
		const admins = adminRepository.getAll();

		let description;

		if (config.admin.isEnvConfigured) {
			description = 'Admins are configured via `ADMIN_IDS` environment variable.\n\n**Configured IDs:**\n' +
				config.admin.ids.map(id => `• <@${id}> (${id})`).join('\n');
		} else if (admins.length === 0) {
			description = 'No admins are configured. Add admins using `/admin add`.';
		} else {
			description = `Found ${admins.length} admin(s):\n\n` +
				admins.map(admin => {
					const addedBy = admin.added_by ? `<@${admin.added_by}>` : 'Unknown';
					return `• <@${admin.user_id}> (added by ${addedBy} on <t:${Math.floor(new Date(admin.added_at).getTime() / 1000)}:D>)`;
				}).join('\n');
		}

		const embed = new EmbedBuilder()
			.setColor(0x0099FF)
			.setTitle('Bot Admins')
			.setDescription(description)
			.setTimestamp();

		return interaction.editReply({ embeds: [embed] });
	}
}

module.exports = { AdminCommand };
