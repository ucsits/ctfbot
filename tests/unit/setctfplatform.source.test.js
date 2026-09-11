import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';

// ── Strategy ───────────────────────────────────────────────────────────
// These are source-level assertions about contracts that are easy to break
// silently and that the functional suite cannot see:
//
//   * both guards reply on their own, so they must run before deferReply.
//     Deferring first would make the guard's reply a second response and the
//     permission denial would never reach the user.
//   * the token is a credential. It must never be interpolated into anything
//     sent back to Discord; the reply may only say whether one is set.
//   * the platform choices must come from the registry, otherwise adding a
//     platform in one place would leave the command's option list stale.
//
// The command's runtime behaviour is covered separately by
// tests/unit/setctfplatform.test.js.

const require = createRequire(import.meta.url);
const root = process.cwd();
const source = readFileSync(join(root, 'src/commands/setctfplatform.js'), 'utf8');

/** Line numbers (1-based) of every line matching a pattern. */
function lineNumbers(pattern) {
	return source
		.split('\n')
		.map((line, index) => (pattern.test(line) ? index + 1 : null))
		.filter(line => line !== null);
}

/** Every line that sends something back to Discord. */
function replyLines() {
	return source
		.split('\n')
		.filter(line => /editReply|\.reply\(|followUp|channel\.send/.test(line));
}

describe('/setctfplatform command declaration', () => {
	it('is named setctfplatform', () => {
		expect(source).toMatch(/name:\s*'setctfplatform'/);
		expect(source).toMatch(/\.setName\(this\.name\)/);
	});

	it('declares the options the command reads', () => {
		for (const option of ['platform', 'api_base_url', 'api_token', 'division_id', 'show']) {
			expect(source, `missing option ${option}`).toContain(`.setName('${option}')`);
			expect(source, `${option} is never read`).toContain(`'${option}'`);
		}
	});

	it('builds its platform choices from the registry instead of hardcoding them', () => {
		expect(source).toMatch(/require\('\.\.\/lib\/platform'\)/);
		expect(source).toContain('PLATFORM_CHOICES');
		expect(source).toMatch(/\.addChoices\(\.\.\.PLATFORM_CHOICES\)/);

		// The registry really does export it, so the spread is not a no-op.
		const { PLATFORM_CHOICES } = require('../../src/lib/platform/index.js');
		expect(Array.isArray(PLATFORM_CHOICES)).toBe(true);
		expect(PLATFORM_CHOICES.length).toBeGreaterThan(0);
		expect(PLATFORM_CHOICES.map(choice => choice.value)).toContain('noctf');
	});
});

describe('/setctfplatform permission guard', () => {
	it('requires Manage Channels through checkPermissionReply', () => {
		expect(source).toMatch(
			/checkPermissionReply\(\s*interaction,\s*PermissionFlagsBits\.ManageChannels,\s*'Manage Channels'\s*\)/
		);
	});

	it('imports PermissionFlagsBits from discord.js', () => {
		const importLine = source
			.split('\n')
			.find(line => /require\('discord\.js'\)/.test(line));

		expect(importLine).toBeTruthy();
		expect(importLine).toContain('PermissionFlagsBits');
	});

	it('requires the command to run in a CTF channel through ensureCTFChannelReply', () => {
		expect(source).toMatch(/ensureCTFChannelReply\(interaction\)/);
		expect(source).toMatch(/require\('\.\.\/lib\/middleware\/ensureCTFChannel'\)/);
	});

	it('returns immediately when either guard cancels, before any other work', () => {
		const cancelledLines = lineNumbers(/if\s*\(cancelled\)/);
		const notInCtfLines = lineNumbers(/if\s*\(notInCtfChannel\)/);

		expect(cancelledLines).toHaveLength(1);
		expect(notInCtfLines).toHaveLength(1);
	});

	it('runs both guards before deferReply', () => {
		const permissionLine = lineNumbers(/await checkPermissionReply\(/)[0];
		const channelLine = lineNumbers(/await ensureCTFChannelReply\(/)[0];
		const deferLine = lineNumbers(/await interaction\.deferReply\(/)[0];

		expect(permissionLine).toBeDefined();
		expect(channelLine).toBeDefined();
		expect(deferLine).toBeDefined();

		// Both guards reply directly, so deferring first would break them.
		expect(permissionLine).toBeLessThan(deferLine);
		expect(channelLine).toBeLessThan(deferLine);
	});
});

describe('/setctfplatform credential handling', () => {
	it('never interpolates a token into a reply', () => {
		// Any `${...token...}` anywhere in the file is a leak risk.
		expect(source).not.toMatch(/\$\{[^}]*[Tt]oken[^}]*\}/);
		expect(source).not.toMatch(/\$\{[^}]*api_token[^}]*\}/);
	});

	it('only ever reports whether a token is set', () => {
		// The token field is the one that reads a token expression straight into
		// a value. The no-token warning is a separate line and carries no value.
		const tokenLines = source
			.split('\n')
			.filter(line => /value:\s*\S*[Tt]oken\s*\?/.test(line));

		expect(tokenLines.length).toBeGreaterThan(0);
		for (const line of tokenLines) {
			expect(line, `token value leaked on: ${line.trim()}`).toMatch(/'Set'\s*:\s*'Not set'/);
		}
	});

	it('sends no reply line that contains a raw token expression', () => {
		for (const line of replyLines()) {
			expect(line, `token in a reply: ${line.trim()}`).not.toMatch(/\$\{[^}]*apiToken[^}]*\}/);
			expect(line, `token in a reply: ${line.trim()}`).not.toMatch(/\$\{[^}]*api_token[^}]*\}/);
		}
	});

	it('does not log the token either', () => {
		const logLines = source
			.split('\n')
			.filter(line => /container\.logger\./.test(line));

		for (const line of logLines) {
			expect(line, `token in a log: ${line.trim()}`).not.toMatch(/[Tt]oken/);
		}
	});

	it('carries the token through to the repository under the camelCase field name', () => {
		expect(source).toMatch(/ctfOperations\.setCTFPlatform\(/);
		expect(source).toMatch(/apiToken/);
	});
});

describe('/setctfplatform validation and persistence', () => {
	it('validates a supplied API base URL before writing anything', () => {
		const validateLine = lineNumbers(/validateURL\(apiBaseUrlInput\)/)[0];
		const writeLine = lineNumbers(/ctfOperations\.setCTFPlatform\(/)[0];

		expect(validateLine).toBeDefined();
		expect(writeLine).toBeDefined();
		expect(validateLine).toBeLessThan(writeLine);
	});

	it('probes the platform before persisting the change', () => {
		const probeLine = lineNumbers(/await client\.testConnection\(\)/)[0];
		const writeLine = lineNumbers(/ctfOperations\.setCTFPlatform\(/)[0];

		expect(probeLine).toBeDefined();
		expect(writeLine).toBeDefined();
		expect(probeLine).toBeLessThan(writeLine);
	});

	it('never constructs a client directly, only through the registry', () => {
		expect(source).toMatch(/createPlatformClient\(/);
		expect(source).not.toMatch(/createCTFdClient|createNoCTFClient|CTFdClient/);
	});

	it('falls back to the default platform for an unrecognised stored value', () => {
		expect(source).toMatch(/isKnownPlatform\(ctf\.platform\)/);
		expect(source).toMatch(/DEFAULT_PLATFORM/);
	});
});
