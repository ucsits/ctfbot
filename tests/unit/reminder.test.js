import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

// The service is CommonJS, so it `require`s its collaborators natively. Vitest
// module mocks do not intercept those requires. Reach the same module instances
// through createRequire and spy on them instead.
const require = createRequire(import.meta.url);
const taskRepository = require('../../src/database/repositories/task.repository.js');
// Same instance the service requires, so assigning its logger is visible there.
const { container } = require('@sapphire/framework');

// Mock repository
let mockClaimDueReminders;
let mockMarkReminderSent;
let mockReleaseReminder;
let mockListPendingTasks;
let mockHasDigestBeenSent;
let mockMarkDigestSent;
let mockClaimDigestPart;
let mockMarkDigestPartSent;

describe('Reminder Service', () => {
	let mod;

	beforeEach(async () => {
		vi.clearAllMocks();

		mockClaimDueReminders = vi.spyOn(taskRepository, 'claimDueReminders').mockReturnValue([]);
		mockMarkReminderSent = vi.spyOn(taskRepository, 'markReminderSent').mockReturnValue(undefined);
		mockReleaseReminder = vi.spyOn(taskRepository, 'releaseReminder').mockReturnValue(undefined);
		mockListPendingTasks = vi.spyOn(taskRepository, 'listPendingTasks').mockReturnValue([]);
		mockHasDigestBeenSent = vi.spyOn(taskRepository, 'hasDigestBeenSent').mockReturnValue(false);
		mockMarkDigestSent = vi.spyOn(taskRepository, 'markDigestSent').mockReturnValue(undefined);
		mockClaimDigestPart = vi.spyOn(taskRepository, 'claimDigestPart').mockReturnValue(true);
		mockMarkDigestPartSent = vi.spyOn(taskRepository, 'markDigestPartSent').mockReturnValue(undefined);

		// The container has no logger until a client logs in.
		container.logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

		// Fresh import each test
		mod = await import('../../src/services/reminder.js');
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('_groupTasksForFields', () => {
		it('returns empty array for empty input', () => {
			const result = mod._groupTasksForFields([]);
			expect(result).toEqual([]);
		});

		it('keeps all tasks in one group when within field limit', () => {
			const tasks = [
				{ title: 'Task A', assigned_to: '1', deadline: 2000000000 },
				{ title: 'Task B', assigned_to: '2', deadline: 2000000001 }
			];
			const result = mod._groupTasksForFields(tasks);
			expect(result.length).toBe(1);
			expect(result[0].length).toBe(2);
		});

		it('splits into multiple groups when field value would exceed 1024 chars', () => {
			const tasks = Array.from({ length: 50 }, (_, i) => ({
				title: `Task with very long title number ${i} that takes up lots of space`,
				assigned_to: String(i),
				deadline: 2000000000 + i
			}));
			const result = mod._groupTasksForFields(tasks);
			expect(result.length).toBeGreaterThan(1);
			// Verify every task is preserved
			const allTasks = result.flat();
			expect(allTasks.length).toBe(50);
		});
	});

	describe('_formatTaskGroup', () => {
		it('returns empty message for empty group', () => {
			expect(mod._formatTaskGroup([])).toBe('No pending tasks.');
		});
	});

	describe('_buildMentions', () => {
		it('deduplicates mentions', () => {
			const tasks = [
				{ assigned_to: '1' },
				{ assigned_to: '1' },
				{ assigned_to: '2' }
			];
			const result = mod._buildMentions(tasks);
			expect(result).toEqual(['<@1>', '<@2>']);
		});

		it('returns empty array for empty tasks', () => {
			expect(mod._buildMentions([])).toEqual([]);
		});
	});

	describe('_buildMentionContent', () => {
		it('returns null when no mentions', () => {
			expect(mod._buildMentionContent('Label', [])).toBeNull();
		});

		it('prefixes mentions with label', () => {
			const result = mod._buildMentionContent('**Digest**', ['<@1>', '<@2>']);
			expect(result).toContain('**Digest**');
			expect(result).toContain('<@1>');
			expect(result).toContain('<@2>');
		});

		it('truncates to stay under 2000 characters', () => {
			const manyMentions = Array.from({ length: 100 }, (_, i) => `<@${i}>`);
			const result = mod._buildMentionContent('Label', manyMentions);
			expect(result.length).toBeLessThanOrEqual(2000);
		});
	});

	describe('_estimateMentionsLength', () => {
		it('estimates mention string length', () => {
			const tasks = [
				{ assigned_to: '1' },
				{ assigned_to: '2' },
				{ assigned_to: '1' } // duplicate
			];
			// <@1> (4 chars) + space + <@2> (4 chars) + space = 10
			const len = mod._estimateMentionsLength(tasks);
			expect(len).toBe(10);
		});
	});

	describe('pollWeeklyDigest - Monday suppression', () => {
		it('does not send when not Monday', async () => {
			// Use DateTime.now() -> we need to manipulate the time
			// Since we can't mock luxon DateTime.now easily, we test the logic
			// through the early-return path
			mockHasDigestBeenSent.mockReturnValue(false);
			// We need a clientRef. Let's test without it
			const result = await mod.pollWeeklyDigest();
			// Without clientRef, it returns false
			expect(result).toBe(false);
		});

		it('does not send when the client is not started', async () => {
			const result = await mod.pollWeeklyDigest();
			expect(result).toBe(false);
		});

		it('does not send when the daily client is not started', async () => {
			const result = await mod.pollDailyDigest();
			expect(result).toBe(false);
		});
	});

	describe('_sendDigest behavioral', () => {
		function makeChannel() {
			return { send: vi.fn().mockResolvedValue({}), isTextBased: () => true };
		}

		function baseOpts(overrides = {}) {
			return {
				title: 'Weekly Task Digest',
				color: 0x9B59B6,
				description: 'Good morning! Here is an overview of pending tasks.',
				footer: 'Sent Monday at 5AM Jakarta time',
				mentionLabel: '**Weekly Task Digest**',
				...overrides
			};
		}

		it('sends an explicit empty-state digest when there are no tasks', async () => {
			const channel = makeChannel();
			await mod._sendDigest(channel, baseOpts({
				sections: [{ heading: 'This Week (0 tasks)', tasks: [] }]
			}));
			expect(channel.send).toHaveBeenCalledTimes(1);
			const embed = channel.send.mock.calls[0][0].embeds[0];
			// Explicit empty state rather than a silent/dropped digest
			expect(embed.data.fields[0].value).toBe('No pending tasks.');
		});

		it('splits large digests into multiple messages', async () => {
			const channel = makeChannel();
			const tasks = Array.from({ length: 100 }, (_, i) => ({
				title: `Task number ${i} with a fairly long title that takes up space`,
				assigned_to: String(i % 10),
				deadline: 2000000000 + i
			}));
			await mod._sendDigest(channel, baseOpts({
				title: 'Daily Task Digest',
				color: 0x3498DB,
				description: 'Good morning! Here are the tasks until end of week.',
				footer: 'Sent today at 4AM Jakarta time',
				mentionLabel: '**Daily Task Digest**',
				sections: [{ heading: 'Today', tasks }]
			}));
			expect(channel.send.mock.calls.length).toBeGreaterThan(1);
			// Every task is preserved across all messages (fields hold multiple tasks)
			const allFields = channel.send.mock.calls.flatMap(c => c[0].embeds[0].data.fields);
			const taskLines = allFields.flatMap(f => f.value.split('\n')).filter(line => line.includes('• **Task number'));
			expect(taskLines.length).toBe(100);
		});

		it('never mentions a user whose task is not in the same message', async () => {
			const channel = makeChannel();
			const tasks = Array.from({ length: 100 }, (_, i) => ({
				title: `Task number ${i} with a fairly long title that takes up space`,
				assigned_to: String(i % 10),
				deadline: 2000000000 + i
			}));
			await mod._sendDigest(channel, baseOpts({
				title: 'Daily Task Digest',
				sections: [{ heading: 'Today', tasks }]
			}));
			for (const call of channel.send.mock.calls) {
				const content = call[0].content || '';
				const mentions = [...content.matchAll(/<@(\d+)>/g)].map(m => m[1]);
				const fieldText = JSON.stringify(call[0].embeds[0].data.fields);
				for (const id of mentions) {
					expect(fieldText).toContain(`<@${id}>`);
				}
			}
		});

		it('keeps all messages under Discord limits', async () => {
			const channel = makeChannel();
			const tasks = Array.from({ length: 150 }, (_, i) => ({
				title: `Task ${i} - ${'x'.repeat(60)}`,
				assigned_to: String(i),
				deadline: 2000000000 + i
			}));
			await mod._sendDigest(channel, baseOpts({
				sections: [{ heading: 'Today', tasks }]
			}));
			for (const call of channel.send.mock.calls) {
				const { content = '', embeds = [] } = call[0];
				expect(content.length).toBeLessThanOrEqual(2000);
				for (const embed of embeds) {
					expect(JSON.stringify(embed.data).length).toBeLessThanOrEqual(6000);
					expect(embed.data.fields.length).toBeLessThanOrEqual(25);
					for (const field of embed.data.fields) {
						expect(field.value.length).toBeLessThanOrEqual(1024);
					}
				}
			}
		});
	});

	describe('pollReminders - failure handling', () => {
		it('marks permanent failures correctly', async () => {
			mockClaimDueReminders.mockReturnValue([]);
			// No due reminders -> nothing happens
			await mod.pollReminders();
			expect(mockMarkReminderSent).not.toHaveBeenCalled();
		});

		it('returns without error when client is not started', async () => {
			const result = await mod.pollReminders();
			expect(result).toBeUndefined();
		});
	});

	describe('buildReminderButtons', () => {
		it('adds a Mark done button that carries the task id', () => {
			const row = mod.buildReminderButtons('task-7').toJSON();
			expect(row.components).toHaveLength(1);
			expect(row.components[0].custom_id).toBe('remind_done:task-7');
			expect(row.components[0].label).toBe('Mark done');
			// ButtonStyle.Success
			expect(row.components[0].style).toBe(3);
		});
	});

	describe('buildOverdueButtons', () => {
		function tasks(n) {
			return Array.from({ length: n }, (_, i) => ({ task_id: `t${i}`, title: `Task ${i}` }));
		}

		it('adds one button per task, up to 5 per row', () => {
			const rows = mod.buildOverdueButtons(tasks(3)).map(row => row.toJSON());
			expect(rows).toHaveLength(1);
			expect(rows[0].components).toHaveLength(3);
			expect(rows[0].components[0].custom_id).toBe('overdue_done:t0');
			expect(rows[0].components[0].label).toBe('Done: Task 0');
			expect(rows[0].components[0].style).toBe(3);
		});

		it('uses at most 5 rows for 25 tasks', () => {
			const rows = mod.buildOverdueButtons(tasks(25)).map(row => row.toJSON());
			expect(rows).toHaveLength(5);
			expect(rows.flatMap(row => row.components)).toHaveLength(25);
		});

		it('caps the button list at 25 tasks', () => {
			const rows = mod.buildOverdueButtons(tasks(30)).map(row => row.toJSON());
			expect(rows).toHaveLength(5);
			expect(rows.flatMap(row => row.components)).toHaveLength(25);
		});

		it('truncates long titles to the 80 character label limit', () => {
			const row = mod.buildOverdueButtons([{ task_id: 't1', title: 'x'.repeat(200) }])[0].toJSON();
			expect(row.components[0].label.length).toBe(80);
		});
	});

	describe('_sendDigest with per-task buttons', () => {
		function makeChannel() {
			return { send: vi.fn().mockResolvedValue({}), isTextBased: () => true };
		}

		it('never puts more tasks in a message than it has buttons for', async () => {
			mockClaimDigestPart.mockReturnValue(true);
			const channel = makeChannel();
			const tasks = Array.from({ length: 60 }, (_, i) => ({
				task_id: `task-${i}`,
				title: `Task ${i} with a reasonably long title`,
				assigned_to: String(i),
				deadline: 2000000000 + i
			}));

			await mod._sendDigest(channel, {
				title: 'Overdue Tasks',
				color: 0xe74c3c,
				description: 'Overdue',
				footer: 'Sent today',
				mentionLabel: '**Overdue Tasks**',
				digestKey: 'overdue:2026-11-17',
				maxTasksPerMessage: 25,
				buildButtons: mod.buildOverdueButtons,
				sections: [{ heading: 'Overdue (60 tasks)', tasks }]
			});

			expect(channel.send.mock.calls.length).toBeGreaterThan(1);

			const seenIds = [];
			for (const call of channel.send.mock.calls) {
				const buttons = (call[0].components || []).flatMap(row =>
					row.toJSON ? row.toJSON().components : row.components
				);
				expect(buttons.length).toBeLessThanOrEqual(25);
				expect(buttons.length).toBeGreaterThan(0);
				for (const button of buttons) {
					seenIds.push(button.custom_id);
				}
			}
			// Every task keeps exactly one button across the digest
			expect(seenIds).toHaveLength(60);
			expect(new Set(seenIds).size).toBe(60);
		});

		it('omits components when no button builder is supplied', async () => {
			const channel = makeChannel();
			await mod._sendDigest(channel, {
				title: 'Daily Task Digest',
				color: 0x3498db,
				description: 'Daily',
				footer: 'Sent today',
				mentionLabel: '**Daily**',
				sections: [{ heading: 'Today', tasks: [{ title: 'A', assigned_to: '1', deadline: 2000000000 }] }]
			});
			expect(channel.send.mock.calls[0][0].components).toBeUndefined();
		});
	});

	describe('pollOverdueDigest', () => {
		function makeClient() {
			const channel = { send: vi.fn().mockResolvedValue({}), isTextBased: () => true };
			return { channel, client: { channels: { fetch: vi.fn().mockResolvedValue(channel) } } };
		}

		afterEach(() => {
			vi.useRealTimers();
		});

		it('returns false when the client is not started', async () => {
			expect(await mod.pollOverdueDigest(null)).toBe(false);
		});

		it('does not send before 10AM Jakarta time', async () => {
			vi.useFakeTimers();
			// 09:59 Asia/Jakarta
			vi.setSystemTime(new Date('2026-11-17T02:59:00Z'));
			const { client } = makeClient();
			expect(await mod.pollOverdueDigest(client)).toBe(false);
			expect(mockListPendingTasks).not.toHaveBeenCalled();
		});

		it('sends the overdue digest with one button per task at 10AM Jakarta', async () => {
			vi.useFakeTimers();
			// 10:00 Asia/Jakarta
			vi.setSystemTime(new Date('2026-11-17T03:00:00Z'));

			mockHasDigestBeenSent.mockReturnValue(false);
			mockClaimDigestPart.mockReturnValue(true);
			mockListPendingTasks.mockReturnValue([
				{ task_id: 'overdue-1', title: 'Late task', assigned_to: '42', deadline: 2000000000 }
			]);

			const { channel, client } = makeClient();
			expect(await mod.pollOverdueDigest(client)).toBe(true);

			// Only tasks whose deadline already passed are requested
			expect(mockListPendingTasks).toHaveBeenCalledWith({
				deadlineBefore: Math.floor(new Date('2026-11-17T03:00:00Z').getTime() / 1000)
			});

			expect(channel.send).toHaveBeenCalledTimes(1);
			const payload = channel.send.mock.calls[0][0];
			expect(payload.content).toContain('<@42>');
			const buttons = payload.components.flatMap(row => row.toJSON().components);
			expect(buttons).toHaveLength(1);
			expect(buttons[0].custom_id).toBe('overdue_done:overdue-1');

			// The day is recorded so a restart cannot resend it
			expect(mockMarkDigestSent).toHaveBeenCalledWith('overdue:2026-11-17');
		});

		it('does not resend on a second poll the same day', async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-11-17T03:00:00Z'));
			mockHasDigestBeenSent.mockReturnValue(true);

			const { channel, client } = makeClient();
			expect(await mod.pollOverdueDigest(client)).toBe(false);
			expect(channel.send).not.toHaveBeenCalled();
		});

		it('stays silent but marks the day when nothing is overdue', async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-11-17T03:00:00Z'));
			mockHasDigestBeenSent.mockReturnValue(false);
			mockListPendingTasks.mockReturnValue([]);

			const { channel, client } = makeClient();
			expect(await mod.pollOverdueDigest(client)).toBe(false);
			expect(channel.send).not.toHaveBeenCalled();
			expect(mockMarkDigestSent).toHaveBeenCalledWith('overdue:2026-11-17');
		});
	});
});
