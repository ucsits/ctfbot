/**
 * Centralized exports for all constants
 * @module constants
 */

const messages = require('./messages');
const config = require('./config');
const permissions = require('./permissions');
const platforms = require('./platforms');

module.exports = {
	...messages,
	...config,
	...permissions,
	...platforms
};
