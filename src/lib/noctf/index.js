/**
 * noCTF API client.
 *
 * noCTF (https://github.com/noctf-project/noCTF) is a Fastify backend with a
 * SvelteKit frontend. Two properties of it shape this client:
 *
 *   1. The API usually lives on a different origin than the web UI (for example
 *      scoreboard.example.com serves the UI while api-example.com serves the
 *      API), so the API base URL is always supplied explicitly.
 *   2. Almost every challenge and scoreboard route is gated on the competition
 *      being active and started. Anonymous requests work only during the event;
 *      a bearer token with admin policies bypasses the gate and additionally
 *      reveals hidden challenges and hidden solves.
 *
 * Responses are wrapped in `{ data: ... }` and errors are `{ error, message }`.
 *
 * @module noctf/client
 */

const { ExternalAPIError } = require('../errors');

/** Retry budget for transient 5xx responses (2 retries: 250ms, then 500ms). */
const MAX_SERVER_ERROR_RETRIES = 2;
const RETRY_BACKOFF_MS = 250;

/** Default scoreboard page size when asking the API for data. */
const DEFAULT_PAGE_SIZE = 100;

/** The API caps the team id list per query at 50. */
const TEAM_ID_CHUNK_SIZE = 50;

/**
 * Messages the API returns when the competition gate rejects a request. They are
 * surfaced verbatim so an operator can tell "not started yet" apart from a real
 * failure, and flagged so callers can present them as a configuration problem
 * rather than an outage.
 */
const GATING_MESSAGES = [
	'The CTF is not currently active',
	'The CTF has not started yet'
];

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * noCTF API client.
 */
class NoCTFClient {
	/**
	 * @param {string} baseUrl - API origin, e.g. https://api-k17ctf.secso.cc
	 * @param {string|null} [token] - Bearer session token
	 * @param {Object} [options]
	 * @param {number} [options.divisionId] - Pin the division instead of resolving it
	 * @param {number} [options.pageSize] - Scoreboard page size (default 100)
	 */
	constructor(baseUrl, token = null, options = {}) {
		this.baseUrl = String(baseUrl || '').replace(/\/$/, '');
		this.token = token ? String(token).trim() : null;
		this.platform = 'noctf';
		this.apiBaseUrl = this.baseUrl;
		this.divisionId = options.divisionId;
		this.pageSize = options.pageSize || DEFAULT_PAGE_SIZE;
		this._lastRequestTime = 0;
		this._minRequestInterval = 200;
		this._resolvedDivisionId = null;
		this.log = require('../logger').logger.child('noCTF');
	}

	async _rateLimit() {
		const now = Date.now();
		const elapsed = now - this._lastRequestTime;
		if (elapsed < this._minRequestInterval) {
			await sleep(this._minRequestInterval - elapsed);
		}
		this._lastRequestTime = Date.now();
	}

	/**
	 * Turn a failed response into a message that preserves the API's own text.
	 *
	 * @private
	 * @param {Response} response
	 * @param {string} text - Raw response body
	 * @returns {{message: string, isGating: boolean, apiMessage: string|null, status: number}}
	 */
	_describeError(response, text) {
		let parsed = null;
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = null;
		}

		const apiMessage = parsed && typeof parsed.message === 'string' ? parsed.message : null;
		const apiError = parsed && typeof parsed.error === 'string' ? parsed.error : null;
		const statusLabel = `${response.status} ${response.statusText || ''}`.trim();
		const headline = apiError || statusLabel;
		const detail = apiMessage || (text || '').trim();

		return {
			message: `noCTF API error: ${headline}${detail ? ` - ${detail}` : ''}`,
			isGating: response.status === 403 && GATING_MESSAGES.includes(apiMessage),
			apiMessage,
			status: response.status
		};
	}

	/**
	 * Make an API request, unwrapping the `{ data }` envelope.
	 *
	 * Transient 5xx responses are retried; 4xx responses are not, because they
	 * are deterministic (bad token, gate closed, validation).
	 *
	 * @param {string} endpoint - Path beginning with '/'
	 * @param {Object} [options] - Fetch options; a non-string `body` is JSON encoded
	 * @returns {Promise<any>} Unwrapped `data`, or the whole body when there is none
	 */
	async request(endpoint, options = {}) {
		const method = options.method || 'GET';
		const url = `${this.baseUrl}${endpoint}`;
		const headers = {
			Accept: 'application/json',
			'Content-Type': 'application/json',
			...options.headers
		};

		if (this.token) {
			headers.Authorization = `Bearer ${this.token}`;
		}

		const body = options.body === undefined || options.body === null
			? undefined
			: (typeof options.body === 'string' ? options.body : JSON.stringify(options.body));

		let attempt = 0;
		for (;;) {
			await this._rateLimit();
			this.log.debug(`${method} ${url}${attempt > 0 ? ` (retry ${attempt})` : ''}`);

			let response;
			try {
				response = await fetch(url, { method, headers, body });
			} catch (error) {
				this.log.error(`Request failed: ${method} ${url}`, error);
				throw new ExternalAPIError(`noCTF request failed: ${error.message}`);
			}

			if (response.ok) {
				let parsed;
				try {
					parsed = await response.json();
				} catch (error) {
					throw new ExternalAPIError(`noCTF returned a non-JSON response for ${method} ${url}`);
				}
				// /healthz answers with a bare object instead of the usual envelope.
				return parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed;
			}

			const text = await response.text();
			const described = this._describeError(response, text);

			if (response.status >= 500 && attempt < MAX_SERVER_ERROR_RETRIES) {
				attempt += 1;
				const backoff = RETRY_BACKOFF_MS * attempt;
				this.log.warn(
					`noCTF ${response.status} from ${method} ${url}, retrying in ${backoff}ms`
				);
				await sleep(backoff);
				continue;
			}

			this.log.error(`Error Response Body: ${text}`);
			const error = new ExternalAPIError(described.message);
			error.status = described.status;
			error.isGating = described.isGating;
			error.apiMessage = described.apiMessage;
			throw error;
		}
	}

	/**
	 * Resolve which division to read the scoreboard from.
	 *
	 * Order: an explicit option, then the deployment's configured default, then
	 * the first visible division. A resolution is cached; the final fallback of 1
	 * is deliberately not cached so a transient outage at startup cannot pin the
	 * process to the wrong division for its whole lifetime.
	 *
	 * @returns {Promise<number>} A division id, never undefined
	 */
	async resolveDivisionId() {
		if (this._resolvedDivisionId !== null) {
			return this._resolvedDivisionId;
		}

		if (this.divisionId !== undefined && this.divisionId !== null) {
			this._resolvedDivisionId = Number(this.divisionId);
			return this._resolvedDivisionId;
		}

		try {
			const config = await this.request('/site/config');
			if (config && config.default_division_id) {
				this._resolvedDivisionId = Number(config.default_division_id);
				return this._resolvedDivisionId;
			}
		} catch (error) {
			this.log.warn(`Could not read /site/config: ${error.message}`);
		}

		try {
			const divisions = await this.request('/divisions');
			const visible = (Array.isArray(divisions) ? divisions : []).find(d => d.is_visible);
			if (visible && visible.id !== undefined) {
				this._resolvedDivisionId = Number(visible.id);
				return this._resolvedDivisionId;
			}
		} catch (error) {
			this.log.warn(`Could not read /divisions: ${error.message}`);
		}

		this.log.warn('Falling back to division 1; set a division with /setctfplatform if this is wrong');
		return 1;
	}

	/**
	 * noCTF has no dedicated category field: the UI splits tags.categories on
	 * commas and takes the first entry.
	 *
	 * @private
	 * @param {Object} [tags]
	 * @returns {string}
	 */
	_categoryFromTags(tags) {
		const raw = tags && tags.categories !== undefined && tags.categories !== null
			? String(tags.categories)
			: '';
		const first = raw.split(',').map(part => part.trim()).find(Boolean);
		return first || 'uncategorized';
	}

	/**
	 * List challenges visible to the configured credential.
	 *
	 * @returns {Promise<Array>} Normalized challenges
	 */
	async getChallenges() {
		const data = await this.request('/challenges');
		const challenges = (data && data.challenges) || [];
		return challenges.map(chal => ({
			id: chal.id,
			name: chal.title || chal.slug,
			slug: chal.slug,
			category: this._categoryFromTags(chal.tags),
			points: chal.value ?? 0
		}));
	}

	/**
	 * Bulk solve listing for a division.
	 *
	 * The scoreboard is the only endpoint that attributes a solve to a user, so
	 * it is the accurate source. Solves the platform marks hidden (recorded
	 * outside the competition window) are skipped, as are hidden teams.
	 *
	 * @returns {Promise<Array>} Flattened normalized solves
	 */
	async getAllSolves() {
		const divisionId = await this.resolveDivisionId();
		const solves = [];
		let page = 1;

		for (;;) {
			const data = await this.request(
				`/scoreboard/divisions/${divisionId}?page=${page}&page_size=${this.pageSize}`
			);
			const entries = (data && data.entries) || [];

			for (const entry of entries) {
				if (entry.hidden) {
					continue;
				}
				for (const solve of entry.solves || []) {
					if (solve.hidden) {
						continue;
					}
					solves.push({
						challengeId: solve.challenge_id,
						teamId: entry.team_id,
						userId: solve.user_id ?? null,
						solvedAt: solve.created_at || null,
						value: solve.value ?? null
					});
				}
			}

			const total = data && data.total !== undefined ? data.total : entries.length;
			const effectivePageSize = (data && data.page_size) || this.pageSize;
			if (entries.length === 0 || page * effectivePageSize >= total) {
				break;
			}
			page += 1;
		}

		return solves;
	}

	/**
	 * Solves for one challenge.
	 *
	 * This endpoint deliberately omits user_id, so callers get team-level rows
	 * only and must resolve the team themselves.
	 *
	 * @param {number|string} challengeId
	 * @returns {Promise<Array>} Normalized solves
	 */
	async getChallengeSolves(challengeId) {
		const divisionId = await this.resolveDivisionId();
		const data = await this.request(`/challenges/${challengeId}/solves?division_id=${divisionId}`);
		return (Array.isArray(data) ? data : []).map(solve => ({
			teamId: solve.team_id,
			userId: null,
			username: null,
			solvedAt: solve.created_at || null,
			value: solve.value ?? null
		}));
	}

	/**
	 * Resolve team names for a list of team ids, in batches the API accepts.
	 *
	 * @private
	 * @param {Array<number>} teamIds
	 * @returns {Promise<Map<number, string>>}
	 */
	async _resolveTeamNames(teamIds) {
		const unique = [...new Set(teamIds.filter(id => id !== null && id !== undefined))];
		const names = new Map();

		for (let i = 0; i < unique.length; i += TEAM_ID_CHUNK_SIZE) {
			const chunk = unique.slice(i, i + TEAM_ID_CHUNK_SIZE);
			try {
				const data = await this.request('/teams/query', {
					method: 'POST',
					body: { ids: chunk, page_size: chunk.length }
				});
				for (const team of (data && data.entries) || []) {
					names.set(team.id, team.name);
				}
			} catch (error) {
				this.log.warn(`Could not resolve ${chunk.length} team name(s): ${error.message}`);
			}
		}

		return names;
	}

	/**
	 * Resolve user names for a list of user ids.
	 *
	 * The bulk scoreboard listing identifies a solver by numeric user id only, so
	 * this is the only way to label a solve belonging to someone who has not
	 * linked a Discord account. It shares TEAM_ID_CHUNK_SIZE because the API
	 * applies the same per-query id cap to both resources.
	 *
	 * A chunk that fails is logged and skipped rather than throwing: a missing
	 * name degrades the announcement label, which is never worth failing a sync
	 * over.
	 *
	 * @param {Array<number|string>} userIds
	 * @returns {Promise<Map<string, string>>} Map of String(user id) to name
	 */
	async resolveUserNames(userIds) {
		const unique = [...new Set((userIds || [])
			.filter(id => id !== null && id !== undefined && id !== '')
			.map(id => Number(id))
			.filter(id => Number.isFinite(id)))];
		const names = new Map();

		for (let i = 0; i < unique.length; i += TEAM_ID_CHUNK_SIZE) {
			const chunk = unique.slice(i, i + TEAM_ID_CHUNK_SIZE);
			try {
				const data = await this.request('/users/query', {
					method: 'POST',
					body: { ids: chunk, page_size: chunk.length }
				});
				for (const user of (data && data.entries) || []) {
					if (user && user.name !== undefined && user.name !== null) {
						names.set(String(user.id), String(user.name));
					}
				}
			} catch (error) {
				this.log.warn(`Could not resolve ${chunk.length} user name(s): ${error.message}`);
			}
		}

		return names;
	}

	/**
	 * Scoreboard for the resolved division.
	 *
	 * @returns {Promise<Array>} Normalized entries with name, pos and score
	 */
	async getScoreboard() {
		const divisionId = await this.resolveDivisionId();
		const entries = [];
		let page = 1;

		for (;;) {
			const data = await this.request(
				`/scoreboard/divisions/${divisionId}?page=${page}&page_size=${this.pageSize}`
			);
			const batch = (data && data.entries) || [];
			entries.push(...batch);

			const total = data && data.total !== undefined ? data.total : entries.length;
			const effectivePageSize = (data && data.page_size) || this.pageSize;
			if (batch.length === 0 || page * effectivePageSize >= total) {
				break;
			}
			page += 1;
		}

		const visible = entries.filter(entry => !entry.hidden);
		const names = await this._resolveTeamNames(visible.map(entry => entry.team_id));

		return visible.map(entry => ({
			name: names.get(entry.team_id) || `team-${entry.team_id}`,
			pos: entry.rank,
			score: entry.score
		}));
	}

	/**
	 * Look up a user by name.
	 *
	 * @param {string} username
	 * @returns {Promise<Object>} { userId, username, teamName, teamId }
	 * @throws {Error} When no user matches
	 */
	async findUser(username) {
		const data = await this.request('/users/query', {
			method: 'POST',
			body: { name: username, page_size: 50 }
		});
		const entries = (data && data.entries) || [];
		if (entries.length === 0) {
			throw new Error(`User "${username}" not found on the noCTF platform`);
		}

		const wanted = String(username).toLowerCase();
		const match = entries.find(entry => String(entry.name).toLowerCase() === wanted) || entries[0];

		let teamName = null;
		if (match.team_id !== null && match.team_id !== undefined) {
			teamName = await this.resolveTeamName(match.team_id);
		}

		return {
			userId: match.id,
			username: match.name,
			teamName,
			teamId: match.team_id ?? null
		};
	}

	/**
	 * Resolve a team id to its name.
	 *
	 * @param {number|string} teamId
	 * @returns {Promise<string|null>} Team name, or null when it cannot be resolved
	 */
	async resolveTeamName(teamId) {
		if (teamId === null || teamId === undefined) {
			return null;
		}

		const numericId = Number(teamId);
		if (!Number.isFinite(numericId)) {
			return null;
		}

		try {
			const data = await this.request('/teams/query', {
				method: 'POST',
				body: { ids: [numericId], page_size: 1 }
			});
			const team = ((data && data.entries) || [])[0];
			return team ? team.name : null;
		} catch (error) {
			this.log.warn(`Could not resolve team ${teamId}: ${error.message}`);
			return null;
		}
	}

	/**
	 * Probe the instance without throwing, so it is safe to call from a command.
	 *
	 * @returns {Promise<{ok: boolean, platform: string, apiBaseUrl: string, details: Object}>}
	 */
	async testConnection() {
		const details = {
			active: null,
			startTime: null,
			endTime: null,
			divisionId: null
		};

		let ok = false;
		try {
			await this.request('/healthz');
			ok = true;
		} catch (error) {
			this.log.warn(`noCTF health probe failed: ${error.message}`);
		}

		try {
			const config = await this.request('/site/config');
			if (config) {
				details.active = config.active ?? null;
				details.startTime = config.start_time_s ?? null;
				details.endTime = config.end_time_s ?? null;
			}
		} catch (error) {
			this.log.warn(`noCTF site config probe failed: ${error.message}`);
		}

		try {
			details.divisionId = await this.resolveDivisionId();
		} catch (error) {
			this.log.warn(`noCTF division probe failed: ${error.message}`);
		}

		return {
			ok,
			platform: 'noctf',
			apiBaseUrl: this.baseUrl,
			details
		};
	}
}

/**
 * Create a noCTF client.
 *
 * @param {string} baseUrl - API origin
 * @param {string|null} [token] - Bearer session token
 * @param {Object} [options] - Client options
 * @returns {NoCTFClient}
 */
function createNoCTFClient(baseUrl, token = null, options = {}) {
	return new NoCTFClient(baseUrl, token, options);
}

module.exports = {
	NoCTFClient,
	createNoCTFClient
};
