/**
 * Input validation utilities
 * @module validators
 */

const { ValidationError } = require('../errors');

/**
 * Validates a URL string
 * @param {string} url - URL to validate
 * @param {Object} [options] - Validation options
 * @param {string[]} [options.allowedProtocols=['http:', 'https:']] - Allowed protocols
 * @returns {boolean} True if valid
 * @throws {ValidationError} If URL is invalid
 */
function validateURL(url, options = {}) {
	const allowedProtocols = options.allowedProtocols || ['http:', 'https:'];
	
	try {
		const urlObj = new URL(url);
		if (!allowedProtocols.includes(urlObj.protocol)) {
			throw new ValidationError(
				`❌ Invalid URL protocol. Allowed: ${allowedProtocols.join(', ')}`
			);
		}
		return true;
	} catch (error) {
		if (error instanceof ValidationError) {
			throw error;
		}
		throw new ValidationError(
			'❌ Invalid URL format. Please provide a valid URL starting with http:// or https://'
		);
	}
}

/**
 * Validates a date string in DD-MM-YYYY HH:MM format
 * @param {string} dateStr - Date string to validate
 * @returns {Object} Parsed date components
 * @returns {string} return.day - Day (01-31)
 * @returns {string} return.month - Month (01-12)
 * @returns {string} return.year - Year (YYYY)
 * @returns {string} return.hour - Hour (00-23)
 * @returns {string} return.minute - Minute (00-59)
 * @throws {ValidationError} If date format is invalid
 */
function validateDateFormat(dateStr) {
	const dateMatch = dateStr.match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})$/);
	
	if (!dateMatch) {
		throw new ValidationError(
			'❌ Invalid date format. Please use: DD-MM-YYYY HH:MM (e.g., 31-12-2025 20:00)'
		);
	}

	const [, day, month, year, hour, minute] = dateMatch;
	
	// Validate ranges
	const dayNum = parseInt(day, 10);
	const monthNum = parseInt(month, 10);
	const yearNum = parseInt(year, 10);
	const hourNum = parseInt(hour, 10);
	const minuteNum = parseInt(minute, 10);

	if (dayNum < 1 || dayNum > 31) {
		throw new ValidationError('❌ Invalid day. Must be between 01 and 31.');
	}
	if (monthNum < 1 || monthNum > 12) {
		throw new ValidationError('❌ Invalid month. Must be between 01 and 12.');
	}
	if (yearNum < 2000 || yearNum > 2100) {
		throw new ValidationError('❌ Invalid year. Must be between 2000 and 2100.');
	}
	if (hourNum < 0 || hourNum > 23) {
		throw new ValidationError('❌ Invalid hour. Must be between 00 and 23.');
	}
	if (minuteNum < 0 || minuteNum > 59) {
		throw new ValidationError('❌ Invalid minute. Must be between 00 and 59.');
	}

	return { day, month, year, hour, minute };
}

/**
 * Validates an IANA timezone string
 * @param {string} timezone - Timezone to validate
 * @returns {boolean} True if valid
 * @throws {ValidationError} If timezone is invalid
 */
function validateTimezone(timezone) {
	try {
		// Test by creating a formatter with the timezone
		new Intl.DateTimeFormat('en-US', { timeZone: timezone });
		return true;
	} catch (error) {
		throw new ValidationError(
			'❌ Invalid timezone. Please use a valid IANA timezone (e.g., Asia/Jakarta, Europe/London, America/New_York)'
		);
	}
}

/**
 * Validates that a date is in the future
 * @param {Date} date - Date to validate
 * @returns {boolean} True if date is in the future
 * @throws {ValidationError} If date is in the past
 */
function validateFutureDate(date) {
	if (date < new Date()) {
		throw new ValidationError('❌ Event date must be in the future.');
	}
	return true;
}

/**
 * Validates a channel name
 * @param {string} name - Channel name to validate
 * @returns {string} Sanitized channel name
 */
function sanitizeChannelName(name) {
	// Convert to lowercase, replace spaces with hyphens, remove special chars
	return name
		.toLowerCase()
		.replace(/\s+/g, '-')
		.replace(/[^a-z0-9-]/g, '')
		.substring(0, 100); // Discord channel name limit
}

/**
 * Validates a username
 * @param {string} username - Username to validate
 * @returns {boolean} True if valid
 * @throws {ValidationError} If username is invalid
 */
function validateUsername(username) {
	if (!username || username.trim().length === 0) {
		throw new ValidationError('❌ Username cannot be empty.');
	}
	if (username.length > 100) {
		throw new ValidationError('❌ Username is too long (max 100 characters).');
	}
	return true;
}

module.exports = {
	validateURL,
	validateDateFormat,
	validateTimezone,
	validateFutureDate,
	sanitizeChannelName,
	validateUsername
};
