/**
 * CTFBot - Discord bot for managing CTF competitions
 * @module index
 */

const { SapphireClient } = require('@sapphire/framework');
const { GatewayIntentBits } = require('discord.js');
const { initDatabase } = require('./database');
require('dotenv/config');

// Initialize database
initDatabase();

/**
 * Create and configure the Sapphire client
 */
const client = new SapphireClient({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
		GatewayIntentBits.GuildMembers
	],
	loadMessageCommandListeners: true,
	baseUserDirectory: __dirname,
	// Register commands to a specific guild for instant updates during development
	// For production, remove defaultGuildId to register globally
	...(process.env.GUILD_ID && { 
		defaultGuildId: process.env.GUILD_ID 
	})
});

// Login to Discord with your bot token
client.login(process.env.DISCORD_TOKEN);
