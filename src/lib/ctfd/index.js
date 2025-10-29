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
		this.apiToken = apiToken;
	}

	/**
	 * Make an API request to CTFd
	 * @private
	 * @param {string} endpoint - API endpoint (e.g., '/api/v1/users')
	 * @param {Object} options - Fetch options
	 * @returns {Promise<any>} Response data
	 */
	async request(endpoint, options = {}) {
		const url = `${this.baseUrl}${endpoint}`;
		const method = options.method || 'GET';
		
		// Only set Content-Type for requests with a body
		const headers = {
			'Authorization': `Token ${this.apiToken}`,
			...options.headers
		};
		
		// Add Content-Type only for POST, PUT, PATCH requests
		if (['POST', 'PUT', 'PATCH'].includes(method.toUpperCase()) && !headers['Content-Type']) {
			headers['Content-Type'] = 'application/json';
		}

		const response = await fetch(url, {
			...options,
			method,
			headers
		});

		if (!response.ok) {
			throw new Error(`CTFd API error: ${response.status} ${response.statusText}`);
		}

		const data = await response.json();
		
		// CTFd API returns data in { success: true, data: [...] } format
		if (!data.success) {
			throw new Error(`CTFd API returned error: ${JSON.stringify(data)}`);
		}

		return data.data;
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
		return await this.request(endpoint);
	}

	/**
	 * Get a specific user by ID
	 * @param {number} userId - User ID
	 * @returns {Promise<Object>} User object
	 */
	async getUser(userId) {
		return await this.request(`/api/v1/users/${userId}`);
	}

	/**
	 * Get team information
	 * @param {number} teamId - Team ID
	 * @returns {Promise<Object>} Team object
	 */
	async getTeam(teamId) {
		return await this.request(`/api/v1/teams/${teamId}`);
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
