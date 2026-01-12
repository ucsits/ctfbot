/**
 * Command ID utilities for Discord slash commands
 * @module utils/commandIds
 */

const fs = require('fs');
const path = require('path');

/**
 * Get idHints for a command from the stored command IDs
 * This helps Discord update commands faster during development
 *
 * @param {string} commandName - The name of the command
 * @returns {string[]} Array of command IDs
 *
 * @example
 * const idHints = getIdHints('ping');
 * // Returns: ['1234567890', '0987654321']
 */
function getIdHints(commandName) {
	const idHintsFile = path.join(__dirname, '..', '..', 'commandIds.json');

	try {
		if (fs.existsSync(idHintsFile)) {
			const commandIds = JSON.parse(fs.readFileSync(idHintsFile, 'utf8'));
			return commandIds[commandName] || [];
		}
	} catch (error) {
		// Silently fail and return empty array
		// This is expected on first run before commands are registered
	}

	return [];
}

/**
 * Save command IDs to file
 *
 * @param {Object} commandIds - Object mapping command names to ID arrays
 * @returns {boolean} Success status
 */
function saveCommandIds(commandIds) {
	const idHintsFile = path.join(__dirname, '..', '..', 'commandIds.json');

	try {
		fs.writeFileSync(idHintsFile, JSON.stringify(commandIds, null, 2));
		return true;
	} catch (error) {
		console.error('Failed to save command IDs:', error);
		return false;
	}
}

module.exports = {
	getIdHints,
	saveCommandIds
};
