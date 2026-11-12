import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// ── Strategy ───────────────────────────────────────────────────────────
// Same approach as task.lifecycle.source.test.js: this project's modules are
// CommonJS and vitest cannot reliably `vi.mock` CJS `require()` calls here, so
// behavior guarantees are enforced with source-inspection assertions.

const root = process.cwd();
const telegramCommand = readFileSync(join(root, 'src/commands/telegram.js'), 'utf8');

describe('/telegram command', () => {
	it('registers recipient, document, and note options', () => {
		expect(telegramCommand).toContain("setName('recipient')");
		expect(telegramCommand).toContain("setName('document')");
		expect(telegramCommand).toContain("setName('note')");
		expect(telegramCommand).toContain('addUserOption');
		expect(telegramCommand).toContain('addAttachmentOption');
	});

	it('requires the recipient mention and the document file', () => {
		expect(telegramCommand).toContain(
			"setName('recipient').setDescription('User to send the document to').setRequired(true)"
		);
		expect(telegramCommand).toContain(
			"setName('document').setDescription('File to send privately').setRequired(true)"
		);
	});

	it('delivers the file privately via the recipient DM, including a mention', () => {
		expect(telegramCommand).toContain('recipient.send');
		expect(telegramCommand).toContain('files: [fileAttachment]');
		expect(telegramCommand).toContain('recipient.toString()');
	});

	it('sends the delivery confirmation ephemerally to the invoker only', () => {
		expect(telegramCommand).toContain('deferReply({ ephemeral: true })');
		expect(telegramCommand).toContain('interaction.editReply');
		expect(telegramCommand).toContain('Sent privately to');
	});

	it('rejects oversized attachments before any send', () => {
		expect(telegramCommand).toContain('MAX_FILE_SIZE');
		expect(telegramCommand).toContain('attachment.size > MAX_FILE_SIZE');
		expect(telegramCommand).toContain('File too large. Maximum allowed size is');
	});

	it('surfaces blocked/disabled-DM failures with a clear message', () => {
		expect(telegramCommand).toContain('50007');
		expect(telegramCommand).toContain('50013');
		expect(telegramCommand).toContain('They may have DMs disabled or have blocked the bot.');
	});

	it('does not broadcast the file into the channel as a public message', () => {
		expect(telegramCommand).not.toContain('channel.send');
		expect(telegramCommand).not.toContain('allowedMentions: { parse: [] }');
	});
});
