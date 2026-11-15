import { describe, it, expect, vi, beforeEach } from 'vitest';

const originalEnv = { ...process.env };

let llm;

beforeEach(async () => {
	vi.resetModules();
	process.env = { ...originalEnv };
	process.env.OPENAI_API_KEY = 'sk-test';
	process.env.OPENAI_MODEL = 'test-model';
	process.env.OPENAI_BASE_URL = 'https://example.test/v1';
	llm = await import('../../src/lib/llm/openai.js');
});

const reply = message => ({
	ok: true,
	json: () => Promise.resolve({ choices: [{ message, finish_reason: 'stop' }] })
});

const text = content => reply({ role: 'assistant', content });
const toolCall = (name, args, id = 'call-1') =>
	reply({
		role: 'assistant',
		content: null,
		tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
	});

const tools = [{ type: 'function', function: { name: 'ping', parameters: { type: 'object', properties: {} } } }];

describe('runWithTools', () => {
	it('answers straight away when the model calls no tool', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(text('halo'));
		const result = await llm.runWithTools({
			messages: [{ role: 'user', content: 'hi' }],
			tools,
			dispatch: vi.fn()
		});
		expect(result.text).toBe('halo');
		expect(result.toolCalls).toEqual([]);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it('executes a tool, feeds the result back and returns the final answer', async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValueOnce(toolCall('ping', { q: 'x' }))
			.mockResolvedValueOnce(text('selesai'));
		const dispatch = vi.fn().mockResolvedValue('pong');

		const result = await llm.runWithTools({ messages: [{ role: 'user', content: 'hi' }], tools, dispatch });

		expect(dispatch).toHaveBeenCalledWith('ping', { q: 'x' });
		expect(result.text).toBe('selesai');
		expect(result.toolCalls).toEqual([{ name: 'ping', args: { q: 'x' } }]);

		// The second request carries the assistant tool call and the tool result.
		const secondBody = JSON.parse(globalThis.fetch.mock.calls[1][1].body);
		const roles = secondBody.messages.map(m => m.role);
		expect(roles).toEqual(['user', 'assistant', 'tool']);
		expect(secondBody.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'call-1', content: 'pong' });
	});

	it('stops as soon as a tool asks to stop, without a second model call', async () => {
		globalThis.fetch = vi.fn().mockResolvedValueOnce(toolCall('stay_silent', { reason: 'nothing to add' }));
		const dispatch = vi.fn().mockResolvedValue({ content: 'ok', stop: true });

		const result = await llm.runWithTools({ messages: [{ role: 'user', content: 'hi' }], tools, dispatch });

		expect(result.stopped).toBe(true);
		expect(result.text).toBe('');
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it('turns a throwing tool into an error result the model can read', async () => {
		globalThis.fetch = vi.fn().mockResolvedValueOnce(toolCall('ping', {})).mockResolvedValueOnce(text('ok'));
		const dispatch = vi.fn().mockRejectedValue(new Error('kaput'));

		const result = await llm.runWithTools({ messages: [{ role: 'user', content: 'hi' }], tools, dispatch });

		const secondBody = JSON.parse(globalThis.fetch.mock.calls[1][1].body);
		expect(secondBody.messages.at(-1).content).toContain('kaput');
		expect(result.text).toBe('ok');
	});

	it('asks for a final answer without tools when the iteration limit is hit', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(toolCall('ping', {}));
		globalThis.fetch
			.mockResolvedValueOnce(toolCall('ping', {}))
			.mockResolvedValueOnce(toolCall('ping', {}))
			.mockResolvedValueOnce(text('akhirnya'));

		const result = await llm.runWithTools({
			messages: [{ role: 'user', content: 'hi' }],
			tools,
			dispatch: vi.fn().mockResolvedValue('pong'),
			maxIterations: 2
		});

		expect(result.exhausted).toBe(true);
		expect(result.text).toBe('akhirnya');
		const lastBody = JSON.parse(globalThis.fetch.mock.calls.at(-1)[1].body);
		expect(lastBody.tools).toBeUndefined();
	});

	it('sends the tools and tool_choice on requests that offer tools', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(text('halo'));
		await llm.runWithTools({ messages: [{ role: 'user', content: 'hi' }], tools, dispatch: vi.fn() });
		const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
		expect(body.tools).toEqual(tools);
		expect(body.tool_choice).toBe('auto');
		expect(body.response_format).toBeUndefined();
	});
});

describe('chatCompletion', () => {
	it('still returns plain text and never sends tools', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(text('{"proposals":[]}'));
		const out = await llm.chatCompletion({ messages: [{ role: 'user', content: 'hi' }], json: true });
		expect(out).toBe('{"proposals":[]}');
		const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
		expect(body.response_format).toEqual({ type: 'json_object' });
		expect(body.tools).toBeUndefined();
	});

	it('throws when the provider returns no content', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(reply({ role: 'assistant', content: null }));
		await expect(llm.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
			'no message content'
		);
	});
});
