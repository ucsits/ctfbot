/**
 * Custom error classes for better error handling
 * @module errors
 */

/**
 * Base error class for all CTFBot errors
 */
class CTFBotError extends Error {
	/**
	 * @param {string} message - Error message
	 * @param {Object} [options] - Additional options
	 * @param {boolean} [options.ephemeral=true] - Whether error should be shown ephemerally in Discord
	 */
	constructor(message, options = {}) {
		super(message);
		this.name = this.constructor.name;
		this.ephemeral = options.ephemeral !== false;
		Error.captureStackTrace(this, this.constructor);
	}
}

/**
 * Error for invalid user input
 */
class ValidationError extends CTFBotError {
	constructor(message, options = {}) {
		super(message, options);
	}
}

/**
 * Error for permission-related issues
 */
class PermissionError extends CTFBotError {
	constructor(message, options = {}) {
		super(message, options);
	}
}

/**
 * Error for database operations
 */
class DatabaseError extends CTFBotError {
	constructor(message, options = {}) {
		super(message, { ...options, ephemeral: true });
	}
}

/**
 * Error for external API failures (e.g., CTFd)
 */
class ExternalAPIError extends CTFBotError {
	constructor(message, options = {}) {
		super(message, options);
		this.isWarning = true; // Indicates this might not be fatal
	}
}

/**
 * Error for configuration issues
 */
class ConfigurationError extends CTFBotError {
	constructor(message, options = {}) {
		super(message, options);
	}
}

module.exports = {
	CTFBotError,
	ValidationError,
	PermissionError,
	DatabaseError,
	ExternalAPIError,
	ConfigurationError
};
