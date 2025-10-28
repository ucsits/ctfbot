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

module.exports = { getIdHints };
