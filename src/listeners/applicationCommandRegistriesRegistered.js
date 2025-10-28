const { Listener } = require('@sapphire/framework');
const fs = require('fs');
const path = require('path');

class ApplicationCommandRegistriesRegisteredListener extends Listener {
	constructor(context, options) {
		super(context, {
			...options,
			event: 'applicationCommandRegistriesRegistered'
		});
	}

	async run(registries) {
		// File to store command IDs
		const idHintsFile = path.join(__dirname, '..', 'commandIds.json');
		
		// Load existing command IDs
		let commandIds = {};
		if (fs.existsSync(idHintsFile)) {
			try {
				commandIds = JSON.parse(fs.readFileSync(idHintsFile, 'utf8'));
			} catch (error) {
				this.container.logger.warn('Failed to load command IDs, starting fresh');
			}
		}

		// Fetch all application commands from Discord
		try {
			const commands = await this.container.client.application.commands.fetch();
			
			let updated = false;
			for (const [id, command] of commands) {
				if (!commandIds[command.name] || !commandIds[command.name].includes(id)) {
					if (!commandIds[command.name]) {
						commandIds[command.name] = [];
					}
					commandIds[command.name].push(id);
					updated = true;
					this.container.logger.info(`Captured ID for command "${command.name}": ${id}`);
				}
			}

			// Also check guild commands if GUILD_ID is set
			if (process.env.GUILD_ID) {
				const guild = await this.container.client.guilds.fetch(process.env.GUILD_ID);
				const guildCommands = await guild.commands.fetch();
				
				for (const [id, command] of guildCommands) {
					if (!commandIds[command.name] || !commandIds[command.name].includes(id)) {
						if (!commandIds[command.name]) {
							commandIds[command.name] = [];
						}
						commandIds[command.name].push(id);
						updated = true;
						this.container.logger.info(`Captured guild ID for command "${command.name}": ${id}`);
					}
				}
			}

			// Save updated command IDs
			if (updated) {
				fs.writeFileSync(idHintsFile, JSON.stringify(commandIds, null, 2), 'utf8');
				this.container.logger.info('Command IDs saved to commandIds.json');
			}
		} catch (error) {
			this.container.logger.error('Failed to fetch command IDs:', error);
		}
	}
}

module.exports = { ApplicationCommandRegistriesRegisteredListener };
