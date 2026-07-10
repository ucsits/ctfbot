const { Listener } = require('@sapphire/framework');
const { startReminderService } = require('../services/reminder');

class ReadyListener extends Listener {
	constructor(context, options) {
		super(context, {
			...options,
			once: true,
			event: 'clientReady'
		});
	}

	run(client) {
		const { username, id } = client.user;
		this.container.logger.info(`Successfully logged in as ${username} (${id})`);

		// Start background reminder service
		startReminderService(client);
	}
}

module.exports = { ReadyListener };
