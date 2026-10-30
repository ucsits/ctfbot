/**
 * Google OAuth 2.0 access token management.
 *
 * The bot uses a single set of shared org credentials provisioned via env vars
 * or the google_credentials DB table. A long-lived refresh token is obtained
 * once via the loopback consent flow (see scripts/google-auth.js, which uses
 * buildAuthUrl and exchangeCode) and then used at runtime to mint short-lived
 * access tokens.
 *
 * @module lib/google/oauth
 */

const { logger } = require('../logger');
const oauthLog = logger.child('Google|OAuth');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

/** @type {{ access_token: string, expiry: number, token_type: string } | null} */
let cachedToken = null;

/**
 * Exchange a refresh token for a short-lived access token.
 *
 * Caches the token in memory and only refreshes when it is within 60 seconds
 * of expiry, so the calendar API calls are not slowed by a token refresh on
 * every request.
 *
 * @param {string} clientId
 * @param {string} clientSecret
 * @param {string} refreshToken
 * @returns {Promise<string>} The access token
 */
async function getAccessToken(clientId, clientSecret, refreshToken) {
	if (cachedToken && cachedToken.expiry > Date.now() + 60_000) {
		oauthLog.debug('Using cached access token');
		return cachedToken.access_token;
	}

	oauthLog.info('Refreshing Google OAuth access token');

	const body = new URLSearchParams({
		client_id: clientId,
		client_secret: clientSecret,
		refresh_token: refreshToken,
		grant_type: 'refresh_token'
	});

	const res = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body
	});

	if (!res.ok) {
		const errBody = await res.text().catch(() => '');
		oauthLog.error(`Token refresh failed (${res.status}): ${errBody}`);
		throw new Error(`Google OAuth token refresh failed (${res.status})`);
	}

	const data = await res.json();
	cachedToken = {
		access_token: data.access_token,
		expiry: Date.now() + (data.expires_in || 3600) * 1000,
		token_type: data.token_type || 'Bearer'
	};

	oauthLog.debug('Access token refreshed successfully');
	return cachedToken.access_token;
}

/**
 * Build the authorization URL that an admin visits in a browser to obtain a
 * one-time code, which exchangeCode then trades for a refresh token.
 *
 * Google blocked the out-of-band (urn:ietf:wg:oauth:2.0:oob) redirect in
 * 2023, so the redirect must be a loopback address (http://127.0.0.1:<port>)
 * served by a local listener. Desktop app OAuth clients accept any loopback
 * port without registering it.
 *
 * @param {string} clientId
 * @param {string} redirectUri - Loopback URI the local listener serves
 * @returns {string} The full Google OAuth consent URL
 */
function buildAuthUrl(clientId, redirectUri) {
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		response_type: 'code',
		scope: 'https://www.googleapis.com/auth/calendar',
		access_type: 'offline',
		prompt: 'consent'
	});
	return `${AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange a one-time authorization code for tokens.
 *
 * @param {string} clientId
 * @param {string} clientSecret
 * @param {string} code - The code Google sent to the redirect URI
 * @param {string} redirectUri - Must match the one used in buildAuthUrl
 * @returns {Promise<{ refresh_token?: string, access_token: string, expires_in: number }>}
 */
async function exchangeCode(clientId, clientSecret, code, redirectUri) {
	const body = new URLSearchParams({
		client_id: clientId,
		client_secret: clientSecret,
		code,
		redirect_uri: redirectUri,
		grant_type: 'authorization_code'
	});

	const res = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body
	});

	if (!res.ok) {
		const errBody = await res.text().catch(() => '');
		throw new Error(`Google OAuth code exchange failed (${res.status}): ${errBody}`);
	}

	return res.json();
}

/**
 * Force the cached token to be discarded on the next getAccessToken call.
 * Used when the calendar API returns a 401 to trigger a fresh refresh.
 */
function clearTokenCache() {
	cachedToken = null;
	oauthLog.debug('Token cache cleared');
}

module.exports = {
	getAccessToken,
	buildAuthUrl,
	exchangeCode,
	clearTokenCache
};
