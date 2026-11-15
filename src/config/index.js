require('dotenv/config');

class ConfigurationError extends Error {
	constructor(message) {
		super(message);
		this.name = 'ConfigurationError';
	}
}

/**
 * Read a positive integer from the environment, falling back when unset or
 * malformed. Zero is allowed only when `min` is zero.
 */
const envInt = (name, fallback, min = 1) => {
	const raw = Number(process.env[name]);
	return Number.isFinite(raw) && raw >= min ? Math.floor(raw) : fallback;
};

/** Read a comma-separated id list, trimmed and without empty entries. */
const envList = name =>
	(process.env[name] || '')
		.split(',')
		.map(id => id.trim())
		.filter(Boolean);

const validateEnv = () => {
	const required = ['DISCORD_TOKEN', 'CTF_CATEGORY_ID'];
	const missing = required.filter(key => !process.env[key]);

	if (missing.length > 0) {
		throw new ConfigurationError(`Missing required environment variables ${missing.join(', ')}`);
	}
};

const config = {
	validate: validateEnv,

	logging: {
		get level() {
			return process.env.LOG_LEVEL || 'info';
		},
		get verbose() {
			return process.env.VERBOSE_LOGGING === 'true';
		}
	},

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
	},

	admin: {
		get ids() {
			const envIds =
				process.env.ADMIN_IDS?.split(',')
					.map(id => id.trim())
					.filter(Boolean) || [];
			return envIds;
		},
		get isEnvConfigured() {
			return this.ids.length > 0;
		}
	},

	google: {
		get enabled() {
			return process.env.GOOGLE_CALENDAR_ENABLED === 'true';
		},
		get clientId() {
			return process.env.GOOGLE_CLIENT_ID || '';
		},
		get clientSecret() {
			return process.env.GOOGLE_CLIENT_SECRET || '';
		},
		get refreshToken() {
			return process.env.GOOGLE_REFRESH_TOKEN || '';
		},
		get calendarId() {
			return process.env.GOOGLE_CALENDAR_ID || '';
		}
	},

	llm: {
		get baseUrl() {
			return (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
		},
		get apiKey() {
			return process.env.OPENAI_API_KEY || '';
		},
		get model() {
			return process.env.OPENAI_MODEL || '';
		},
		get timeoutMs() {
			const ms = Number(process.env.OPENAI_TIMEOUT_MS);
			return Number.isFinite(ms) && ms > 0 ? ms : 300_000;
		},
		get isConfigured() {
			return Boolean(this.apiKey && this.model);
		}
	},

	taskSuggestions: {
		get enabled() {
			return process.env.TASK_SUGGESTIONS_ENABLED === 'true';
		}
	},

	/**
	 * Proactive chat lets the bot speak up on its own in any channel, using
	 * tools (web search, channel/user memory) and a budget that adapts when
	 * people ignore it.
	 */
	chat: {
		get enabled() {
			return process.env.CHAT_ENABLED === 'true';
		},
		/** Wait this long after the last human message before considering a pass. */
		get quietMs() {
			return envInt('CHAT_QUIET_MS', 20_000);
		},
		/** Never speak twice in the same channel faster than this. */
		get cooldownMs() {
			return envInt('CHAT_COOLDOWN_MS', 6 * 60_000);
		},
		get maxPerHour() {
			return envInt('CHAT_MAX_PER_HOUR', 5);
		},
		get maxPerDay() {
			return envInt('CHAT_MAX_PER_DAY', 20);
		},
		/** Whole-guild daily cap. A busy server cannot run up an unbounded bill. */
		get guildMaxPerDay() {
			return envInt('CHAT_GUILD_MAX_PER_DAY', 200);
		},
		/**
		 * Chance of speaking in a busy channel with no explicit trigger. Keeps
		 * the bot from feeling mechanical without making it chatty.
		 */
		get sparkProbability() {
			const raw = Number(process.env.CHAT_SPARK_PROBABILITY);
			return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.15;
		},
		/** Channels the bot must never speak in (announcements, logs, ...). */
		get denyChannelIds() {
			return envList('CHAT_DENY_CHANNEL_IDS');
		},
		get maxMessageChars() {
			return envInt('CHAT_MAX_MESSAGE_CHARS', 600);
		},
		/** Whether tool calling may be used at all. */
		get toolsEnabled() {
			return process.env.LLM_TOOLS_ENABLED !== 'false';
		},
		search: {
			get apiKey() {
				return process.env.SERPBASE_API_KEY || '';
			},
			get isConfigured() {
				return Boolean(this.apiKey);
			},
			get dailyCredits() {
				return envInt('SERPBASE_DAILY_CREDITS', 100, 0);
			},
			get cacheHours() {
				return envInt('SERPBASE_CACHE_HOURS', 24);
			},
			get timeoutMs() {
				return envInt('SERPBASE_TIMEOUT_MS', 10_000);
			},
			get country() {
				return process.env.SERPBASE_GL || 'id';
			},
			get language() {
				return process.env.SERPBASE_HL || 'id';
			}
		}
	}
};

module.exports = config;
