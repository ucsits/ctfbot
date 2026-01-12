/**
 * Date and timezone utility functions
 * @module utils/date
 */

const { validateDateFormat, validateTimezone } = require('../validators');

/**
 * Parse a date string in DD-MM-YYYY HH:MM format and convert it to UTC
 * based on the specified timezone
 *
 * @param {string} dateStr - Date string in DD-MM-YYYY HH:MM format
 * @param {string} timezone - IANA timezone (e.g., Asia/Jakarta, Europe/London)
 * @returns {Date} Date object in UTC
 * @throws {ValidationError} If date format is invalid or timezone is invalid
 *
 * @example
 * // Convert Jakarta time to UTC
 * const utcDate = parseLocalDateToUTC('31-12-2025 20:00', 'Asia/Jakarta');
 * console.log(utcDate); // Date object in UTC
 */
function parseLocalDateToUTC(dateStr, timezone) {
	// Validate and parse date components
	const { day, month, year, hour, minute } = validateDateFormat(dateStr);

	// Validate timezone
	validateTimezone(timezone);

	// Create a date formatter for the target timezone
	const formatter = new Intl.DateTimeFormat('en-US', {
		timeZone: timezone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false,
		timeZoneName: 'short'
	});

	// Parse the local time as UTC first
	const localAsUTC = new Date(`${year}-${month}-${day}T${hour}:${minute}:00Z`);

	// Get the parts when formatting this UTC time AS IF it were in the target timezone
	const parts = formatter.formatToParts(localAsUTC);
	const tzYear = parts.find(p => p.type === 'year').value;
	const tzMonth = parts.find(p => p.type === 'month').value;
	const tzDay = parts.find(p => p.type === 'day').value;
	const tzHour = parts.find(p => p.type === 'hour').value;
	const tzMinute = parts.find(p => p.type === 'minute').value;

	// Calculate the offset
	const offsetMs = localAsUTC.getTime() - new Date(`${tzYear}-${tzMonth}-${tzDay}T${tzHour}:${tzMinute}:00Z`).getTime();

	// Apply offset to get the correct UTC time for the local time in target timezone
	return new Date(localAsUTC.getTime() + offsetMs);
}

/**
 * Format a date for Discord timestamp
 *
 * @param {Date} date - Date to format
 * @param {string} [style='F'] - Discord timestamp style
 * @returns {string} Discord timestamp string
 *
 * @example
 * const date = new Date();
 * const timestamp = formatDiscordTimestamp(date);
 * // Returns: "<t:1234567890:F>"
 */
function formatDiscordTimestamp(date, style = 'F') {
	const timestamp = Math.floor(date.getTime() / 1000);
	return `<t:${timestamp}:${style}>`;
}

/**
 * Get the duration in milliseconds
 *
 * @param {number} hours - Number of hours
 * @returns {number} Duration in milliseconds
 */
function hoursToMs(hours) {
	return hours * 60 * 60 * 1000;
}

/**
 * Get the duration in milliseconds
 *
 * @param {number} days - Number of days
 * @returns {number} Duration in milliseconds
 */
function daysToMs(days) {
	return days * 24 * 60 * 60 * 1000;
}

module.exports = {
	parseLocalDateToUTC,
	formatDiscordTimestamp,
	hoursToMs,
	daysToMs
};
