#!/usr/bin/env node
/**
 * One-time helper that obtains a Google refresh token for Calendar sync.
 *
 * Starts a listener on 127.0.0.1, prints the consent URL, waits for Google to
 * redirect back with a code, exchanges it, and prints GOOGLE_REFRESH_TOKEN.
 *
 * Usage: pnpm google:auth   (reads GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
 * from .env; the OAuth client must be of the "Desktop app" type)
 */

require('dotenv/config');
const http = require('node:http');
const { buildAuthUrl, exchangeCode } = require('../src/lib/google/oauth');

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
	console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first.');
	process.exit(1);
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, redirectUri);
	const code = url.searchParams.get('code');
	const error = url.searchParams.get('error');

	if (!code && !error) {
		res.writeHead(404).end();
		return;
	}

	if (error) {
		res.end(`Authorization failed: ${error}. You can close this tab.`);
		console.error(`Authorization failed: ${error}`);
		server.close();
		process.exitCode = 1;
		return;
	}

	try {
		const tokens = await exchangeCode(clientId, clientSecret, code, redirectUri);
		res.end('Done. You can close this tab and return to the terminal.');
		if (!tokens.refresh_token) {
			console.error(
				'Google returned no refresh token. Revoke the app at https://myaccount.google.com/permissions and retry.'
			);
			process.exitCode = 1;
		} else {
			console.log('\nAdd this to your .env:\n');
			console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
		}
	} catch (err) {
		res.end('Token exchange failed. See the terminal for details.');
		console.error(err.message);
		process.exitCode = 1;
	}
	server.close();
});

let redirectUri;

server.listen(0, '127.0.0.1', () => {
	redirectUri = `http://127.0.0.1:${server.address().port}`;
	console.log('Open this URL in a browser and approve access:\n');
	console.log(buildAuthUrl(clientId, redirectUri));
	console.log('\nWaiting for Google to redirect back...');
});
