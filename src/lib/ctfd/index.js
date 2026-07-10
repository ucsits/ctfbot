/**
 * CTFd API client for fetching user and team data
 * @module ctfd/client
 */

/**
 * CTFd API Client
 */
class CTFdClient {
	/**
	 * Create a CTFd client
	 * @param {string} baseUrl - Base URL of the CTFd instance
	 * @param {string} apiToken - API token for authentication
	 */
	constructor(baseUrl, apiToken) {
		this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
		this.apiToken = apiToken ? apiToken.trim() : null;
		this._lastRequestTime = 0;
		this._minRequestInterval = 200;
		this.log = require('../logger').logger.child('CTFd');
	}

	async _rateLimit() {
		const now = Date.now();
		const elapsed = now - this._lastRequestTime;
		if (elapsed < this._minRequestInterval) {
			await new Promise(resolve => setTimeout(resolve, this._minRequestInterval - elapsed));
		}
		this._lastRequestTime = Date.now();
	}

	/**
	 * Make an API request to CTFd
	 * @private
	 * @param {string} endpoint - API endpoint (e.g., '/api/v1/users')
	 * @param {Object} options - Fetch options
	 * @returns {Promise<any>} Response data
	 */
	async request(endpoint, options = {}) {
		await this._rateLimit();
		const url = `${this.baseUrl}${endpoint}`;
		const method = options.method || 'GET';

		const headers = {
			'Content-Type': 'application/json',
			...options.headers
		};

		if (this.apiToken) {
			headers['Authorization'] = `Token ${this.apiToken}`;
		}

		this.log.debug(`${method} ${url}`);

		try {
			const response = await fetch(url, {
				...options,
				method,
				headers
			});

			this.log.debug(`Response Status: ${response.status} ${response.statusText}`);

			if (!response.ok) {
				const text = await response.text();
				this.log.error(`Error Response Body: ${text}`);
				throw new Error(`CTFd API error: ${response.status} ${response.statusText}`);
			}

			const data = await response.json();

			// CTFd API returns data in { success: true, data: [...] } format
			if (!data.success) {
				this.log.error('API Logic Error', data);
				throw new Error(`CTFd API returned error: ${JSON.stringify(data)}`);
			}

			return data;
		} catch (error) {
			this.log.error(`Request Failed: ${method} ${url}`, error);
			throw error;
		}
	}

	async paginatedRequest(endpoint) {
		const results = [];
		let currentEndpoint = endpoint;

		while (currentEndpoint) {
			const response = await this.request(currentEndpoint);
			results.push(...(Array.isArray(response.data) ? response.data : [response.data]));
			currentEndpoint = response.meta?.next || null;
		}

		return results;
	}

	/**
	 * Get all challenges
	 * @param {Object} params - Query parameters
	 * @returns {Promise<Array>} Array of challenge objects
	 */
	async getChallenges(params = {}) {
		const queryParams = new URLSearchParams(params);
		const endpoint = `/api/v1/challenges${queryParams.toString() ? '?' + queryParams.toString() : ''}`;
		return await this.paginatedRequest(endpoint);
	}

	/**
	 * Get solves for a specific challenge
	 * @param {number} challengeId - Challenge ID
	 * @returns {Promise<Array>} Array of solve objects
	 */
	async getChallengeSolves(challengeId) {
		return await this.paginatedRequest(`/api/v1/challenges/${challengeId}/solves`);
	}

	/**
	 * Get solves for a specific user
	 * @param {number} userId - User ID
	 * @returns {Promise<Array>} Array of solve objects
	 */
	async getUserSolves(userId) {
		return await this.paginatedRequest(`/api/v1/users/${userId}/solves`);
	}

	/**
	 * Get users from CTFd (search)
	 * @param {Object} params - Query parameters
	 * @param {string} [params.q] - Search query for username
	 * @returns {Promise<Array>} Array of user objects
	 */
	async getUsers(params = {}) {
		const queryParams = new URLSearchParams();

		if (params.q) {
			queryParams.append('q', params.q);
			queryParams.append('field', 'name'); // Search by name field
		}

		const endpoint = `/api/v1/users${queryParams.toString() ? '?' + queryParams.toString() : ''}`;
		return await this.paginatedRequest(endpoint);
	}

	/**
	 * Get a specific user by ID
	 * @param {number} userId - User ID
	 * @returns {Promise<Object>} User object
	 */
	async getUser(userId) {
		const response = await this.request(`/api/v1/users/${userId}`);
		return response.data;
	}

	/**
	 * Get team information
	 * @param {number} teamId - Team ID
	 * @returns {Promise<Object>} Team object
	 */
	async getTeam(teamId) {
		const response = await this.request(`/api/v1/teams/${teamId}`);
		return response.data;
	}

	/**
	 * Get scoreboard
	 * @returns {Promise<Array>} Array of scoreboard entries
	 */
	async getScoreboard() {
		return await this.paginatedRequest('/api/v1/scoreboard');
	}

	/**
	 * Fetch user data from CTFd (legacy method for compatibility)
	 *
	 * @param {string} username - Username to fetch
	 * @returns {Promise<Object>} User data
	 * @returns {string} return.userId - CTFd user ID
	 * @returns {string} return.username - Username
	 * @returns {string|null} return.teamName - Team name if user is in a team
	 *
	 * @example
	 * const client = new CTFdClient('https://ctf.example.com', 'token');
	 * const userData = await client.fetchUserData('john_doe');
	 */
	async fetchUserData(username) {
		const users = await this.getUsers({ q: username });

		if (!users || users.length === 0) {
			throw new Error('User not found');
		}

		const user = users.find(u => u.name.toLowerCase() === username.toLowerCase()) || users[0];

		let teamName = null;
		if (user.team_id) {
			try {
				const team = await this.getTeam(user.team_id);
				teamName = team.name;
			} catch (error) {
				// Team fetch failed, but don't fail the whole operation
				teamName = null;
			}
		}

		return {
			userId: user.id.toString(),
			username: user.name,
			teamName: teamName
		};
	}

	/**
	 * Fetch team name from CTFd
	 *
	 * @param {number} teamId - Team ID
	 * @returns {Promise<string|null>} Team name
	 * @private
	 */
	async fetchTeamName(teamId) {
		try {
			const team = await this.getTeam(teamId);
			return team.name;
		} catch (error) {
			return null;
		}
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
