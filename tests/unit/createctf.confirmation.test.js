import { describe, it, expect, beforeEach } from 'vitest';
import { GuildScheduledEvent } from 'discord.js';
import { CreateCTFCommand } from '../../src/commands/createctf.js';

// ── Strategy ───────────────────────────────────────────────────────────
// sendConfirmation read `event.scheduledStartTime`, which does not exist on a
// discord.js v14 GuildScheduledEvent. The real property is `scheduledStartAt`
// (a Date) backed by `scheduledStartTimestamp`. Line 324 threw
// `TypeError: Cannot read properties of undefined (reading 'getTime')` and line
// 317 silently produced `Invalid Date`, which rendered as `<t:NaN:F>`.
//
// The existing ctfSaga.source.test.js only asserts on source text, so it could
// never catch this. These tests execute sendConfirmation against a REAL
// GuildScheduledEvent built from the raw API payload shape, which is what makes
// the wrong property name observable.

/** Raw API payload for a GuildScheduledEvent, matching the Discord REST shape. */
const API_EVENT = {
	id: '111111111111111111',
	guild_id: '222222222222222222',
	name: 'K17 CTF 2026',
	description: 'Join us for K17 CTF 2026!',
	scheduled_start_time: '2026-09-11T10:00:00.000Z',
	scheduled_end_time: '2026-09-12T10:00:00.000Z',
	privacy_level: 2,
	status: 1,
	entity_type: 3,
	entity_metadata: { location: 'Online' },
	creator_id: '333333333333333333'
};

// 2026-09-11T10:00:00.000Z, the UTC instant behind the Asia/Jakarta 17:00 start.
const START_UNIX = 1789120800;

/**
 * The GuildScheduledEvent constructor resolves the creator and the guild, so a
 * minimal client stub is required to build a real structure in a unit test.
 */
function makeClientStub() {
	return {
		users: { resolve: () => null },
		guilds: { resolve: () => null }
	};
}

function makeEvent(overrides = {}) {
	return new GuildScheduledEvent(makeClientStub(), { ...API_EVENT, ...overrides });
}

/** Instantiate the command without running the Sapphire constructor. */
function makeCommand() {
	const command = Object.create(CreateCTFCommand.prototype);
	// `container` is a getter on the Sapphire Piece prototype, so it has to be
	// shadowed with an own property rather than assigned.
	Object.defineProperty(command, 'container', {
		value: { logger: { info() {}, warn() {}, error() {} } },
		writable: true,
		configurable: true
	});
	return command;
}

function makeChannel(id = '999999999999999999') {
	return { id, toString: () => `<#${id}>` };
}

function makeOptions(extra = {}) {
	return {
		ctfName: 'K17 CTF 2026',
		dateStr: '11-09-2026 17:00',
		timezone: 'Asia/Jakarta',
		...extra
	};
}

function findField(embed, name) {
	return embed.data.fields.find(field => field.name === name);
}

describe('createctf sendConfirmation against a real GuildScheduledEvent', () => {
	let captured;

	beforeEach(() => {
		captured = null;
	});

	function makeInteraction() {
		return {
			editReply: (payload) => {
				captured = payload;
				return Promise.resolve('sent');
			}
		};
	}

	it('documents the discord.js v14 property names that caused the bug', () => {
		const event = makeEvent();

		// The v13-style name the command used to read is not on the structure.
		expect(event.scheduledStartTime).toBeUndefined();
		// The v14 read-back property is a Date; the numeric form also exists.
		expect(event.scheduledStartAt).toBeInstanceOf(Date);
		expect(event.scheduledStartAt.toISOString()).toBe('2026-09-11T10:00:00.000Z');
		expect(event.scheduledStartTimestamp).toBe(Date.parse('2026-09-11T10:00:00.000Z'));
	});

	it('resolves and renders a real start timestamp instead of throwing', async () => {
		const command = makeCommand();
		const event = makeEvent();

		await expect(
			command.sendConfirmation(makeInteraction(), makeChannel(), event, makeOptions())
		).resolves.toBe('sent');

		const embed = captured.embeds[0];
		expect(findField(embed, 'Start Time').value).toBe(`<t:${START_UNIX}:F>`);
	});

	it('does not leak Invalid Date into the description', async () => {
		const command = makeCommand();

		await command.sendConfirmation(makeInteraction(), makeChannel(), makeEvent(), makeOptions());

		const embed = captured.embeds[0];
		expect(embed.data.description).toContain(`<t:${START_UNIX}:F>`);
		expect(embed.data.description).not.toContain('NaN');
		expect(embed.data.description).toContain('K17 CTF 2026');
	});

	it('includes the event link and channel', async () => {
		const command = makeCommand();
		const event = makeEvent();

		await command.sendConfirmation(makeInteraction(), makeChannel(), event, makeOptions());

		const embed = captured.embeds[0];
		expect(findField(embed, 'Event Link').value).toBe(`[View Event](${event.url})`);
		expect(findField(embed, 'Channel').value).toBe('<#999999999999999999>');
	});

	it('still resolves and adds the voice channel field when one is supplied', async () => {
		const command = makeCommand();
		const voiceChannel = makeChannel('123456789012345678');

		await expect(
			command.sendConfirmation(
				makeInteraction(),
				makeChannel(),
				makeEvent(),
				makeOptions({ voiceChannel })
			)
		).resolves.toBe('sent');

		const embed = captured.embeds[0];
		expect(findField(embed, 'Start Time').value).toBe(`<t:${START_UNIX}:F>`);
		expect(findField(embed, '🔊 Voice Channel').value).toBe('<#123456789012345678>');
	});

	it('renders the interpretation for a non-default timezone', async () => {
		const command = makeCommand();
		// 2026-09-11T10:00:00.000Z is 2026-09-11T03:00:00 in Los Angeles.
		const event = makeEvent({
			scheduled_start_time: '2026-09-11T10:00:00.000Z'
		});

		await command.sendConfirmation(
			makeInteraction(),
			makeChannel(),
			event,
			makeOptions({ timezone: 'America/Los_Angeles', dateStr: '11-09-2026 03:00' })
		);

		const embed = captured.embeds[0];
		expect(embed.data.description).toContain('America/Los_Angeles');
		expect(embed.data.description).not.toContain('NaN');
	});
});
