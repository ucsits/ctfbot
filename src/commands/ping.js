const { Command } = require('@sapphire/framework');

class PingCommand extends Command {
	constructor(context, options) {
		super(context, {
			...options,
			name: 'ping',
			description: "Check the bot's response time"
		});
	}

	async messageRun(message) {
		await message.reply('Pinging...');

		const ping = Math.round(this.container.client.ws.ping);

		return message.edit(`Pong!\nAPI latency is ${ping}ms`);
	}

	async chatInputRun(interaction) {
		await interaction.reply({ content: 'Pinging...' });

		const ping = Math.round(this.container.client.ws.ping);

		return interaction.editReply(`Pong!\nAPI latency is ${ping}ms`);
	}
}

module.exports = { PingCommand };
