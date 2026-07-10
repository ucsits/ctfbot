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

/**
 * Compute unix-second range for a period relative to now.
 *
 * @param {'week'|'month'|'quarter'|'year'} period
 * @param {number} now - Current unix timestamp (seconds)
 * @returns {{ start: number, end: number }}
 */
function computePeriodRange(period, now) {
	const date = new Date(now * 1000);
	const startOfDay = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

	switch (period) {
		case 'week': {
			// Start of current ISO week (Monday)
			const dayOfWeek = date.getUTCDay() || 7; // Mon=1 … Sun=7
			const mondayOffset = (dayOfWeek - 1) * 86400;
			const weekStart = startOfDay / 1000 - mondayOffset;
			return { start: weekStart, end: weekStart + 7 * 86400 - 1 };
		}
		case 'month': {
			const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000;
			const nextMonth = date.getUTCMonth() + 1;
			const monthEnd = nextMonth === 12
				? Date.UTC(date.getUTCFullYear() + 1, 0, 1) / 1000 - 1
				: Date.UTC(date.getUTCFullYear(), nextMonth, 1) / 1000 - 1;
			return { start: monthStart, end: monthEnd };
		}
		case 'quarter': {
			const q = Math.floor(date.getUTCMonth() / 3);
			const qStart = Date.UTC(date.getUTCFullYear(), q * 3, 1) / 1000;
			const qEnd = Date.UTC(date.getUTCFullYear(), (q + 1) * 3, 1) / 1000 - 1;
			return { start: qStart, end: qEnd };
		}
		case 'year': {
			const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1) / 1000;
			const yearEnd = Date.UTC(date.getUTCFullYear() + 1, 0, 1) / 1000 - 1;
			return { start: yearStart, end: yearEnd };
		}
		default:
			return { start: 0, end: Infinity };
	}
}

module.exports = {
	parseLocalDateToUTC,
	formatDateInterpretation,
	formatDiscordTimestamp,
	hoursToMs,
	daysToMs,
	validateEventDate,
	validateEndDateAfterStart,
	computePeriodRange
};
