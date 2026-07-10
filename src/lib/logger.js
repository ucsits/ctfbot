/**
 * Unified Logger Module
 * @module logger
 *
 * Provides a consistent logging interface that works both before and
 * after the SapphireClient is initialized.
 *
 * - Pre-init: falls back to timestamped console output
 * - Post-init: delegates to Sapphire's container.logger (if available)
 * - Respects LOG_LEVEL env var: error, warn, info, debug, trace
 * - Supports child loggers with context prefixes (e.g. "[CTFd]", "[DB]")
 */

const LOG_LEVELS = {
	trace: 0,
	debug: 1,
	info: 2,
	warn: 3,
	error: 4
};

let currentLevel = 'info';

/**
 * Resolve the numeric log level from env or default.
 */
function resolveLogLevel() {
	const envLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
	return LOG_LEVELS[envLevel] !== undefined ? envLevel : 'info';
}

currentLevel = resolveLogLevel();

/**
 * Check if a log message at the given level should be emitted.
 */
function shouldLog(level) {
	return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

/**
 * Create a timestamp string suitable for pre-init console fallback.
 */
function timestamp() {
	return new Date().toISOString();
}

/**
 * Try to get Sapphire's container.logger.
 * Returns null if the container isn't ready yet or Sapphire isn't loaded.
 */
function getSapphireLogger() {
	try {
		const { container } = require('@sapphire/framework');
		return container.logger || null;
	} catch {
		return null;
	}
}

/**
 * Format a log message with optional arguments.
 */
function formatMessage(level, context, message, args) {
	const prefix = context ? `[${context}]` : '';
	const levelTag = level.toUpperCase().padEnd(5);

	if (args.length > 0) {
		const extra = args.length === 1 ? args[0] : args;
		return { formatted: `${prefix} ${message}`, extra };
	}
	return { formatted: `${prefix} ${message}`, extra: undefined };
}

/**
 * Logger instance with methods matching SapphireLogger API.
 *
 * @typedef {Object} Logger
 * @property {function} trace - Log at trace level
 * @property {function} debug - Log at debug level
 * @property {function} info - Log at info level
 * @property {function} warn - Log at warn level
 * @property {function} error - Log at error level
 * @property {function} child - Create a child logger with a context prefix
 * @property {function} setLevel - Set the current log level
 */

/**
 * Create a logger instance.
 *
 * @param {string} [context] - Optional context prefix (e.g. "DB", "CTFd")
 * @returns {Logger}
 */
function createLogger(context) {
	function log(level, message, ...args) {
		if (!shouldLog(level)) return;

		const sapphireLogger = getSapphireLogger();

		if (sapphireLogger && LOG_LEVELS[level] >= LOG_LEVELS.info) {
			// SapphireLogger has: trace, debug, info, warn, error
			if (sapphireLogger[level]) {
				const { formatted, extra } = formatMessage(level, context, message, args);
				if (extra !== undefined) {
					sapphireLogger[level](formatted, extra);
				} else {
					sapphireLogger[level](formatted);
				}
				return;
			}
		}

		// Fallback: formatted console output
		const { formatted, extra } = formatMessage(level, context, message, args);
		const ts = timestamp();
		const levelTag = level.toUpperCase().padEnd(5);

		switch (level) {
			case 'error':
				if (extra !== undefined) {
					console.error(`[${ts}] ${levelTag} ${formatted}`, extra);
				} else {
					console.error(`[${ts}] ${levelTag} ${formatted}`);
				}
				break;
			case 'warn':
				if (extra !== undefined) {
					console.warn(`[${ts}] ${levelTag} ${formatted}`, extra);
				} else {
					console.warn(`[${ts}] ${levelTag} ${formatted}`);
				}
				break;
			case 'info':
				if (extra !== undefined) {
					console.info(`[${ts}] ${levelTag} ${formatted}`, extra);
				} else {
					console.info(`[${ts}] ${levelTag} ${formatted}`);
				}
				break;
			case 'debug':
			case 'trace':
			default:
				if (extra !== undefined) {
					console.log(`[${ts}] ${levelTag} ${formatted}`, extra);
				} else {
					console.log(`[${ts}] ${levelTag} ${formatted}`);
				}
				break;
		}
	}

	return {
		trace: (message, ...args) => log('trace', message, ...args),
		debug: (message, ...args) => log('debug', message, ...args),
		info: (message, ...args) => log('info', message, ...args),
		warn: (message, ...args) => log('warn', message, ...args),
		error: (message, ...args) => log('error', message, ...args),

		/**
		 * Create a child logger with an additional context prefix.
		 * @param {string} childContext
		 * @returns {Logger}
		 */
		child(childContext) {
			const combined = context
				? `${context}|${childContext}`
				: childContext;
			return createLogger(combined);
		},

		/**
		 * Dynamically change the log level at runtime.
		 * @param {string} level
		 */
		setLevel(level) {
			if (LOG_LEVELS[level] !== undefined) {
				currentLevel = level;
			}
		},

		/**
		 * Get the current log level name.
		 * @returns {string}
		 */
		getLevel() {
			return currentLevel;
		}
	};
}

// ── Singleton ────────────────────────────────────────────────────
const rootLogger = createLogger();

/**
 * Re-read LOG_LEVEL from env (useful after config reload).
 */
function refreshLogLevel() {
	currentLevel = resolveLogLevel();
}

module.exports = {
	createLogger,
	refreshLogLevel,
	logger: rootLogger
};
