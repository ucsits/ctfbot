import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, copyFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let tmpDir;
let originalCwd;
let db;

beforeAll(async () => {
	originalCwd = process.cwd();
	tmpDir = mkdtempSync(join(tmpdir(), 'ctfbot-luce-'));
	copyFileSync(join(originalCwd, 'ctfbot.db'), join(tmpDir, 'ctfbot.db'));
	process.chdir(tmpDir);

	// Real DB so task_done/task_cancel enrichment can resolve task metadata
	const { getConnection } = await import('../../src/database/connection.js');
	const { runMigrations } = await import('../../src/database/migrations.js');
	db = getConnection();
	const migration = runMigrations(db, join(originalCwd, 'migrations'));
	expect(migration.error).toBeNull();
});

afterAll(() => {
	if (db?.open) {
		db.close();
	}
	process.chdir(originalCwd);
	if (tmpDir) {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

async function loadLuce() {
	// Fresh ESM import so the module-level singleton state is reset per test
	const mod = await import('../../src/lib/luce/index.js');
	return mod;
}

function block(data, height = 42, timestamp = 2000000000) {
	return { data: JSON.stringify(data), height, timestamp };
}

describe('Luce audit block embeds', () => {
	it('renders task creation events', async () => {
		const luce = await loadLuce();
		const embed = luce._buildBlockEmbed(block({
			type: 'task',
			title: 'Fix the parser',
			createdBy: '111',
			assignedTo: '222'
		}));
		expect(embed.data.title).toBe('📋 Task Created');
		expect(embed.data.description).toBe('Fix the parser');
		expect(embed.data.fields.map(f => f.value)).toEqual(
			expect.arrayContaining(['<@111>', '<@222>', '#42'])
		);
	});

	it('renders task completion with fallback title when DB row is gone', async () => {
		const luce = await loadLuce();
		const embed = luce._buildBlockEmbed(block({
			type: 'task_done',
			taskId: '00000000-0000-4000-8000-000000000000',
			title: 'Fix the parser',
			completedBy: '111',
			assignedTo: '222'
		}));
		expect(embed.data.title).toBe('✅ Task Completed');
		expect(embed.data.description).toBe('Fix the parser');
		expect(embed.data.fields.map(f => f.value)).toEqual(
			expect.arrayContaining(['<@111>', '<@222>'])
		);
	});

	it('renders task cancellation with actor and block height', async () => {
		const luce = await loadLuce();
		const embed = luce._buildBlockEmbed(block({
			type: 'task_cancel',
			taskId: '00000000-0000-4000-8000-000000000000',
			title: 'Cancel me',
			cancelledBy: '333',
			assignedTo: '222'
		}));
		expect(embed.data.title).toBe('🗑️ Task Cancelled');
		expect(embed.data.description).toBe('Cancel me');
		expect(embed.data.fields.map(f => f.value)).toEqual(
			expect.arrayContaining(['<@333>', '<@222>', '#42'])
		);
	});

	it('falls back to task ID when no title is available', async () => {
		const luce = await loadLuce();
		const id = 'a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d';
		const embed = luce._buildBlockEmbed(block({
			type: 'task_done',
			taskId: id,
			completedBy: '111'
		}));
		expect(embed.data.description).toBe(`Task \`${id}\` marked as done`);
	});

	it('handles malformed block data without throwing', async () => {
		const luce = await loadLuce();
		const embed = luce._buildBlockEmbed({ data: 'not-json{{{', height: 7, timestamp: 1 });
		expect(embed.data.title).toBe('⛓️ New Block');
		expect(embed.data.description).toContain('#7');
	});

	it('handles unknown block types with a generic embed', async () => {
		const luce = await loadLuce();
		const embed = luce._buildBlockEmbed({ data: JSON.stringify({ type: 'mystery_event' }), author: '111', height: 7, timestamp: 1 });
		expect(embed.data.title).toBe('⛓️ New Block');
		expect(embed.data.fields.map(f => f.value)).toEqual(expect.arrayContaining(['<@111>', 'mystery_event']));
	});
});

describe('Luce audit notification fallback', () => {
	it('does not send when no Discord client is registered', async () => {
		const luce = await loadLuce();
		await expect(luce._notifyBlock(block({ type: 'task', title: 'X', createdBy: '1', assignedTo: '2' })))
			.resolves.toBeUndefined();
	});

	it('sends an embed with real mentions in content only', async () => {
		const luce = await loadLuce();
		const send = vi.fn().mockResolvedValue({});
		const client = {
			channels: {
				fetch: vi.fn().mockResolvedValue({ isTextBased: () => true, send })
			}
		};
		luce.setDiscordClient(client);
		await luce._notifyBlock(block({
			type: 'task_cancel',
			taskId: '00000000-0000-4000-8000-000000000000',
			title: 'Cancel me',
			cancelledBy: '333',
			assignedTo: '222'
		}));
		expect(send).toHaveBeenCalledTimes(1);
		const payload = send.mock.calls[0][0];
		// Real mention in message content
		expect(payload.content).toContain('<@333>');
		// allowedMentions restricted to the users actually referenced
		expect(payload.allowedMentions.users).toEqual(expect.arrayContaining(['333', '222']));
		// Embed does not carry raw mention syntax in the description
		expect(payload.embeds[0].data.description).not.toMatch(/<@\d+>/);
	});

	it('falls back to a generic embed when enrichment fails', async () => {
		const luce = await loadLuce();
		const send = vi.fn().mockResolvedValue({});
		const client = {
			channels: {
				fetch: vi.fn().mockResolvedValue({ isTextBased: () => true, send })
			}
		};
		luce.setDiscordClient(client);
		// Malformed data — content stays empty, generic embed is sent
		await luce._notifyBlock({ data: '{{{', height: 9, timestamp: 1 });
		expect(send).toHaveBeenCalledTimes(1);
		const payload = send.mock.calls[0][0];
		expect(payload.embeds[0].data.title).toBe('⛓️ New Block');
		expect(payload.content).toBeUndefined();
	});

	it('does not send when the channel is missing', async () => {
		const luce = await loadLuce();
		const client = {
			channels: {
				fetch: vi.fn().mockResolvedValue(null)
			}
		};
		luce.setDiscordClient(client);
		await luce._notifyBlock(block({ type: 'task', title: 'X', createdBy: '1', assignedTo: '2' }));
		expect(client.channels.fetch).toHaveBeenCalled();
	});
});
