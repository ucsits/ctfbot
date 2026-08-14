const { Command } = require('@sapphire/framework');
const { EmbedBuilder } = require('discord.js');
const luce = require('../lib/luce');
const { activityRepository } = require('../database');
const { getIdHints } = require('../lib/utils');
const { ensureAdminReply } = require('../lib/middleware/ensureAdmin');

class GiveApCommand extends Command {
	constructor(context, options) {
		super(context, {
			...options,
			name: 'giveap',
			description: 'Grant activity points to a user or a whole role (admin only)'
		});
	}

	registerApplicationCommands(registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription(this.description)
				.addIntegerOption(opt =>
					opt
						.setName('points')
						.setDescription('Number of activity points to grant')
						.setRequired(true)
						.setMinValue(1)
				)
				.addUserOption(opt =>
					opt
						.setName('user')
						.setDescription('User to grant activity points to')
						.setRequired(false)
				)
				.addRoleOption(opt =>
					opt
						.setName('role')
						.setDescription('Grant activity points to every member of this role')
						.setRequired(false)
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

		const user = interaction.options.getUser('user');
		const role = interaction.options.getRole('role');
		const points = interaction.options.getInteger('points');

		if (!user && !role) {
			return interaction.editReply('❌ You must provide either a `user` or a `role` to grant points to.');
		}
		if (user && role) {
			return interaction.editReply('❌ Provide either a `user` **or** a `role`, not both.');
		}

		// ── Single user grant ──
		if (user) {
			return this._grantToUser(interaction, user, points);
		}

		// ── Role grant: fetch members and grant to each (one batch block) ──
		return this._grantToRole(interaction, role, points);
	}

	async _grantToUser(interaction, user, points) {
		try {
			const data = JSON.stringify({
				type: 'ap_grant',
				v: 1,
				grantedTo: user.id,
				grantedBy: interaction.user.id,
				amount: points
			});

			const block = await luce.appendBlock({ author: interaction.user.id, data });

			const newBalance = activityRepository.grantPoints({
				userId: user.id,
				amount: points,
				grantedBy: interaction.user.id,
				blockHeight: block.height
			});

			const embed = new EmbedBuilder()
				.setColor(0x9B59B6)
				.setTitle('🎯 Activity Points Granted')
				.setDescription(`${user} was granted **${points} AP**`)
				.addFields(
					{ name: 'User', value: user.toString(), inline: true },
					{ name: 'Points', value: `+${points} AP`, inline: true },
					{ name: 'New Balance', value: `**${newBalance} AP**`, inline: true },
					{ name: 'Block Height', value: `#${block.height}`, inline: true }
				)
				.setTimestamp();

			return interaction.editReply({ embeds: [embed] });
		} catch (error) {
			this.container.logger.error('Error granting activity points:', error);
			return interaction.editReply('❌ Failed to grant activity points. Blockchain error: ' + error.message);
		}
	}

	async _grantToRole(interaction, role, points) {
		let members;
		try {
			const guild = interaction.guild;
			if (!guild) {
				return interaction.editReply('❌ This command must be run inside a server.');
			}
			const fetched = await guild.members.fetch();
			members = [...fetched.values()].filter(m => !m.user.bot && m.roles.cache.has(role.id));
		} catch (error) {
			this.container.logger.error('Error fetching role members:', error);
			return interaction.editReply('❌ Failed to fetch members of that role.');
		}

		if (members.length === 0) {
			return interaction.editReply(`❌ No human members found in role **${role.name}**.`);
		}

		try {
			// 1. Single blockchain block for the whole role grant batch
			const entries = members.map(m => ({ discord_id: m.user.id, points }));
			const data = JSON.stringify({
				type: 'ap_grant',
				v: 2, // v2 = batch grant (array payload)
				grantedBy: interaction.user.id,
				roleId: role.id,
				roleName: role.name,
				entries,
				count: entries.length,
				pointsPerUser: points,
				total: entries.length * points
			});

			const block = await luce.appendBlock({ author: interaction.user.id, data });

			// 2. Apply each grant in the DB
			for (const entry of entries) {
				activityRepository.grantPoints({
					userId: entry.discord_id,
					amount: entry.points,
					grantedBy: interaction.user.id,
					note: `role grant: ${role.name}`,
					blockHeight: block.height
				});
			}

			const embed = new EmbedBuilder()
				.setColor(0x9B59B6)
				.setTitle('🎯 Activity Points Granted to Role')
				.setDescription(`**${members.length}** member(s) of **${role.name}** each received **+${points} AP**`)
				.addFields(
					{ name: 'Role', value: role.toString(), inline: true },
					{ name: 'Members', value: `${members.length}`, inline: true },
					{ name: 'Points Each', value: `+${points} AP`, inline: true },
					{ name: 'Total AP', value: `${entries.length * points} AP`, inline: true },
					{ name: 'Block Height', value: `#${block.height}`, inline: true }
				)
				.setTimestamp();

			const preview = members.slice(0, 10)
				.map(m => `<@${m.user.id}>`)
				.join(', ');
			if (members.length > 0) {
				embed.addFields({
					name: 'Preview',
					value: preview + (members.length > 10 ? `\n… and ${members.length - 10} more` : ''),
					inline: false
				});
			}

			return interaction.editReply({ embeds: [embed] });
		} catch (error) {
			this.container.logger.error('Error granting points to role:', error);
			return interaction.editReply('❌ Failed to grant points to role. Blockchain error: ' + error.message);
		}
	}
}

module.exports = { GiveApCommand };
