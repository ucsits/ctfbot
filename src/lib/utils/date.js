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

function hoursToMs(hours) {
	return hours * 60 * 60 * 1000;
}

function daysToMs(days) {
	return days * 24 * 60 * 60 * 1000;
}

module.exports = {
	parseLocalDateToUTC,
	formatDiscordTimestamp,
	hoursToMs,
	daysToMs
};
