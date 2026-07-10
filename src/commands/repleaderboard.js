const { Command } = require('@sapphire/framework');
const { EmbedBuilder } = require('discord.js');
const reputationRepository = require('../database/repositories/reputation.repository');

class RepLeaderboardCommand extends Command {
	constructor(context, options) {
		super(context, {
			...options,
			name: 'repleaderboard',
			description: 'View the reputation leaderboard'
		});
	}

	registerApplicationCommands(registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription(this.description)
				.addIntegerOption(opt =>
					opt.setName('limit')
						.setDescription('Number of top users to show (default: 10, max: 50)')
						.setRequired(false)
						.setMinValue(1)
						.setMaxValue(50)
				),
			{
				idHints: require('../lib/utils/commandIds').getIdHints('repleaderboard')
			}
		);
	}

	async chatInputRun(interaction) {
		await interaction.deferReply();

		const limit = interaction.options.getInteger('limit') || 10;

		try {
			const rows = reputationRepository.getLeaderboard(limit);

			if (rows.length === 0) {
				return interaction.editReply('📊 No rep data yet. Be the first to give rep!');
			}

			const embed = new EmbedBuilder()
				.setColor(0xF1C40F)
				.setTitle('🏆 Reputation Leaderboard')
				.setTimestamp();

			const lines = [];
			for (let i = 0; i < rows.length; i++) {
				const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
				const user = await interaction.client.users.fetch(rows[i].user_id).catch(() => null);
				const name = user ? user.tag : `\`${rows[i].user_id}\``;
				const total = rows[i].total;
				const sign = total >= 0 ? '+' : '';
				lines.push(`${medal} **${name}** — ${sign}${total}`);
			}

			embed.setDescription(lines.join('\n'));

			return interaction.editReply({ embeds: [embed] });
		} catch (error) {
			this.container.logger.error('Error fetching rep leaderboard:', error);
			return interaction.editReply('❌ Failed to fetch leaderboard.');
		}
	}
}

module.exports = { RepLeaderboardCommand };
