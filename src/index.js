/**
 * CTFBot - Discord bot for managing CTF competitions
 * @module index
 */

const { SapphireClient } = require('@sapphire/framework');
const { GatewayIntentBits } = require('discord.js');
const { initDatabase } = require('./database');
const config = require('./config');

config.validate();

initDatabase();

const client = new SapphireClient({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
		GatewayIntentBits.GuildMembers
	],
	loadMessageCommandListeners: true,
	baseUserDirectory: __dirname,
	...(config.discord.guildId && {
		defaultGuildId: config.discord.guildId
	})
});

client.login(config.discord.token);
