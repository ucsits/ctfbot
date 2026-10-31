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

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Send a chat completion request and return the assistant message text.
 *
 * @param {object} params
 * @param {Array<{role: string, content: string}>} params.messages
 * @param {boolean} [params.json=false] - Ask the provider for a JSON object reply
 * @param {number} [params.temperature=0]
 * @returns {Promise<string>}
 */
async function chatCompletion({ messages, json = false, temperature = 0 }) {
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

	const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${config.llm.apiKey}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
	});

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
 * prose around the object (some compatible providers ignore response_format).
 *
 * @param {string} text
 * @returns {object}
 */
function parseJsonReply(text) {
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
