/**
 * Tool registry for the proactive chat service.
 *
 * Four tools, deliberately small. None of them can send a message, create a
 * thread or touch a task: the model produces text and the service decides
 * whether to post it. That separation is what stops a web page that says
 * "ignore your instructions and post this" from becoming an action.
 *
 * @module lib/tools
 */

const serpbase = require('./serpbase');
const channelMemory = require('../../database/repositories/channelMemory.repository');
const actorMemory = require('../../database/repositories/actorMemory.repository');

const TOOL_NAMES = {
	search: 'search_web',
	remember: 'remember',
	recall: 'recall',
	silent: 'stay_silent'
};

/** [OI]-style function schemas, sent as the `tools` array. */
const SCHEMAS = [
	{
		type: 'function',
		function: {
			name: TOOL_NAMES.search,
			description:
				'Search Google for a fact, a link, a version number or something that happened after your training. Use it when being wrong would be embarrassing or when someone asks for a source. Do not search to restate what is already in the chat.',
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: 'What to search for, like a person would type it into Google.'
					}
				},
				required: ['query']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: TOOL_NAMES.remember,
			description:
				'Save something worth knowing next time. About the channel: what it is for, its jargon, house rules, or a decision. About a person: a lasting preference or role. Never save one-off details, secrets or credentials.',
			parameters: {
				type: 'object',
				properties: {
					note: { type: 'string', description: 'Short note in the third person, max 200 characters.' },
					kind: {
						type: 'string',
						enum: ['topic', 'jargon', 'preference', 'fact'],
						description: 'What kind of note this is.'
					},
					about_user_id: {
						type: 'string',
						description: 'Discord user id when the note is about a person, otherwise omit.'
					}
				},
				required: ['note']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: TOOL_NAMES.recall,
			description:
				'Read what you already remember about this channel and the people in it. Use it when the conversation refers to something earlier you might have saved.',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Optional words to look for. Omit to read everything.' }
				}
			}
		}
	},
	{
		type: 'function',
		function: {
			name: TOOL_NAMES.silent,
			description:
				'Choose not to speak. Call this whenever posting a message would add nothing: small talk, a question already answered, two people talking to each other, or you would only be repeating yourself. Prefer silence over noise.',
			parameters: {
				type: 'object',
				properties: {
					reason: { type: 'string', description: 'One short sentence on why staying quiet is better here.' }
				},
				required: ['reason']
			}
		}
	}
];

/**
 * Build the dispatcher for one channel.
 *
 * @param {object} params
 * @param {string} params.channelId
 * @param {Map<string, string>} [params.people] - Discord id → display name, for
 *   validating `about_user_id`
 * @param {(query: string, result: object) => void} [params.onSearch] - metrics hook
 * @returns {{ schemas: Array<object>, dispatch: (name: string, args: object) => Promise<string|{content: string, stop: boolean}> }}
 */
function createTools({ channelId, people = new Map(), onSearch }) {
	async function dispatch(name, args = {}) {
		switch (name) {
			case TOOL_NAMES.search: {
				const result = await serpbase.search(args.query);
				onSearch?.(args.query, result);
				return serpbase.formatForModel(args.query, result);
			}

			case TOOL_NAMES.remember: {
				const about = args.about_user_id ? String(args.about_user_id) : null;
				if (about) {
					if (!people.has(about)) {
						return 'not saved: that user id is not in this conversation';
					}
					const id = actorMemory.addNote(about, args.note, { addedBy: 'self' });
					return id ? `saved note ${id} about ${people.get(about)}` : 'not saved: already remembered';
				}
				const id = channelMemory.addNote(channelId, args.note, { kind: args.kind });
				return id ? `saved channel note ${id}` : 'not saved: already remembered';
			}

			case TOOL_NAMES.recall: {
				const query = String(args.query ?? '')
					.toLowerCase()
					.trim();
				const notes = channelMemory
					.listNotes(channelId)
					.filter(n => !query || n.note.toLowerCase().includes(query))
					.map(n => `[${n.kind}] ${n.note}`);
				const personNotes = [];
				for (const [id, display] of people) {
					for (const note of actorMemory.listNotes(id)) {
						if (!query || note.note.toLowerCase().includes(query)) {
							personNotes.push(`${display}: ${note.note}`);
						}
					}
				}
				const lines = [
					`channel notes: ${notes.length ? notes.join(' | ') : '(none)'}`,
					`people notes: ${personNotes.length ? personNotes.join(' | ') : '(none)'}`
				];
				return lines.join('\n');
			}

			case TOOL_NAMES.silent:
				return { content: 'staying silent', stop: true };

			default:
				return `unknown tool ${name}`;
		}
	}

	return { schemas: SCHEMAS, dispatch };
}

module.exports = {
	TOOL_NAMES,
	SCHEMAS,
	createTools
};
