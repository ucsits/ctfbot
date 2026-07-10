/**
 * Date and timezone utility functions
 * @module utils/date
 */

const { DateTime } = require('luxon');
const { validateTimezone } = require('../validators');
const { ValidationError } = require('../errors');

/**
 * Flexible date format patterns tried in order.
 * DD-first formats have priority to disambiguate DD-MM vs MM-DD.
 * @type {string[]}
 */
const FLEXIBLE_FORMATS = [
	// DD-MM-YYYY — highest priority
	'dd-MM-yyyy HH:mm',
	'dd-MM-yyyy HH:mm:ss',
	'dd-MM-yyyy',
	// DD/MM/YYYY
	'dd/MM/yyyy HH:mm',
	'dd/MM/yyyy HH:mm:ss',
	'dd/MM/yyyy',
	// DD.MM.YYYY
	'dd.MM.yyyy HH:mm',
	'dd.MM.yyyy',
	// single-digit D-M-YYYY
	'd-M-yyyy H:m',
	'd-M-yyyy H:m:s',
	'd/M/yyyy H:m',
	'd/M/yyyy H:m:s',
	// YYYY-MM-DD (ISO-like)
	'yyyy-MM-dd HH:mm',
	'yyyy-MM-dd HH:mm:ss',
	'yyyy-MM-dd',
	'yyyy/MM/dd HH:mm',
	'yyyy/MM/dd',
	// US-style MM/DD/YYYY (last — highest ambiguity)
	'MM/dd/yyyy HH:mm',
	'MM/dd/yyyy HH:mm:ss',
	'MM-dd-yyyy HH:mm',
	'M/d/yyyy H:m',
	'M/d/yyyy H:m:s',
];

/**
 * Parse a date string in a relaxed, multi-format fashion and convert to UTC.
 *
 * Accepted formats include:
 *   `31-12-2025 20:00`      (DD-MM-YYYY HH:MM)
 *   `31-12-2025`            (DD-MM-YYYY date-only → midnight)
 *   `31/12/2025 20:00`      (DD/MM/YYYY HH:MM)
 *   `2025-12-31 20:00`      (YYYY-MM-DD HH:MM)
 *   `31.12.2025 20:00`      (DD.MM.YYYY HH:MM)
 *   `1-12-2025 8:0`         (single-digit day/month/hour)
 *   `12/31/2025 20:00`      (MM/DD/YYYY HH:MM — US style)
 *   `2025-12-31T20:00:00Z`  (ISO 8601)
 *   `1735689600`            (Unix timestamp seconds — Discord @time compatible)
 *   `<t:1735689600:F>`      (Discord @time helper format)
 *
 * @param {string} dateStr - Raw user date string
 * @param {string} timezone - IANA timezone identifier
 * @returns {Date} UTC Date object
 * @throws {ValidationError} When no format matches
 */
function parseFlexibleDateToUTC(dateStr, timezone) {
	validateTimezone(timezone);

	const trimmed = dateStr.trim();

	// 1. Try Discord @time helper format: <t:UNIX_SECONDS> or <t:UNIX_SECONDS:LETTER>
	const discordTimeMatch = trimmed.match(/^<t:(\d+)(?::[tTdDfFR])?>$/);
	if (discordTimeMatch) {
		const unixSeconds = parseInt(discordTimeMatch[1], 10);
		return new Date(unixSeconds * 1000);
	}

	// 2. Try raw Unix timestamp (seconds) — 10-digit epoch or any reasonable-length digits
	const unixMatch = trimmed.match(/^(\d{8,10})(?:\.\d+)?$/);
	if (unixMatch) {
		const unixSeconds = parseInt(unixMatch[1], 10);
		// Sanity check: year must be between 2000 and 2100
		const d = new Date(unixSeconds * 1000);
		if (d.getFullYear() >= 2000 && d.getFullYear() <= 2100) {
			return d;
		}
	}

	// 3. Try each known date format
	for (const fmt of FLEXIBLE_FORMATS) {
		const dt = DateTime.fromFormat(trimmed, fmt, { zone: timezone });
		if (dt.isValid) {
			return dt.toUTC().toJSDate();
		}
	}

	// 4. Catch-all: try ISO 8601 (handles e.g. "2025-12-31T20:00:00Z")
	const iso = DateTime.fromISO(trimmed, { zone: timezone });
	if (iso.isValid) {
		return iso.toUTC().toJSDate();
	}

	throw new ValidationError(
		'❌ Invalid date format. Try one of these examples:\n' +
		'  `31-12-2025 20:00`   (DD-MM-YYYY HH:MM)\n' +
		'  `2025-12-31 20:00`   (YYYY-MM-DD HH:MM)\n' +
		'  `31/12/2025 20:00`   (DD/MM/YYYY HH:MM)\n' +
		'  `1735689600`         (Unix timestamp — Discord @time compatible)'
	);
}

/**
 * Parse a local date string to UTC (alias for {@link parseFlexibleDateToUTC}).
 * @param {string} dateStr - Date string
 * @param {string} timezone - IANA timezone
 * @returns {Date} UTC Date
 */
function parseLocalDateToUTC(dateStr, timezone) {
	return parseFlexibleDateToUTC(dateStr, timezone);
}

function formatDiscordTimestamp(date, style = 'F') {
	const timestamp = Math.floor(date.getTime() / 1000);
	return `<t:${timestamp}:${style}>`;
}

/**
 * Build a user-friendly string showing what date was parsed and how it maps to UTC.
 * @param {string} dateStr - Original user input (any supported format)
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
	parseFlexibleDateToUTC,
	formatDateInterpretation,
	formatDiscordTimestamp,
	hoursToMs,
	daysToMs,
	validateEventDate,
	validateEndDateAfterStart,
	computePeriodRange
};
