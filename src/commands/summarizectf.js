const { Command } = require('@sapphire/framework');
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { getIdHints } = require('../utils');
const { ctfOperations } = require('../database');
const { createCTFdClient } = require('../lib/ctfd');

class SummarizeCTFCommand extends Command {
	constructor(context, options) {
		super(context, {
			...options,
			name: 'summarizectf',
			description: 'Generate a leaderboard summary for the CTF'
		});
	}

	registerApplicationCommands(registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription(this.description)
				.addStringOption(option =>
					option
						.setName('format')
						.setDescription('Output format')
						.setRequired(false)
						.addChoices(
							{ name: 'Pretty (Embed)', value: 'pretty' },
							{ name: 'TSV (Tab Separated)', value: 'tsv' }
						)
				),
			{
				idHints: getIdHints(this.name)
			}
		);
	}

	async chatInputRun(interaction) {
		await interaction.deferReply();

		const format = interaction.options.getString('format') || 'pretty';
		const ctf = ctfOperations.getCTFByChannelId(interaction.channelId);
		
		if (!ctf) {
			return interaction.editReply({
				content: '❌ This command can only be used in a CTF channel.',
				ephemeral: true
			});
		}

		try {
			const stats = ctfOperations.getCTFSummaryStats(ctf.id);
			if (!stats || stats.length === 0) {
				return interaction.editReply('No participants found for this CTF.');
			}

			// Determine if multi-team mode
			let isMultiTeam = false;
			if (ctf.team_mode === 1) {
				const uniqueTeams = new Set(stats.map(s => s.team_name).filter(t => t));
				if (uniqueTeams.size > 1) {
					isMultiTeam = true;
				}
			}

			// Fetch scoreboard if API token is available
			let scoreboard = [];
			if (ctf.ctf_base_url && ctf.api_token) {
				try {
					const client = createCTFdClient(ctf.ctf_base_url, ctf.api_token);
					scoreboard = await client.getScoreboard();
				} catch (error) {
					this.container.logger.error('Failed to fetch scoreboard:', error);
				}
			}

			if (format === 'tsv') {
				return this.handleTSVOutput(interaction, stats, ctf);
			} else {
				return this.handlePrettyOutput(interaction, stats, ctf, isMultiTeam, scoreboard);
			}

		} catch (error) {
			this.container.logger.error('Error generating summary:', error);
			return interaction.editReply('❌ Failed to generate summary.');
		}
	}

	async handleTSVOutput(interaction, stats, ctf) {
		let tsvContent = 'Name\tNRP\tTeam\tPoints\tSolves\n';
		
		stats.forEach(s => {
			const name = s.real_name || s.username;
			const nrp = s.nrp || 'n/a';
			const team = s.team_name || s.ctfd_team_name || 'n/a';
			tsvContent += `${name}\t${nrp}\t${team}\t${s.total_points}\t${s.solve_count}\n`;
		});

		const buffer = Buffer.from(tsvContent, 'utf-8');
		const attachment = new AttachmentBuilder(buffer, { name: `summary_${ctf.ctf_name.replace(/\s+/g, '_')}.tsv` });

		return interaction.editReply({ files: [attachment] });
	}

	async handlePrettyOutput(interaction, stats, ctf, isMultiTeam, scoreboard) {
		let output = '';

		if (!isMultiTeam) {
			// Single team mode
			// Try to find the team name from the first user who has one, or default to 'Unknown Team'
			const teamName = stats.find(s => s.ctfd_team_name || s.team_name)?.ctfd_team_name 
				|| stats.find(s => s.ctfd_team_name || s.team_name)?.team_name 
				|| 'Unknown Team';
				
			const totalPoints = stats.reduce((sum, s) => sum + s.total_points, 0);
			
			let rank = 'N/A';
			if (scoreboard.length > 0) {
				const teamEntry = scoreboard.find(t => t.name === teamName);
				if (teamEntry) {
					rank = teamEntry.pos;
				}
			}

			stats.forEach((s, index) => {
				const name = s.real_name || s.username;
				const nrp = s.nrp || 'n/a';
				output += `${index + 1}. ${name} (${nrp}) - ${s.total_points} pts\n`;
			});
			
			output += `\n**Total Team Points:** ${totalPoints} pts\n`;
			output += `**Leaderboard Position:** ${rank}`;

		} else {
			// Multi team mode
			const teamGroups = {};
			stats.forEach(s => {
				const tName = s.team_name || 'Unassigned';
				if (!teamGroups[tName]) teamGroups[tName] = [];
				teamGroups[tName].push(s);
			});

			const sortedTeams = Object.entries(teamGroups).map(([tName, members]) => {
				const tPoints = members.reduce((sum, m) => sum + m.total_points, 0);
				
				let tRank = 'N/A';
				if (scoreboard.length > 0) {
					const teamEntry = scoreboard.find(t => t.name === tName);
					if (teamEntry) {
						tRank = teamEntry.pos;
					}
				}

				return {
					name: tName,
					points: tPoints,
					rank: tRank,
					members: members.sort((a, b) => b.total_points - a.total_points)
				};
			}).sort((a, b) => b.points - a.points);

			sortedTeams.forEach(team => {
				const rankDisplay = team.rank !== 'N/A' ? `[${team.rank}]` : '[?]';
				output += `${rankDisplay} ${team.name} (${team.points} pts)\n`;
				
				team.members.forEach((m, idx) => {
					const name = m.real_name || m.username;
					const nrp = m.nrp || 'n/a';
					output += `${idx + 1}. ${name} (${nrp}) - ${m.total_points} pts\n`;
				});
				output += '\n';
			});
		}

		if (output.length > 4000) {
			output = output.substring(0, 4000) + '... (truncated)';
		}

		const embed = new EmbedBuilder()
			.setColor(0x0099FF)
			.setTitle(`📊 Summary for ${ctf.ctf_name}`)
			.setDescription(output)
			.setTimestamp();

		return interaction.editReply({ embeds: [embed] });
	}
}

module.exports = { SummarizeCTFCommand };
