/**
 * CTFBot - Discord bot for managing CTF competitions
 * @module index
 */

const { SapphireClient, LogLevel } = require('@sapphire/framework');
const { GatewayIntentBits, Partials } = require('discord.js');
const { initDatabase } = require('./database');
const config = require('./config');
const luce = require('./lib/luce');
const { logger } = require('./lib/logger');

config.validate();

logger.info('Starting CTFBot...');

// Map LOG_LEVEL env to Sapphire LogLevel
const LOG_LEVEL_MAP = {
	trace: LogLevel.Trace,
	debug: LogLevel.Debug,
	info: LogLevel.Info,
	warn: LogLevel.Warn,
	error: LogLevel.Error,
	none: LogLevel.None
};

const logLevel = LOG_LEVEL_MAP[config.logging.level] ?? LogLevel.Info;

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
	logger: {
		level: logLevel
	},
	...(config.discord.guildId && {
		defaultGuildId: config.discord.guildId
	})
});

// Register the Discord client with luce for block notifications
luce.setDiscordClient(client);

client.login(config.discord.token);
