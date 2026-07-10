/**
 * Input validation utilities
 * @module validators
 */

const { DateTime } = require('luxon');
const { ValidationError } = require('../errors');
const { suggestTimezones } = require('../utils/timezones');

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
 * Flexible date format patterns for validation (mirrors date.js FLEXIBLE_FORMATS).
 * @type {string[]}
 */
const FLEXIBLE_DATE_FORMATS = [
	'dd-MM-yyyy HH:mm',
	'dd-MM-yyyy HH:mm:ss',
	'dd-MM-yyyy',
	'dd/MM/yyyy HH:mm',
	'dd/MM/yyyy HH:mm:ss',
	'dd/MM/yyyy',
	'dd.MM.yyyy HH:mm',
	'dd.MM.yyyy',
	'd-M-yyyy H:m',
	'd-M-yyyy H:m:s',
	'd/M/yyyy H:m',
	'd/M/yyyy H:m:s',
	'yyyy-MM-dd HH:mm',
	'yyyy-MM-dd HH:mm:ss',
	'yyyy-MM-dd',
	'yyyy/MM/dd HH:mm',
	'yyyy/MM/dd',
	'MM/dd/yyyy HH:mm',
	'MM/dd/yyyy HH:mm:ss',
	'MM-dd-yyyy HH:mm',
	'M/d/yyyy H:m',
	'M/d/yyyy H:m:s',
];

/**
 * Validate a date string using flexible format matching.
 * Returns parsed components in the same shape as {@link validateDateFormat}.
 *
 * Also accepts:
 *   `1735689600`            (Unix timestamp seconds — Discord @time compatible)
 *   `<t:1735689600:F>`      (Discord @time helper format)
 *
 * @param {string} dateStr - Date string to validate
 * @returns {Object} Parsed date components
 * @returns {string} return.day - Day (01-31)
 * @returns {string} return.month - Month (01-12)
 * @returns {string} return.year - Year (YYYY)
 * @returns {string} return.hour - Hour (00-23)
 * @returns {string} return.minute - Minute (00-59)
 * @throws {ValidationError} If no format matches
 */
function validateFlexibleDateFormat(dateStr) {
	const trimmed = dateStr.trim();

	// 1. Discord @time helper format: <t:UNIX_SECONDS> or <t:UNIX_SECONDS:LETTER>
	const discordTimeMatch = trimmed.match(/^<t:(\d+)(?::[tTdDfFR])?>$/);
	if (discordTimeMatch) {
		const date = new Date(parseInt(discordTimeMatch[1], 10) * 1000);
		return {
			day: String(date.getUTCDate()).padStart(2, '0'),
			month: String(date.getUTCMonth() + 1).padStart(2, '0'),
			year: String(date.getUTCFullYear()),
			hour: String(date.getUTCHours()).padStart(2, '0'),
			minute: String(date.getUTCMinutes()).padStart(2, '0')
		};
	}

	// 2. Raw Unix timestamp (seconds) — 8-10 digit epoch
	const unixMatch = trimmed.match(/^(\d{8,10})(?:\.\d+)?$/);
	if (unixMatch) {
		const unixSeconds = parseInt(unixMatch[1], 10);
		const date = new Date(unixSeconds * 1000);
		if (date.getUTCFullYear() >= 2000 && date.getUTCFullYear() <= 2100) {
			return {
				day: String(date.getUTCDate()).padStart(2, '0'),
				month: String(date.getUTCMonth() + 1).padStart(2, '0'),
				year: String(date.getUTCFullYear()),
				hour: String(date.getUTCHours()).padStart(2, '0'),
				minute: String(date.getUTCMinutes()).padStart(2, '0')
			};
		}
	}

	// 3. Try each known date format
	for (const fmt of FLEXIBLE_DATE_FORMATS) {
		const dt = DateTime.fromFormat(trimmed, fmt);
		if (dt.isValid) {
			return {
				day: String(dt.day).padStart(2, '0'),
				month: String(dt.month).padStart(2, '0'),
				year: String(dt.year),
				hour: String(dt.hour).padStart(2, '0'),
				minute: String(dt.minute).padStart(2, '0')
			};
		}
	}

	// 4. ISO 8601 fallback
	const iso = DateTime.fromISO(trimmed);
	if (iso.isValid) {
		return {
			day: String(iso.day).padStart(2, '0'),
			month: String(iso.month).padStart(2, '0'),
			year: String(iso.year),
			hour: String(iso.hour).padStart(2, '0'),
			minute: String(iso.minute).padStart(2, '0')
		};
	}

	throw new ValidationError(
		'❌ Invalid date format. Try:\n' +
		'  `31-12-2025 20:00`   (DD-MM-YYYY HH:MM)\n' +
		'  `1735689600`         (Unix timestamp — Discord @time compatible)'
	);
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
		const suggestions = suggestTimezones(timezone);
		const suggestionStr = suggestions.length > 0
			? ` Did you mean: ${suggestions.map(s => '\`' + s + '\`').join(', ')}?`
			: ' Use `/timezones` to see common timezones.';
		throw new ValidationError(
			`❌ Invalid timezone \`${timezone}\`.${suggestionStr}`
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
	validateFlexibleDateFormat,
	validateTimezone,
	validateFutureDate,
	sanitizeChannelName,
	validateUsername
};
