/**
 * CTFd API client for fetching user and team data
 * @module ctfd/client
 */

const { ExternalAPIError } = require('../errors');

/**
 * CTFd API Client
 */
class CTFdClient {
	/**
	 * Create a CTFd client
	 * @param {string} baseUrl - Base URL of the CTFd instance
	 * @param {string} [apiToken] - Optional API token for authentication
	 */
	constructor(baseUrl, apiToken = null) {
		this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
		this.apiToken = apiToken;
	}

	/**
	 * Fetch user data from CTFd
	 * 
	 * @param {string} username - Username to fetch
	 * @returns {Promise<Object>} User data
	 * @returns {string} return.userId - CTFd user ID
	 * @returns {string} return.username - Username
	 * @returns {string|null} return.teamName - Team name if user is in a team
	 * @throws {ExternalAPIError} If fetch fails
	 * 
	 * @example
	 * const client = new CTFdClient('https://ctf.example.com', 'token');
	 * const userData = await client.fetchUserData('john_doe');
	 */
	async fetchUserData(username) {
		// TODO: Implement actual CTFd API integration
		// This requires:
		// 1. CTFd API endpoint for user search
		// 2. Authentication with API token
		// 3. Proper error handling
		
		throw new ExternalAPIError(
			'⚠️ CTFd integration is not yet implemented. Registration saved without CTFd data.'
		);
		
		/* Placeholder implementation:
		try {
			const response = await fetch(`${this.baseUrl}/api/v1/users?name=${username}`, {
				headers: {
					'Authorization': `Token ${this.apiToken}`,
					'Content-Type': 'application/json'
				}
			});

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}

			const data = await response.json();
			
			if (!data.success || !data.data || data.data.length === 0) {
				throw new Error('User not found');
			}

			const user = data.data[0];
			
			return {
				userId: user.id.toString(),
				username: user.name,
				teamName: user.team_id ? await this.fetchTeamName(user.team_id) : null
			};
		} catch (error) {
			throw new ExternalAPIError(
				`⚠️ Failed to fetch CTFd user data: ${error.message}`
			);
		}
		*/
	}

	/**
	 * Fetch team name from CTFd
	 * 
	 * @param {number} teamId - Team ID
	 * @returns {Promise<string|null>} Team name
	 * @private
	 */
	async fetchTeamName(teamId) {
		// TODO: Implement team name fetching
		return null;
	}

	/**
	 * Test CTFd connection
	 * 
	 * @returns {Promise<boolean>} True if connection is successful
	 */
	async testConnection() {
		try {
			const response = await fetch(`${this.baseUrl}/api/v1/`, {
				headers: this.apiToken ? {
					'Authorization': `Token ${this.apiToken}`
				} : {}
			});
			return response.ok;
		} catch (error) {
			return false;
		}
	}
}

/**
 * Create a CTFd client instance
 * 
 * @param {string} baseUrl - Base URL of the CTFd instance
 * @param {string} [apiToken] - Optional API token
 * @returns {CTFdClient} CTFd client instance
 */
function createCTFdClient(baseUrl, apiToken = null) {
	return new CTFdClient(baseUrl, apiToken);
}

module.exports = {
	CTFdClient,
	createCTFdClient
};
