const { Command } = require('@sapphire/framework');
const { EmbedBuilder } = require('discord.js');
const { getIdHints } = require('../lib/utils');
const { COMMON_TIMEZONES } = require('../lib/utils/timezones');

class TimezonesCommand extends Command {
	constructor(context, options) {
		super(context, {
			...options,
			name: 'timezones',
			description: 'List common IANA timezones by region'
		});
	}

	registerApplicationCommands(registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription(this.description)
				.addStringOption(opt =>
					opt.setName('region')
						.setDescription('Filter by region')
						.setRequired(false)
						.addChoices(
							{ name: 'Asia', value: 'Asia' },
							{ name: 'America', value: 'America' },
							{ name: 'Europe', value: 'Europe' },
							{ name: 'Africa', value: 'Africa' },
							{ name: 'Australia', value: 'Australia' },
							{ name: 'Pacific', value: 'Pacific' }
						)
				),
			{
				idHints: getIdHints(this.name)
			}
		);
	}

	async chatInputRun(interaction) {
		await interaction.deferReply({ ephemeral: true });

		const region = interaction.options.getString('region');

		const embed = new EmbedBuilder()
			.setColor(0x3498DB)
			.setTitle('🕐 Common Timezones')
			.setTimestamp();

		if (region && COMMON_TIMEZONES[region]) {
			embed.setDescription(`**${region}**`);
			embed.addFields({
				name: 'Timezones',
				value: COMMON_TIMEZONES[region].map(tz => `\`${tz}\``).join('\n'),
				inline: false
			});
		} else {
			for (const [regionName, tzList] of Object.entries(COMMON_TIMEZONES)) {
				embed.addFields({
					name: regionName,
					value: tzList.map(tz => `\`${tz}\``).join(', '),
					inline: true
				});
			}
		}

		embed.setFooter({ text: 'Use these values in the timezone option of /createctf, /schedule, or /task' });

		return interaction.editReply({ embeds: [embed] });
	}
}

module.exports = { TimezonesCommand };
