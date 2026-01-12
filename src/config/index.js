require('dotenv/config');

class ConfigurationError extends Error {
	constructor(message) {
		super(message);
		this.name = 'ConfigurationError';
	}
}

const validateEnv = () => {
	const required = ['DISCORD_TOKEN', 'CTF_CATEGORY_ID'];
	const missing = required.filter(key => !process.env[key]);

	if (missing.length > 0) {
		throw new ConfigurationError(`Missing required environment variables: ${missing.join(', ')}`);
	}
};

const config = {
	validate: validateEnv,

	discord: {
		get token() {
			if (!process.env.DISCORD_TOKEN) {
				throw new ConfigurationError('DISCORD_TOKEN environment variable is not set');
			}
			return process.env.DISCORD_TOKEN;
		},
		get guildId() {
			return process.env.GUILD_ID || null;
		}
	},

	ctf: {
		get categoryId() {
			if (!process.env.CTF_CATEGORY_ID) {
				throw new ConfigurationError('CTF_CATEGORY_ID environment variable is not set');
			}
			return process.env.CTF_CATEGORY_ID;
		}
	},

	node: {
		get env() {
			return process.env.NODE_ENV || 'development';
		},
		get isTest() {
			return this.env === 'test';
		},
		get isProduction() {
			return this.env === 'production';
		},
		get isDevelopment() {
			return this.env === 'development';
		}
	}
};

module.exports = config;
