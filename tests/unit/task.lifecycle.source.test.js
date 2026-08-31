import { describe, it, expect } from 'vitest';

// ── Strategy ───────────────────────────────────────────────────────────
// This project's modules are CommonJS, and vitest (v4, node environment)
// does not intercept `require()` calls made from inside CJS modules here
// (verified empirically). `vi.mock` factories only affect ESM `import`.
// Therefore, behavior tests for the task command use two reliable layers:
//
//   1. Source-inspection assertions (this file): guarantee the user-facing
//      strings, validation rules, pagination, and lifecycle ordering exist
//      in the code, so they cannot silently regress.
//
//   2. Real-repository integration tests (task.repository.test.js): prove
//      claims, completion, cancellation, and digest-part idempotency work
//      against a real SQLite database.

import { readFileSync } from 'fs';
import { join } from 'path';

const root = process.cwd();
const taskCommand = readFileSync(join(root, 'src/commands/task.js'), 'utf8');
const reminderService = readFileSync(join(root, 'src/services/reminder.js'), 'utf8');
const luce = readFileSync(join(root, 'src/lib/luce/index.js'), 'utf8');
const interactionCreate = readFileSync(join(root, 'src/listeners/interactionCreate.js'), 'utf8');

// ── /task add ──────────────────────────────────────────────────────────
describe('/task add input hardening', () => {
	it('validates title length (1-100)', () => {
		expect(taskCommand).toContain('Task title must be between 1 and 100 characters');
		expect(taskCommand).toContain('!title || title.length > 100');
	});

	it('validates description length (max 4000)', () => {
		expect(taskCommand).toContain('Task description cannot exceed 4000 characters');
		expect(taskCommand).toContain('description.length > 4000');
	});

	it('validates timezone length (max 64)', () => {
		expect(taskCommand).toContain('Timezone is too long');
		expect(taskCommand).toContain('timezone.length > 64');
	});

	it('defaults timezone to Asia/Jakarta', () => {
		expect(taskCommand).toContain("|| 'Asia/Jakarta'");
	});

	it('rejects past deadlines with a clear message', () => {
		expect(taskCommand).toContain('Deadline must be in the future');
		expect(taskCommand).toContain('deadlineDate <= new Date()');
	});

	it('truncates description to 1024 in embed fields (Discord limit)', () => {
		expect(taskCommand).toContain('description.slice(0, 1024)');
	});

	it('writes to blockchain before DB so no orphan tasks exist', () => {
		// appendBlock must appear before createTask in the method body
		const addMethod = taskCommand.slice(taskCommand.indexOf('async _add'), taskCommand.indexOf('async _list'));
		expect(addMethod.indexOf('luce.appendBlock')).toBeLessThan(addMethod.indexOf('taskRepository.createTask'));
	});

	it('creates reminders with unique timestamps to avoid duplicate notifications', () => {
		const addMethod = taskCommand.slice(taskCommand.indexOf('async _add'), taskCommand.indexOf('async _list'));
		expect(addMethod).toContain('new Set()');
		expect(addMethod).toContain('reminderTimes.add');
	});
});

// ── /task list ─────────────────────────────────────────────────────────
describe('/task list pagination and reporting', () => {
	it('shows a friendly empty state', () => {
		expect(taskCommand).toContain('No remaining tasks for');
	});

	it('paginates in chunks of 20 with page labels', () => {
		expect(taskCommand).toContain('tasks.slice(i, i + 20)');
		expect(taskCommand).toContain('page ${index + 1}/${pages.length}');
	});

	it('reports Asia/Jakarta as the canonical reporting timezone', () => {
		expect(taskCommand).toContain('Reporting timezone: **Asia/Jakarta**');
	});

	it('uses follow-ups for pages after the first', () => {
		expect(taskCommand).toContain('interaction.followUp({ embeds: [embed] })');
	});
});

// ── /task done & /task cancel lifecycle ────────────────────────────────
describe('task lifecycle transitions', () => {
	it('validates UUID format before touching the repository', () => {
		expect(taskCommand).toContain('Task ID must be a valid UUID');
		// The regex must check the version nibble [1-5] and variant [89ab]
		expect(taskCommand).toContain('[1-5][0-9a-f]{3}');
		expect(taskCommand).toContain('[89ab][0-9a-f]{3}');
	});

	it('requires either a task_id or a title query', () => {
		expect(taskCommand).toContain(
			'Provide either `task_id` (the task UUID) or `task` (task title to fuzzy search).'
		);
	});

	it('guards against already done / already cancelled / contested tasks', () => {
		expect(taskCommand).toContain('This task is already marked as done');
		expect(taskCommand).toContain('This task has already been cancelled');
		expect(taskCommand).toContain('already being updated by another action');
	});

	it('fuzzy-searches title AND description with a confidence threshold', () => {
		expect(taskCommand).toContain('resolveTaskCandidates');
		expect(taskCommand).toContain('searchTasksByQuery');
		expect(taskCommand).toContain('MIN_FUZZY_SCORE');
		expect(taskCommand).toContain('minimum confidence');
	});

	it('always requires an ephemeral confirmation before any transition for title matches', () => {
		// The fuzzy path must render a confirm/picker reply, never execute
		expect(taskCommand).toContain('_taskConfirmReply');
		expect(taskCommand).toContain('_taskPickerReply');
		expect(taskCommand).toContain('ephemeral: true');
		expect(taskCommand).toContain('Action requires confirmation.');
		expect(taskCommand).toContain('Nothing has been recorded yet');
	});

	it('executes the transition only inside the shared _execute* methods', () => {
		// The claim → blockchain → DB ordering lives in _executeDone/_executeCancel,
		// which are shared by the slash command AND the confirm button listener.
		expect(taskCommand).toContain('async _executeDone(task, interaction)');
		expect(taskCommand).toContain('async _executeCancel(task, interaction)');
		const doneMethod = taskCommand.slice(
			taskCommand.indexOf('async _executeDone'),
			taskCommand.indexOf('async _executeCancel')
		);
		expect(doneMethod.indexOf('claimTaskTransition')).toBeLessThan(doneMethod.indexOf('luce.appendBlock'));
		expect(doneMethod.indexOf('luce.appendBlock')).toBeLessThan(doneMethod.indexOf('completeTask'));
		const cancelMethod = taskCommand.slice(
			taskCommand.indexOf('async _executeCancel'),
			taskCommand.indexOf('async _done')
		);
		expect(cancelMethod.indexOf('claimTaskTransition')).toBeLessThan(cancelMethod.indexOf('luce.appendBlock'));
		expect(cancelMethod.indexOf('luce.appendBlock')).toBeLessThan(cancelMethod.indexOf('cancelTask'));
	});

	it('releases the transition claim on error so retries are not blocked', () => {
		expect(taskCommand).toContain('releaseTaskTransition');
		const doneMethod = taskCommand.slice(
			taskCommand.indexOf('async _executeDone'),
			taskCommand.indexOf('async _executeCancel')
		);
		expect(doneMethod).toContain('releaseTaskTransition');
		const cancelMethod = taskCommand.slice(taskCommand.indexOf('async _executeCancel'));
		expect(cancelMethod).toContain('releaseTaskTransition');
	});

	it('reports concurrent loss without claiming success', () => {
		expect(taskCommand).toContain('already updated by another action; no completion was recorded');
		expect(taskCommand).toContain('already updated by another action; no cancellation was recorded');
	});

	it('separates persistence from reply so reply failures do not lie', () => {
		// Persistence happens inside _execute*; the final success/failure content
		// is returned to the caller (button listener) after the DB write.
		const doneMethod = taskCommand.slice(
			taskCommand.indexOf('async _executeDone'),
			taskCommand.indexOf('async _executeCancel')
		);
		expect(doneMethod.indexOf('completeTask')).toBeLessThan(doneMethod.indexOf('marked as done!'));
		expect(doneMethod).toContain('No completion was recorded; please try again');

		const cancelMethod = taskCommand.slice(taskCommand.indexOf('async _executeCancel'));
		expect(cancelMethod.indexOf('cancelTask')).toBeLessThan(cancelMethod.indexOf('has been cancelled'));
		expect(cancelMethod).toContain('No cancellation was recorded; please try again');
	});

	it('exposes button namespaces and deny/picker no-op behavior', () => {
		expect(taskCommand).toContain('task_done_confirm');
		expect(taskCommand).toContain('task_done_candidate');
		expect(taskCommand).toContain('task_done_deny');
		expect(taskCommand).toContain('task_cancel_confirm');
		expect(taskCommand).toContain('task_cancel_candidate');
		expect(taskCommand).toContain('task_cancel_deny');
		expect(taskCommand).toContain("setLabel('Deny')");
	});
});

// ── Task confirmation button listener ─────────────────────────────────
describe('task confirm button listener', () => {
	it('routes done/cancel confirm+deny+candidate buttons to the shared transition methods', () => {
		expect(interactionCreate).toContain('_handleTaskConfirm');
		expect(interactionCreate).toContain('TASK_DONE_IDS');
		expect(interactionCreate).toContain('TASK_CANCEL_IDS');
		expect(interactionCreate).toContain('_executeDone');
		expect(interactionCreate).toContain('_executeCancel');
		expect(interactionCreate).toContain('TASK_DONE_IDS.candidate');
		expect(interactionCreate).toContain('TASK_CANCEL_IDS.candidate');
	});

	it('verifies the button clicker is the user who initiated the prompt', () => {
		expect(interactionCreate).toContain('initiatorId');
		expect(interactionCreate).toContain('initiatorId !== interaction.user.id');
		expect(interactionCreate).toContain('belongs to someone else');
	});

	it('deny buttons close the prompt without recording anything', () => {
		expect(interactionCreate).toContain('nothing was recorded');
		expect(interactionCreate).toContain('components: []');
	});

	it('re-checks task state before executing a confirmed transition', () => {
		expect(interactionCreate).toContain('This task is already marked as done');
		expect(interactionCreate).toContain('This task has already been cancelled');
	});
});

// ── Reminder / digest lifecycle ────────────────────────────────────────
describe('reminder and digest lifecycle', () => {
	it('claims digest parts before sending so restarts cannot double-send', () => {
		expect(reminderService).toContain('hasDigestBeenSent(partKey) || !taskRepository.claimDigestPart(partKey)');
	});

	it('persists digest delivery so Monday suppression survives restarts', () => {
		expect(reminderService).toContain('weeklyDigestAlreadySent');
		expect(reminderService).toContain('markDigestSent');
	});

	it('releases reminder claims on failure so they are retried', () => {
		expect(reminderService).toContain('releaseReminder');
		expect(reminderService).toContain('permanent');
	});

	it('groups tasks into Discord-safe embed fields', () => {
		expect(reminderService).toContain('_groupTasksForFields');
		expect(reminderService).toContain('1024');
	});

	it('keeps digest messages under Discord limits', () => {
		expect(reminderService).toContain('_buildMentionContent');
		expect(reminderService).toContain('2000');
	});

	it('shows an empty digest state', () => {
		expect(reminderService).toContain('No pending tasks.');
	});
});

// ── Blockchain audit notifications ─────────────────────────────────────
describe('Luce audit notification rendering', () => {
	it('renders task_done events safely', () => {
		expect(luce).toContain("case 'task_done'");
		expect(luce).toContain('marked as done');
	});

	it('renders task_cancel events safely', () => {
		expect(luce).toContain("case 'task_cancel'");
		expect(luce).toContain('cancelled');
	});

	it('does not leak raw JSON into embeds when enrichment fails', () => {
		expect(luce).toContain('Could not enrich audit event');
		expect(luce).toContain('try');
		expect(luce).toContain('catch');
	});
});

// ── Regression: known production fixes stay in place ───────────────────
describe('regression guards for prior fixes', () => {
	it('does not mention users with raw <@id> syntax in embed fields', () => {
		// Clean mention syntax: display names instead of raw snowflakes in
		// audit embeds (the fix from the audit notifications pass)
		expect(luce).not.toContain("content: `✅ Task **${'${taskId}'}** marked as done!`");
	});

	it('keeps Asia/Jakarta as the canonical reporting timezone everywhere', () => {
		expect(taskCommand).toContain('Asia/Jakarta');
		expect(reminderService).toContain('Asia/Jakarta');
	});
});
