import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// ── Strategy ───────────────────────────────────────────────────────────
// /createctf ran four side effects with no compensation: create the channel,
// create the scheduled event, post the welcome message, then write the CTF row.
// saveToDatabase swallowed its error and the command still reported
// "CTF Created Successfully", so a failure left a channel and event behind with
// no database row.
//
// Separately, formatDateInterpretation was called in sendWelcomeMessage and
// sendConfirmation but never imported, so the command threw a ReferenceError
// after the channel and event already existed. That is the confirmed cause of
// the reported "errors out and completes partially" incident.
//
// These are source-level assertions because the behaviour is a saga ordering
// contract, not a pure function. The atomicity of the underlying repositories is
// covered by their own integration tests.

const root = process.cwd();
const createCtf = readFileSync(join(root, 'src/commands/createctf.js'), 'utf8');
const archiveCtf = readFileSync(join(root, 'src/commands/archivectf.js'), 'utf8');

describe('createctf helper imports', () => {
	it('imports formatDateInterpretation, which it calls twice', () => {
		// The regression: two call sites, no import.
		const utilsImport = createCtf
			.split('\n')
			.find(line => line.includes("require('../lib/utils')"));

		expect(utilsImport).toBeTruthy();
		expect(utilsImport).toContain('formatDateInterpretation');
		expect(createCtf).toContain('formatDateInterpretation(options.dateStr');
	});

	it('resolves the imported helper to a real function', async () => {
		// Guards against the import being present but the export being missing.
		const utils = await import('../../src/lib/utils/index.js');
		const helper = utils.formatDateInterpretation || utils.default?.formatDateInterpretation;
		expect(typeof helper).toBe('function');
	});
});

describe('createctf compensation', () => {
	it('does not swallow the database error', () => {
		const save = createCtf.slice(
			createCtf.indexOf('async saveToDatabase'),
			createCtf.indexOf('\n\tsendConfirmation(')
		);
		expect(save).toContain('ctfOperations.createCTF');
		// No catch that turns the failure into a warning.
		expect(save).not.toContain('catch (dbError)');
		expect(save).not.toContain('Warning: CTF was created but failed to register');
	});

	it('rolls back the event and the channel before reporting failure', () => {
		const run = createCtf.slice(
			createCtf.indexOf('async chatInputRun'),
			createCtf.indexOf('async _compensateCreate')
		);

		// Success reply is only reached after the persist step.
		const saveAt = run.indexOf('await this.saveToDatabase(');
		const confirmAt = run.indexOf('return this.sendConfirmation(');
		expect(saveAt).toBeGreaterThan(-1);
		expect(confirmAt).toBeGreaterThan(-1);
		expect(saveAt).toBeLessThan(confirmAt);

		// The catch compensates instead of reporting success.
		expect(run).toContain('await this._compensateCreate(interaction, ctfChannel, scheduledEvent);');
		const catchAt = run.indexOf('} catch (error) {');
		expect(run.indexOf('_compensateCreate')).toBeGreaterThan(catchAt);

		// Compensation deletes both Discord objects.
		const compensate = createCtf.slice(createCtf.indexOf('async _compensateCreate'));
		expect(compensate).toContain('scheduledEvents.delete(scheduledEvent.id)');
		expect(compensate).toContain('ctfChannel.delete(');
	});

	it('captures the created objects so they can be rolled back', () => {
		const run = createCtf.slice(
			createCtf.indexOf('async chatInputRun'),
			createCtf.indexOf('async _compensateCreate')
		);
		expect(run).toContain('let ctfChannel = null;');
		expect(run).toContain('let scheduledEvent = null;');
		expect(run).toContain('ctfChannel = await this.createChannel(');
		expect(run).toContain('scheduledEvent = await this.createEvent(');
	});
});

describe('archivectf compensation', () => {
	it('captures the original parent and restores it when the DB update throws', () => {
		const parentAt = archiveCtf.indexOf('const originalParentId = channel.parentId;');
		const setParentAt = archiveCtf.indexOf('await channel.setParent(archiveCategory.id');
		const archiveAt = archiveCtf.indexOf('ctfOperations.archiveCTF(channel.id);');

		expect(parentAt).toBeGreaterThan(-1);
		expect(parentAt).toBeLessThan(setParentAt);
		expect(setParentAt).toBeLessThan(archiveAt);

		// The DB write is guarded and the restore runs in its catch.
		expect(archiveCtf).toContain('catch (dbError)');
		const restoreAt = archiveCtf.indexOf('await channel.setParent(originalParentId');
		expect(restoreAt).toBeGreaterThan(archiveAt);
		expect(archiveCtf).toContain('restoring original category');
	});
});
