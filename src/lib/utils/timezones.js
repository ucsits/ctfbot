/**
 * Timezone discovery utilities
 * @module utils/timezones
 *
 * Provides common IANA timezone lists grouped by region
 * and search helpers for user-facing timezone discovery.
 */

/** Common timezones grouped by continent/region */
const COMMON_TIMEZONES = {
	'Asia': [
		'Asia/Jakarta',
		'Asia/Makassar',
		'Asia/Jayapura',
		'Asia/Tokyo',
		'Asia/Seoul',
		'Asia/Shanghai',
		'Asia/Taipei',
		'Asia/Hong_Kong',
		'Asia/Singapore',
		'Asia/Kuala_Lumpur',
		'Asia/Bangkok',
		'Asia/Ho_Chi_Minh',
		'Asia/Dhaka',
		'Asia/Kolkata',
		'Asia/Karachi',
		'Asia/Dubai',
		'Asia/Riyadh',
		'Asia/Manila'
	],
	'America': [
		'America/New_York',
		'America/Chicago',
		'America/Denver',
		'America/Los_Angeles',
		'America/Anchorage',
		'America/Phoenix',
		'America/Juneau',
		'America/Toronto',
		'America/Vancouver',
		'America/Mexico_City',
		'America/Sao_Paulo',
		'America/Argentina/Buenos_Aires',
		'America/Bogota',
		'America/Lima',
		'America/Santiago',
		'America/Halifax',
		'America/St_Johns'
	],
	'Europe': [
		'Europe/London',
		'Europe/Paris',
		'Europe/Berlin',
		'Europe/Madrid',
		'Europe/Rome',
		'Europe/Amsterdam',
		'Europe/Brussels',
		'Europe/Stockholm',
		'Europe/Oslo',
		'Europe/Copenhagen',
		'Europe/Zurich',
		'Europe/Vienna',
		'Europe/Warsaw',
		'Europe/Prague',
		'Europe/Budapest',
		'Europe/Athens',
		'Europe/Helsinki',
		'Europe/Moscow',
		'Europe/Istanbul',
		'Europe/Kyiv'
	],
	'Africa': [
		'Africa/Cairo',
		'Africa/Casablanca',
		'Africa/Lagos',
		'Africa/Nairobi',
		'Africa/Johannesburg',
		'Africa/Tunis'
	],
	'Australia': [
		'Australia/Sydney',
		'Australia/Melbourne',
		'Australia/Brisbane',
		'Australia/Perth',
		'Australia/Adelaide',
		'Australia/Darwin',
		'Australia/Hobart'
	],
	'Pacific': [
		'Pacific/Auckland',
		'Pacific/Fiji',
		'Pacific/Honolulu',
		'Pacific/Guam'
	]
};

/** Flat list of all common timezones */
const ALL_COMMON = Object.values(COMMON_TIMEZONES).flat();

/**
 * Search common timezones by keyword
 * @param {string} query - Search term (city, region, or offset)
 * @param {number} [limit=25] - Max results
 * @returns {string[]} Matching timezone strings
 */
function searchTimezone(query, limit = 25) {
	if (!query || query.trim().length === 0) {
		return ALL_COMMON.slice(0, limit);
	}
	const lower = query.toLowerCase().replace(/\s+/g, '_');
	const results = ALL_COMMON.filter(tz =>
		tz.toLowerCase().includes(lower)
	);
	return results.slice(0, limit);
}

/**
 * Suggest timezones when a user enters an invalid one
 * Tries to find close matches based on keyword overlap
 * @param {string} invalidInput - The invalid timezone string
 * @param {number} [limit=5] - Max suggestions
 * @returns {string[]} Suggested timezone strings
 */
function suggestTimezones(invalidInput, limit = 5) {
	if (!invalidInput) return [];
	const lower = invalidInput.toLowerCase().replace(/\s+/g, '_');
	const parts = lower.split(/[/_]/).filter(Boolean);

	// Score each common timezone by keyword overlap
	const scored = ALL_COMMON.map(tz => {
		const tzLower = tz.toLowerCase();
		let score = 0;
		for (const part of parts) {
			if (tzLower.includes(part)) {
				score += part.length;
			}
		}
		return { tz, score };
	});

	return scored
		.sort((a, b) => b.score - a.score)
		.filter(s => s.score > 0)
		.slice(0, limit)
		.map(s => s.tz);
}

module.exports = {
	COMMON_TIMEZONES,
	ALL_COMMON,
	searchTimezone,
	suggestTimezones
};
