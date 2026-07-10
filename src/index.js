/**
 * CTFBot - Discord bot for managing CTF competitions
 * @module index
 */

const { SapphireClient } = require('@sapphire/framework');
const { GatewayIntentBits, Partials } = require('discord.js');
const { initDatabase } = require('./database');
const config = require('./config');

config.validate();

initDatabase();

const client = new SapphireClient({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.GuildMessageReactions,
		GatewayIntentBits.MessageContent,
		GatewayIntentBits.GuildMembers
	],
	partials: [
		Partials.Message,
		Partials.Channel,
		Partials.Reaction
	],
	loadMessageCommandListeners: true,
	baseUserDirectory: __dirname,
	...(config.discord.guildId && {
		defaultGuildId: config.discord.guildId
	})
});

client.login(config.discord.token);
