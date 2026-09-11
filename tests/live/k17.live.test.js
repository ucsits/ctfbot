import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

// -- Strategy ---------------------------------------------------------------
// This is the only suite that talks to a real deployment, so it is skipped
// unless K17_LIVE=1 is set. It is deliberately read-only: it never registers a
// user, marks a solve or writes to the database, because it runs against the
// live k17 scoreboard.
//
// Environment:
//   K17_LIVE=1                opt in
//   K17_API_BASE_URL          defaults to https://api-k17ctf.secso.cc
//   K17_API_TOKEN             optional bearer session token. Without it the
//                             probe runs anonymously, which only works while
//                             the competition is active.
//   K17_DIVISION_ID           optional scoreboard division
//   K17_API_USERNAME          optional username to look up with findUser
//
// The client's rate limiter is left in place, so the suite takes a few seconds
// and never floods the deployment.

const require = createRequire(import.meta.url);
const { createNoCTFClient } = require('../../src/lib/noctf/index.js');

const API_BASE = process.env.K17_API_BASE_URL || 'https://api-k17ctf.secso.cc';
const TOKEN = process.env.K17_API_TOKEN || null;
const DIVISION_ID = process.env.K17_DIVISION_ID ? Number(process.env.K17_DIVISION_ID) : undefined;

const LIVE = process.env.K17_LIVE === '1';

let client;

beforeAll(() => {
	if (LIVE) {
		client = createNoCTFClient(API_BASE, TOKEN, { divisionId: DIVISION_ID });
	}
});

/**
 * Probe with a couple of retries. The first request of a cold process can fail
 * on DNS or TLS setup alone, and a live suite that fails on a warm-up blip is
 * worse than useless.
 */
async function probeConnection(attempts = 3) {
	let connection = null;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		connection = await client.testConnection();
		if (connection.ok) {
			return connection;
		}
		await new Promise(resolve => setTimeout(resolve, 500 * attempt));
	}
	return connection;
}

describe.skipIf(!LIVE)('live noCTF deployment', () => {
	it('answers a connection probe', async () => {
		const connection = await probeConnection();

		expect(connection.ok).toBe(true);
		expect(connection.platform).toBe('noctf');
		expect(connection.apiBaseUrl).toBe(API_BASE);
		expect(connection.details.divisionId).toBeGreaterThan(0);
	}, 60_000);

	it('lists challenges in the normalized shape', async () => {
		const challenges = await client.getChallenges();

		expect(Array.isArray(challenges)).toBe(true);
		expect(challenges.length).toBeGreaterThan(0);

		for (const challenge of challenges) {
			expect(challenge.id).toBeDefined();
			expect(typeof challenge.name).toBe('string');
			expect(challenge.name.length).toBeGreaterThan(0);
			expect(typeof challenge.category).toBe('string');
			expect(challenge.category.length).toBeGreaterThan(0);
			expect(typeof challenge.points).toBe('number');
		}
	}, 60_000);

	it('reports a division for the scoreboard', async () => {
		const divisionId = await client.resolveDivisionId();

		expect(Number.isFinite(divisionId)).toBe(true);
		expect(divisionId).toBeGreaterThan(0);
	}, 60_000);

	it('returns a ranked scoreboard with resolved team names', async () => {
		const scoreboard = await client.getScoreboard();

		expect(Array.isArray(scoreboard)).toBe(true);
		expect(scoreboard.length).toBeGreaterThan(0);

		for (const entry of scoreboard) {
			expect(typeof entry.name).toBe('string');
			expect(entry.name.length).toBeGreaterThan(0);
			expect(typeof entry.pos).toBe('number');
			expect(typeof entry.score).toBe('number');
		}

		const ranks = scoreboard.map(entry => entry.pos);
		expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
	}, 120_000);

	it('attributes scoreboard solves to users', async () => {
		const solves = await client.getAllSolves();

		expect(Array.isArray(solves)).toBe(true);
		expect(solves.length).toBeGreaterThan(0);
		expect(solves.some(solve => solve.userId !== null && solve.userId !== undefined)).toBe(true);
		for (const solve of solves) {
			expect(solve.challengeId).toBeDefined();
			expect(solve.teamId).toBeDefined();
		}
	}, 120_000);

	it('finds a registered user when one is named', async () => {
		const username = process.env.K17_API_USERNAME;
		if (!username) {
			return;
		}

		const user = await client.findUser(username);

		expect(String(user.username).toLowerCase()).toBe(username.toLowerCase());
		expect(user.userId).toBeDefined();
	}, 60_000);
});
