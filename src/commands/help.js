const { Command } = require('@sapphire/framework');
const { getIdHints } = require('../utils');

class HelpCommand extends Command {
	constructor(context, options) {
		super(context, {
			...options,
			name: 'help',
			description: 'Display available commands'
		});
	}

	async messageRun(message) {
		const commands = this.container.stores.get('commands');
		
		const commandList = commands
			.map(cmd => `**${cmd.name}** - ${cmd.description}`)
			.join('\n');

		return message.reply({
			content: `📚 **Available Commands:**\n${commandList}`
		});
	}

	registerApplicationCommands(registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription(this.description),
			{
				idHints: getIdHints(this.name)
			}
		);
	}

	async chatInputRun(interaction) {
		const commands = this.container.stores.get('commands');
		
		const commandList = commands
			.map(cmd => `**${cmd.name}** - ${cmd.description}`)
			.join('\n');

		return interaction.reply({
			content: `📚 **Available Commands:**\n${commandList}`
		});
	}
}

module.exports = { HelpCommand };
