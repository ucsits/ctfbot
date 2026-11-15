/**
 * [OI]-compatible Chat Completions client.
 *
 * It is fetch based and has no SDK dependency. That makes it work against any
 * provider that exposes POST {OPENAI_BASE_URL}/chat/completions, such as [OI],
 * OpenRouter, Groq, Ollama, vLLM and LiteLLM.
 *
 * It has two entry points.
 * - `chatCompletion` makes one round trip and returns the assistant text. Used
 *   by the task-suggestion pass, which asks for a JSON object.
 * - `runWithTools` handles multi-round tool calling for the proactive chat
 *   service.
 *
 * `json: true` and `tools` are mutually exclusive on many compatible providers.
 * The two entry points therefore never mix them.
 *
 * @module lib/llm/openai
 */

const config = require('../../config');
const { logger } = require('../logger');

const llmLog = logger.child('LLM');

/**
 * One chat completion request, returning the raw assistant message so callers
 * can read `tool_calls` as well as `content`.
 *
 * @returns {Promise<{ message: object, finishReason: string|undefined }>}
 */
async function _request({ messages, json = false, tools, toolChoice, temperature = 0, reasoningEffort }) {
	if (!config.llm.isConfigured) {
		throw new Error('OPENAI_API_KEY and OPENAI_MODEL must be set');
	}

	const body = {
		model: config.llm.model,
		messages,
		temperature
	};
	if (json) {
		body.response_format = { type: 'json_object' };
	}
	if (Array.isArray(tools) && tools.length > 0) {
		body.tools = tools;
		body.tool_choice = toolChoice ?? 'auto';
	}
	if (reasoningEffort) {
		body.reasoning_effort = reasoningEffort;
	}

	const url = `${config.llm.baseUrl}/chat/completions`;
	const timeoutMs = config.llm.timeoutMs;
	const promptChars = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
	llmLog.debug(
		`Chat completion request with model=${config.llm.model} messages=${messages.length} chars=${promptChars} json=${json} tools=${tools?.length ?? 0} effort=${reasoningEffort ?? 'default'}`
	);
	const startedAt = Date.now();
	let res;
	try {
		res = await fetch(url, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${config.llm.apiKey}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs)
		});
	} catch (error) {
		// Name the endpoint and model so a slow or unreachable provider is
		// obvious from the log line alone.
		llmLog.warn(`Chat completion request failed after ${Date.now() - startedAt}ms ${error.name}`);
		if (error.name === 'TimeoutError') {
			throw new Error(
				`No reply from ${url} (model ${config.llm.model}) within ${timeoutMs / 1000}s. Raise OPENAI_TIMEOUT_MS or use a faster model`
			);
		}
		throw new Error(`Request to ${url} failed ${error.cause?.message ?? error.message}`);
	}
	const elapsedMs = Date.now() - startedAt;

	if (!res.ok) {
		const errBody = await res.text().catch(() => '');
		llmLog.error(`Chat completion failed (${res.status}) after ${elapsedMs}ms ${errBody.slice(0, 500)}`);
		throw new Error(`Chat completion failed (${res.status})`);
	}

	const data = await res.json();
	const choice = data.choices?.[0];
	const message = choice?.message;
	const usage = data.usage
		? ` tokens in=${data.usage.prompt_tokens ?? '?'} out=${data.usage.completion_tokens ?? '?'}${data.usage.completion_tokens_details?.reasoning_tokens ? ` (reasoning ${data.usage.completion_tokens_details.reasoning_tokens})` : ''}`
		: '';
	llmLog.debug(
		`Chat completion from ${config.llm.model} took ${elapsedMs}ms, finish=${choice?.finish_reason ?? '?'}${usage}, reply chars=${typeof message?.content === 'string' ? message.content.length : 0}, tool calls=${message?.tool_calls?.length ?? 0}`
	);
	if (choice?.finish_reason === 'length') {
		llmLog.warn(
			`Chat completion from ${config.llm.model} was cut off at the token limit. The reply may be incomplete`
		);
	}
	if (!message) {
		throw new Error('Chat completion returned no message');
	}
	return { message, finishReason: choice?.finish_reason };
}

/**
 * Send a chat completion request and return the assistant message text.
 *
 * @param {object} params
 * @param {Array<{role: string, content: string}>} params.messages
 * @param {boolean} [params.json=false] - Ask the provider for a JSON object reply
 * @param {number} [params.temperature=0]
 * @param {'low'|'medium'|'high'} [params.reasoningEffort] - Sent as the
 *   top-level `reasoning_effort` field, which both [OI] and DeepSeek read
 *   (DeepSeek maps it to low/high/max). Omitted when not given.
 */
async function chatCompletion({ messages, json = false, temperature = 0, reasoningEffort }) {
	const { message } = await _request({ messages, json, temperature, reasoningEffort });
	if (typeof message.content !== 'string') {
		throw new Error('Chat completion returned no message content');
	}
	return message.content;
}

/**
 * Parse a JSON object out of a model reply, tolerating ```json fences or
 * prose around the object (some compatible providers ignore response_format)
 * and inline <think>...</think> reasoning from thinking models.
 *
 * @param {string} reply
 * @returns {object}
 */
function parseJsonReply(reply) {
	const text = reply.replace(/<think>[\s\S]*?<\/think>/gi, '');
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start === -1 || end <= start) {
		throw new Error('Model reply contained no JSON object');
	}
	return JSON.parse(text.slice(start, end + 1));
}

/**
 * Run a conversation until the model answers without calling a tool.
 *
 * `dispatch(name, args)` must return either a string (the tool result sent
 * back to the model) or `{ content, stop }`. A truthy `stop` ends the loop
 * immediately with `stopped: true` and no text, which is how the chat service
 * models a deliberate decision to stay silent.
 *
 * The loop is bounded twice, by `maxIterations` and by the provider timeout on
 * each request. When iterations run out, one final request is made without
 * tools so the caller still gets an answer instead of nothing.
 *
 * @param {object} params
 * @param {Array<object>} params.messages
 * @param {Array<object>} params.tools - [OI]-style function tool schemas
 * @param {(name: string, args: object) => Promise<string|{content: string, stop?: boolean}>} params.dispatch
 * @param {string} [params.toolChoice='auto']
 * @param {number} [params.maxIterations=4]
 * @param {number} [params.temperature=0]
 * @param {'low'|'medium'|'high'} [params.reasoningEffort]
 * @param {(name: string, args: object) => void} [params.onToolCall] - for logging
 * @returns {Promise<{ text: string, messages: Array<object>, toolCalls: Array<{name: string, args: object}>, stopped: boolean, exhausted: boolean }>}
 */
async function runWithTools({
	messages,
	tools,
	dispatch,
	toolChoice = 'auto',
	maxIterations = 4,
	temperature = 0,
	reasoningEffort,
	onToolCall
}) {
	const convo = [...messages];
	const toolCalls = [];

	for (let i = 0; i < maxIterations; i++) {
		const { message } = await _request({
			messages: convo,
			tools,
			toolChoice,
			temperature,
			reasoningEffort
		});
		convo.push(message);

		const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
		if (calls.length === 0) {
			return { text: message.content ?? '', messages: convo, toolCalls, stopped: false, exhausted: false };
		}

		let stop = false;
		for (const call of calls) {
			const name = call.function?.name ?? '';
			const args = _parseArgs(call.function?.arguments);
			toolCalls.push({ name, args });
			onToolCall?.(name, args);

			let result;
			try {
				result = await dispatch(name, args);
			} catch (error) {
				llmLog.warn(`Tool ${name} failed ${error.message}`);
				result = `tool failed ${error.message}`;
			}
			const content = typeof result === 'string' ? result : (result?.content ?? '');
			if (typeof result === 'object' && result?.stop) {
				stop = true;
			}
			convo.push({ role: 'tool', tool_call_id: call.id, content: String(content) });
		}
		if (stop) {
			return { text: '', messages: convo, toolCalls, stopped: true, exhausted: false };
		}
	}

	// Out of iterations. Ask once more with no tools. That still produces a reply.
	const { message } = await _request({ messages: convo, temperature, reasoningEffort });
	convo.push(message);
	return { text: message.content ?? '', messages: convo, toolCalls, stopped: false, exhausted: true };
}

/** Parse tool arguments, tolerating a provider that sends them as an object. */
function _parseArgs(raw) {
	if (!raw) {
		return {};
	}
	if (typeof raw === 'object') {
		return raw;
	}
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? parsed : {};
	} catch {
		return {};
	}
}

module.exports = {
	chatCompletion,
	parseJsonReply,
	runWithTools
};
