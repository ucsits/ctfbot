/**
 * Luce Blockchain RPC Client
 * @module luce
 *
 * Communicates with the Luce blockchain server running on the local machine.
 * All POST /blocks calls go through localhostOnly middleware, so the bot must
 * run on the same host as the Luce server.
 */

const LUCE_PORT = process.env.LUCE_PORT || '5500';
const BASE_URL = `http://127.0.0.1:${LUCE_PORT}/api/v1`;

const { EmbedBuilder } = require('discord.js');
const { logger } = require('../logger');
const { REMINDER_CHANNEL_ID } = require('../constants/config');
const luceLog = logger.child('Luce');

/** @type {import('discord.js').Client|null} */
let _discordClient = null;

/**
 * Register the Discord client so block notifications can be sent.
 * Called once during bot startup.
 *
 * @param {import('discord.js').Client} client
 */
function setDiscordClient(client) {
	_discordClient = client;
	luceLog.info('Discord client registered for block notifications');
}

/**
 * Append a new block to the blockchain.
 *
 * @param {object} params
 * @param {number|string} params.author - Discord user ID (block author)
 * @param {string} params.data - Block data (JSON string)
 * @returns {Promise<object>} The created block response
 */
async function appendBlock({ author, data }) {
	luceLog.debug(`Append block (author=${author})`);

	const res = await fetch(`${BASE_URL}/blocks`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ author: Number(author), data })
	});

	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		luceLog.error(`Append failed (${res.status}): ${body.error || res.statusText}`);
		throw new Error(`Blockchain append failed (${res.status}): ${body.error || res.statusText}`);
	}

	const result = await res.json();
	luceLog.info(`Block appended at height ${result.height}`);

	// Fire-and-forget notification to the configured channel
	_notifyBlock(result).catch(err => {
		luceLog.error(`Block notification failed: ${err.message}`);
	});

	return result;
}

/**
 * List all blocks (newest last).
 * @returns {Promise<object[]>}
 */
async function listBlocks() {
	const res = await fetch(`${BASE_URL}/blocks`);
	if (!res.ok) {
		luceLog.error(`List blocks failed (${res.status})`);
		throw new Error(`Blockchain list failed (${res.status})`);
	}
	const blocks = await res.json();
	luceLog.debug(`Listed ${blocks.length} blocks`);
	return blocks;
}

/**
 * Get a single block by height.
 * @param {number} height
 * @returns {Promise<object>}
 */
async function getBlock(height) {
	luceLog.debug(`Get block at height ${height}`);
	const res = await fetch(`${BASE_URL}/blocks/${height}`);
	if (!res.ok) {
		luceLog.error(`Get block at ${height} failed (${res.status})`);
		throw new Error(`Blockchain get failed (${res.status})`);
	}
	return res.json();
}

/**
 * Get current chain height.
 * @returns {Promise<number>}
 */
async function getHeight() {
	const res = await fetch(`${BASE_URL}/chain/height`);
	if (!res.ok) {
		luceLog.error(`Get height failed (${res.status})`);
		throw new Error(`Blockchain height failed (${res.status})`);
	}
	const body = await res.json();
	luceLog.debug(`Chain height: ${body.height}`);
	return body.height;
}

/**
 * Validate the chain.
 * @returns {Promise<boolean>}
 */
async function validateChain() {
	const res = await fetch(`${BASE_URL}/chain/validate`);
	if (!res.ok) {
		luceLog.error(`Validate chain failed (${res.status})`);
		throw new Error(`Blockchain validate failed (${res.status})`);
	}
	const body = await res.json();
	luceLog.info(`Chain valid: ${body.valid}`);
	return body.valid;
}

/**
 * Parse the block's data field and build a notification embed.
 * @param {object} block - The block object returned from the API
 */
function _buildBlockEmbed(block) {
	let parsed;
	try {
		parsed = JSON.parse(block.data);
	} catch {
		parsed = { type: 'unknown' };
	}

	const { type } = parsed;

	// Luce API returns timestamp in seconds; convert to ms for Date()
	const blockDate = new Date((block.timestamp || Math.floor(Date.now() / 1000)) * 1000);

	switch (type) {
		case 'rep': {
			const amount = parsed.amount || 0;
			const sign = amount > 0 ? '⬆️ +1' : '⬇️ -1';
			return new EmbedBuilder()
				.setColor(amount > 0 ? 0x00FF00 : 0xFF0000)
				.setTitle(`${sign} Rep ${amount > 0 ? 'Upvote' : 'Downvote'}`)
				.setDescription(
					`<@${parsed.fromUser}> gave **${sign}** rep to <@${parsed.toUser}>`
				)
				.addFields({ name: 'Block', value: `#${block.height}`, inline: true })
				.setTimestamp(blockDate);
		}
		case 'task':
			return new EmbedBuilder()
				.setColor(0x0099FF)
				.setTitle('📋 Task Created')
				.setDescription(parsed.title || 'Untitled task')
				.addFields(
					{ name: 'Created by', value: `<@${parsed.createdBy}>`, inline: true },
					{ name: 'Assigned to', value: `<@${parsed.assignedTo}>`, inline: true },
					{ name: 'Block', value: `#${block.height}`, inline: true }
				)
				.setTimestamp(blockDate);
		case 'task_done':
			return new EmbedBuilder()
				.setColor(0x00FF00)
				.setTitle('✅ Task Completed')
				.setDescription(`Task \`${parsed.taskId}\` marked as done`)
				.addFields(
					{ name: 'Completed by', value: `<@${parsed.completedBy}>`, inline: true },
					{ name: 'Block', value: `#${block.height}`, inline: true }
				)
				.setTimestamp(blockDate);
		case 'document':
			return new EmbedBuilder()
				.setColor(0xFFAA00)
				.setTitle('📄 Document Anchored')
				.setDescription(parsed.title || 'Untitled document')
				.addFields(
					{ name: 'Author', value: `<@${parsed.author}>`, inline: true },
					{ name: 'Block', value: `#${block.height}`, inline: true }
				)
				.setTimestamp(blockDate);
		default:
			return new EmbedBuilder()
				.setColor(0x808080)
				.setTitle('⛓️ New Block')
				.setDescription(`Block **#${block.height}** appended to the chain`)
				.addFields(
					{ name: 'Author', value: `<@${block.author}>`, inline: true },
					{ name: 'Type', value: type || 'unknown', inline: true }
				)
				.setTimestamp(blockDate);
	}
}

/**
 * Attempt to post a block notification embed to the configured channel.
 * @param {object} block
 */
async function _notifyBlock(block) {
	if (!_discordClient) return;

	const channel = await _discordClient.channels.fetch(REMINDER_CHANNEL_ID).catch(() => null);
	if (!channel?.isTextBased()) return;

	const embed = _buildBlockEmbed(block);

	// Parse block data to build a content string with real mentions
	// (Discord only triggers notifications for mentions in message content,
	// not inside embed fields)
	let content = '';
	try {
		const parsed = JSON.parse(block.data);
		switch (parsed.type) {
			case 'task':
				content = `<@${parsed.createdBy}> assigned a task to <@${parsed.assignedTo}>`;
				break;
			case 'task_done':
				content = `<@${parsed.completedBy}> completed a task`;
				break;
			case 'rep':
				content = `<@${parsed.fromUser}> gave rep to <@${parsed.toUser}>`;
				break;
			case 'document':
				content = `<@${parsed.author}> anchored a document`;
				break;
		}
	} catch {
		// fall through — send embed-only if data can't be parsed
	}

	await channel.send({ content: content || undefined, embeds: [embed] });
}

module.exports = {
	setDiscordClient,
	appendBlock,
	listBlocks,
	getBlock,
	getHeight,
	validateChain
};
