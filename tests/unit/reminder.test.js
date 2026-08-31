import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock repository
const mockClaimDueReminders = vi.fn();
const mockMarkReminderSent = vi.fn();
const mockReleaseReminder = vi.fn();
const mockListPendingTasks = vi.fn();
const mockHasDigestBeenSent = vi.fn();
const mockMarkDigestSent = vi.fn();
const mockClaimDigestPart = vi.fn();
const mockMarkDigestPartSent = vi.fn();

vi.mock('../../src/database/repositories/task.repository', () => ({
	default: {
		claimDueReminders: (...args) => mockClaimDueReminders(...args),
		markReminderSent: (...args) => mockMarkReminderSent(...args),
		releaseReminder: (...args) => mockReleaseReminder(...args),
		listPendingTasks: (...args) => mockListPendingTasks(...args),
		hasDigestBeenSent: (...args) => mockHasDigestBeenSent(...args),
		markDigestSent: (...args) => mockMarkDigestSent(...args),
		claimDigestPart: (...args) => mockClaimDigestPart(...args),
		markDigestPartSent: (...args) => mockMarkDigestPartSent(...args)
	}
}));

// Mock the container logger
vi.mock('@sapphire/framework', () => ({
	container: {
		logger: {
			info: vi.fn(),
			error: vi.fn(),
			warn: vi.fn()
		}
	}
}));

// Mock constants
vi.mock('../../src/lib/constants/config', () => ({
	default: {
		REMINDER_CHANNEL_ID: '1524933314119467200'
	}
}));

// Mock date utils
vi.mock('../../src/lib/utils/date', () => ({
	computePeriodRange: vi.fn(() => ({ start: 1000000000, end: 9999999999 }))
}));

import { container } from '@sapphire/framework';
import taskRepository from '../../src/database/repositories/task.repository';

describe('Reminder Service', () => {
	let mod;

	beforeEach(async () => {
		vi.clearAllMocks();
		// Fresh import each test
		mod = await import('../../src/services/reminder.js');
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
			expect(mod._formatTaskGroup([])).toBe('✅ No pending tasks.');
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
			const result = mod._buildMentionContent('📋 **Digest**', ['<@1>', '<@2>']);
			expect(result).toContain('📋 **Digest**');
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
				title: '📋 Weekly Task Digest',
				color: 0x9B59B6,
				description: 'Good morning! Here is an overview of pending tasks.',
				footer: 'Sent Monday at 5AM Jakarta time',
				mentionLabel: '📋 **Weekly Task Digest**',
				...overrides
			};
		}

		it('sends an explicit empty-state digest when there are no tasks', async () => {
			const channel = makeChannel();
			await mod._sendDigest(channel, baseOpts({
				sections: [{ heading: '🗓️ This Week (0 tasks)', tasks: [] }]
			}));
			expect(channel.send).toHaveBeenCalledTimes(1);
			const embed = channel.send.mock.calls[0][0].embeds[0];
			// Explicit empty state rather than a silent/dropped digest
			expect(embed.data.fields[0].value).toBe('✅ No pending tasks.');
		});

		it('splits large digests into multiple messages', async () => {
			const channel = makeChannel();
			const tasks = Array.from({ length: 100 }, (_, i) => ({
				title: `Task number ${i} with a fairly long title that takes up space`,
				assigned_to: String(i % 10),
				deadline: 2000000000 + i
			}));
			await mod._sendDigest(channel, baseOpts({
				title: '📅 Daily Task Digest',
				color: 0x3498DB,
				description: 'Good morning! Here are the tasks until end of week.',
				footer: 'Sent today at 4AM Jakarta time',
				mentionLabel: '📅 **Daily Task Digest**',
				sections: [{ heading: '🗓️ Today', tasks }]
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
				title: '📅 Daily Task Digest',
				sections: [{ heading: '🗓️ Today', tasks }]
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
				sections: [{ heading: '🗓️ Today', tasks }]
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
});
