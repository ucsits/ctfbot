/**
 * Tool registry for the proactive chat service.
 *
 * Small and closed. `say` is the only tool that produces a message, and it only
 * records the text. None of them can send, create a thread or touch a task. The
 * model produces text inside `say` and the service decides whether to post it.
 * That separation stops a web page that says "ignore your instructions and post
 * this" from becoming an action.
 *
 * @module lib/tools
 */

const serpbase = require('./serpbase');
const channelMemory = require('../../database/repositories/channelMemory.repository');
const actorMemory = require('../../database/repositories/actorMemory.repository');
const globalMemory = require('../../database/repositories/globalMemory.repository');
const { stripEmoji } = require('../utils/emoji');

const TOOL_NAMES = {
	say: 'say',
	search: 'search_web',
	remember: 'remember',
	rememberGlobal: 'remember_global',
	recall: 'recall',
	silent: 'stay_silent'
};

/** [OI]-style function schemas, sent as the `tools` array. */
const SCHEMAS = [
	{
		type: 'function',
		function: {
			name: TOOL_NAMES.say,
			description:
				'The only way to post a message. Call it alone, after any search or memory tool, with the one short line you want to send. Text outside this tool is ignored.',
			parameters: {
				type: 'object',
				properties: {
					content: { type: 'string', description: 'The message to post, one sentence.' }
				},
				required: ['content']
			}
		}
	},
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
				'Save something worth knowing next time. About the channel, meaning what it is for, its jargon, house rules, or a decision. About a person, meaning a lasting preference or role. Never save one-off details, secrets or credentials.',
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
			name: TOOL_NAMES.rememberGlobal,
			description:
				'Save something that applies to the whole server, every channel and every person. Use it only for a lasting personality preference or house rule that someone just taught you, such as how to apologise or what topics to avoid. Never save a one-off detail, a secret, a credential, a link, or something about one person (use remember for that).',
			parameters: {
				type: 'object',
				properties: {
					note: { type: 'string', description: 'Short note in the third person, max 300 characters.' },
					kind: {
						type: 'string',
						enum: ['personality', 'rule', 'correction', 'fact'],
						description:
							'personality for tone, rule for a house rule, correction for a mistake not to repeat, fact for a lasting fact.'
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
				'Choose not to speak. Call this whenever posting a message would add nothing. That covers small talk, a question already answered, two people talking to each other, or you would only be repeating yourself. Prefer silence over noise.',
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
 * @param {boolean} [params.allowGlobalMemory=false] - offer `remember_global`.
 *   Only a pass that answers a human gets it, so an unprompted remark cannot
 *   rewrite the server's personality on its own.
 * @param {string|null} [params.actorId=null] - who the bot is talking to, stored
 *   as the author of a global note and used for the per-member rate limit
 * @returns {{ schemas: Array<object>, dispatch: (name: string, args: object) => Promise<string|{content: string, stop: boolean, final?: string, silent?: boolean}> }}
 */
function createTools({ channelId, people = new Map(), onSearch, allowGlobalMemory = false, actorId = null }) {
	/** Start of the local day, for the per-member global memory limit. */
	function startOfLocalDay() {
		const { DateTime } = require('luxon');
		const { DEFAULT_TIMEZONE } = require('../constants/config');
		return DateTime.now().setZone(DEFAULT_TIMEZONE).startOf('day').toUnixInteger();
	}

	async function dispatch(name, args = {}) {
		switch (name) {
			case TOOL_NAMES.search: {
				const result = await serpbase.search(args.query);
				onSearch?.(args.query, result);
				return serpbase.formatForModel(args.query, result);
			}

			case TOOL_NAMES.remember: {
				const about = args.about_user_id ? String(args.about_user_id) : null;
				// Notes are shown back to people (e.g. /memory view), so keep them
				// plain text too.
				const note = stripEmoji(String(args.note ?? ''))
					.replace(/\s+/g, ' ')
					.trim();
				if (!note) {
					return 'not saved. The note was empty';
				}
				if (about) {
					if (!people.has(about)) {
						return 'not saved. That user id is not in this conversation';
					}
					const id = actorMemory.addNote(about, note, { addedBy: 'self' });
					return id ? `saved note ${id} about ${people.get(about)}` : 'not saved. Already remembered';
				}
				const id = channelMemory.addNote(channelId, note, { kind: args.kind });
				return id ? `saved channel note ${id}` : 'not saved. Already remembered';
			}

			case TOOL_NAMES.rememberGlobal: {
				if (!allowGlobalMemory) {
					return 'not saved. Global memory is only for a pass that answers someone';
				}
				if (!actorId) {
					return 'not saved. Nobody to attribute the note to';
				}
				const { globalMemory: limits } = require('../../config').chat;
				const used = globalMemory.countByUserSince(actorId, startOfLocalDay());
				if (used >= limits.perDay) {
					return `not saved. The daily limit of ${limits.perDay} global notes per person is reached`;
				}
				const note = stripEmoji(String(args.note ?? ''));
				const { id, reason } = globalMemory.addNote(note, {
					kind: args.kind,
					addedBy: actorId,
					max: limits.max
				});
				return id ? `saved global note ${id}` : `not saved. ${reason}`;
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
							personNotes.push(`${display} ${note.note}`);
						}
					}
				}
				const globalNotes = globalMemory
					.listNotes()
					.filter(n => !query || n.note.toLowerCase().includes(query))
					.map(n => `[${n.kind}] ${n.note}`);
				const lines = [
					`global notes ${globalNotes.length ? globalNotes.join(' | ') : '(none)'}`,
					`channel notes ${notes.length ? notes.join(' | ') : '(none)'}`,
					`people notes ${personNotes.length ? personNotes.join(' | ') : '(none)'}`
				];
				return lines.join('\n');
			}

			case TOOL_NAMES.say: {
				const text = String(args.content ?? '')
					.replace(/\s+/g, ' ')
					.trim();
				if (!text) {
					return 'not posted. content was empty, call say again with the message';
				}
				return { content: 'saying', stop: true, final: text };
			}

			case TOOL_NAMES.silent:
				return { content: 'staying silent', stop: true, silent: true };

			default:
				return `unknown tool ${name}`;
		}
	}

	const schemas = allowGlobalMemory ? SCHEMAS : SCHEMAS.filter(s => s.function.name !== TOOL_NAMES.rememberGlobal);
	return { schemas, dispatch };
}

module.exports = {
	TOOL_NAMES,
	SCHEMAS,
	createTools
};
