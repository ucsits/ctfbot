/**
 * Emoji stripping for user-facing text
 * @module utils/emoji
 */

// Keycap sequences ("1️⃣", "#️⃣") have to go before the single-character pass,
// otherwise the digit survives and only the marks are removed.
const KEYCAP = /[0-9#*]\uFE0F?\u20E3/gu;

// Discord custom emoji markup, e.g. <:blob:123> or <a:party:456>. Mentions
// (<@123>, <#123>) and timestamps (<t:123:F>) do not match.
const CUSTOM_EMOJI = /<a?:[A-Za-z0-9_~]+:\d+>/g;

// A single emoji "atom": pictographs, emoji presentation characters, the
// variation selectors, joiners, keycap mark and skin tone modifiers that glue
// a sequence together, and the regional indicators used for flags. The
// variation selector and zero-width joiner are intentional here, they are what
// a joined sequence is made of.
// eslint-disable-next-line no-misleading-character-class
const EMOJI_ATOM = new RegExp(
	'[\\p{Emoji_Presentation}\\p{Extended_Pictographic}\\p{Emoji_Modifier}\\uFE0E\\uFE0F\\u200D\\u20E3\\u{1F1E6}-\\u{1F1FF}]',
	'gu'
);

/**
 * Remove emojis from text before it reaches a Discord message.
 *
 * Handles Unicode emoji (including ZWJ sequences, flags, keycaps and skin
 * tones) and Discord custom emoji markup. An emoji is replaced with a space
 * so words on either side stay apart, then the leftover whitespace is tidied.
 *
 * @param {string} text
 * @returns {string}
 */
function stripEmoji(text) {
	if (typeof text !== 'string' || !text) {
		return typeof text === 'string' ? text : '';
	}
	return text
		.replace(CUSTOM_EMOJI, ' ')
		.replace(KEYCAP, ' ')
		.replace(EMOJI_ATOM, ' ')
		.replace(/[ \t]{2,}/g, ' ')
		.replace(/[ \t]+$/gm, '')
		.replace(/^[ \t]+/gm, '')
		.replace(/ +([,.!?;:])/g, '$1')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

module.exports = { stripEmoji };
