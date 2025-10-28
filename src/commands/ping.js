const { Command } = require('@sapphire/framework');

class PingCommand extends Command {
	constructor(context, options) {
		super(context, {
			...options,
			name: 'ping',
			description: 'Check the bot\'s response time'
		});
	}

	async messageRun(message) {
		const msg = await message.reply('Pinging...');

		const ping = Math.round(this.container.client.ws.ping);

		return msg.edit(`Pong! 🏓\nAPI Latency: ${ping}ms`);
	}

	registerApplicationCommands(registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription(this.description),
			{ idHints: ['1432584484813013002'] }
		);
	}

	async chatInputRun(interaction) {
		const msg = await interaction.reply({ content: 'Pinging...' });

		const ping = Math.round(this.container.client.ws.ping);

		return interaction.editReply(`Pong! 🏓\nAPI Latency: ${ping}ms`);
	}
}

module.exports = { PingCommand };
