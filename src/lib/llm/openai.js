/**
 * OpenAI-compatible Chat Completions client.
 *
 * Fetch-based (no SDK dependency) so it works against any provider exposing
 * POST {OPENAI_BASE_URL}/chat/completions — OpenAI, OpenRouter, Groq, Ollama,
 * vLLM, LiteLLM and similar.
 *
 * @module lib/llm/openai
 */

const config = require('../../config');
const { logger } = require('../logger');

const llmLog = logger.child('LLM');

/**
 * Send a chat completion request and return the assistant message text.
 *
 * @param {object} params
 * @param {Array<{role: string, content: string}>} params.messages
 * @param {boolean} [params.json=false] - Ask the provider for a JSON object reply
 * @param {number} [params.temperature=0]
 * @param {'low'|'medium'|'high'} [params.reasoningEffort] - Sent as the
 *   top-level `reasoning_effort` field, which both OpenAI and DeepSeek read
 *   (DeepSeek maps it to low/high/max); omitted when not given
 */
async function chatCompletion({ messages, json = false, temperature = 0, reasoningEffort }) {
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
	if (reasoningEffort) {
		body.reasoning_effort = reasoningEffort;
	}

	const url = `${config.llm.baseUrl}/chat/completions`;
	const timeoutMs = config.llm.timeoutMs;
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
		if (error.name === 'TimeoutError') {
			throw new Error(
				`No reply from ${url} (model ${config.llm.model}) within ${timeoutMs / 1000}s; raise OPENAI_TIMEOUT_MS or use a faster model`
			);
		}
		throw new Error(`Request to ${url} failed: ${error.cause?.message ?? error.message}`);
	}
	llmLog.debug(`Chat completion from ${config.llm.model} took ${Date.now() - startedAt}ms`);

	if (!res.ok) {
		const errBody = await res.text().catch(() => '');
		llmLog.error(`Chat completion failed (${res.status}): ${errBody.slice(0, 500)}`);
		throw new Error(`Chat completion failed (${res.status})`);
	}

	const data = await res.json();
	const content = data.choices?.[0]?.message?.content;
	if (typeof content !== 'string') {
		throw new Error('Chat completion returned no message content');
	}
	return content;
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

module.exports = {
	chatCompletion,
	parseJsonReply
};
