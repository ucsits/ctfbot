const { Command } = require('@sapphire/framework');
const { EmbedBuilder } = require('discord.js');
const { activityRepository } = require('../database');
const { getIdHints } = require('../lib/utils');

class ActivityLeaderboardCommand extends Command {
	constructor(context, options) {
		super(context, {
			...options,
			name: 'activityleaderboard',
			description: 'View the activity points leaderboard'
		});
	}

	registerApplicationCommands(registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription(this.description)
				.addIntegerOption(opt =>
					opt
						.setName('limit')
						.setDescription('Number of top users to show (default: 10, max: 50)')
						.setRequired(false)
						.setMinValue(1)
						.setMaxValue(50)
				),
		{
			idHints: getIdHints(this.name)
		}
		);
	}

	async chatInputRun(interaction) {
		await interaction.deferReply();

		const limit = interaction.options.getInteger('limit') || 10;

		try {
			const rows = activityRepository.getLeaderboard(limit);

			if (rows.length === 0) {
				return interaction.editReply('📊 No activity points yet. Ask an admin to award some!');
			}

			const embed = new EmbedBuilder()
				.setColor(0x9B59B6)
				.setTitle('🏆 Activity Points Leaderboard')
				.setTimestamp();

			const lines = [];
			for (let i = 0; i < rows.length; i++) {
				const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
				const user = await interaction.client.users.fetch(rows[i].user_id).catch(() => null);
				const name = user ? user.tag : `\`${rows[i].user_id}\``;
				lines.push(`${medal} **${name}** — ${rows[i].balance} AP`);
			}

			embed.setDescription(lines.join('\n'));

			return interaction.editReply({ embeds: [embed] });
		} catch (error) {
			this.container.logger.error('Error fetching activity leaderboard:', error);
			return interaction.editReply('❌ Failed to fetch leaderboard.');
		}
	}
}

module.exports = { ActivityLeaderboardCommand };
