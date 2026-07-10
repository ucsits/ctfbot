/**
 * Date and timezone utility functions
 * @module utils/date
 */

const { DateTime } = require('luxon');
const { validateDateFormat, validateTimezone } = require('../validators');

function parseLocalDateToUTC(dateStr, timezone) {
	const { day, month, year, hour, minute } = validateDateFormat(dateStr);
	validateTimezone(timezone);

	const localDate = DateTime.fromObject(
		{
			year,
			month,
			day,
			hour,
			minute,
			second: 0
		},
		{
			zone: timezone
		}
	);

	return localDate.toUTC().toJSDate();
}

function formatDiscordTimestamp(date, style = 'F') {
	const timestamp = Math.floor(date.getTime() / 1000);
	return `<t:${timestamp}:${style}>`;
}

/**
 * Build a user-friendly string showing what date was parsed and how it maps to UTC.
 * @param {string} dateStr - Original user input (DD-MM-YYYY HH:MM)
 * @param {string} timezone - IANA timezone string
 * @param {Date} utcDate - The resulting UTC date
 * @returns {string} Formatted interpretation string
 */
function formatDateInterpretation(dateStr, timezone, utcDate) {
	const ts = Math.floor(utcDate.getTime() / 1000);
	return `📅 **Your input:** ${dateStr} (${timezone})
🌐 **UTC:** <t:${ts}:F> (<t:${ts}:R>)`;
}

function hoursToMs(hours) {
	return hours * 60 * 60 * 1000;
}

function daysToMs(days) {
	return days * 24 * 60 * 60 * 1000;
}

function validateEventDate(date, fieldName = 'Event') {
	if (date < new Date()) {
		throw new Error(`❌ ${fieldName} date must be in the future.`);
	}
	return true;
}

function validateEndDateAfterStart(startDate, endDate) {
	if (endDate <= startDate) {
		throw new Error('❌ End date must be after start date.');
	}
	return true;
}

module.exports = {
	parseLocalDateToUTC,
	formatDateInterpretation,
	formatDiscordTimestamp,
	hoursToMs,
	daysToMs,
	validateEventDate,
	validateEndDateAfterStart
};
