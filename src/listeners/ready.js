const { Listener } = require('@sapphire/framework');
const { startReminderService } = require('../services/reminder');
const { startCalendarSyncService } = require('../services/calendarSync');

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

		// Start background calendar sync service
		startCalendarSyncService(client);
	}
}

module.exports = { ReadyListener };
