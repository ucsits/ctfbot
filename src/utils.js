const fs = require('fs');
const path = require('path');

/**
 * Get idHints for a command from the stored command IDs
 * @param {string} commandName - The name of the command
 * @returns {string[]} Array of command IDs
 */
function getIdHints(commandName) {
	const idHintsFile = path.join(__dirname, 'commandIds.json');
	
	try {
		if (fs.existsSync(idHintsFile)) {
			const commandIds = JSON.parse(fs.readFileSync(idHintsFile, 'utf8'));
			return commandIds[commandName] || [];
		}
	} catch (error) {
		// Silently fail and return empty array
	}
	
	return [];
}

/**
 * Parse a date string in DD-MM-YYYY HH:MM format and convert it to UTC
 * based on the specified timezone
 * @param {string} dateStr - Date string in DD-MM-YYYY HH:MM format
 * @param {string} timezone - IANA timezone (e.g., Asia/Jakarta, Europe/London)
 * @returns {Date} Date object in UTC
 * @throws {Error} If date format is invalid or timezone is invalid
 */
function parseLocalDateToUTC(dateStr, timezone) {
	// Parse date (DD-MM-YYYY HH:MM format)
	const dateMatch = dateStr.match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})$/);
	if (!dateMatch) {
		throw new Error('Invalid date format. Please use: DD-MM-YYYY HH:MM (e.g., 31-12-2025 20:00)');
	}

	const [, day, month, year, hour, minute] = dateMatch;
	
	try {
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
		
	} catch (error) {
		throw new Error('Invalid timezone. Please use a valid IANA timezone (e.g., Asia/Jakarta, Europe/London, America/New_York)');
	}
}

module.exports = { getIdHints, parseLocalDateToUTC };
