import { beforeAll, afterAll } from 'vitest';
import { Database } from 'better-sqlite3';
import path from 'path';

beforeAll(() => {
	process.env.NODE_ENV = 'test';
	process.env.CTF_CATEGORY_ID = 'test-category-id';
	process.env.GUILD_ID = 'test-guild-id';
	process.env.DISCORD_TOKEN = 'test-token';
});

afterAll(() => {
	const testDbPath = path.join(__dirname, '..', 'ctfbot.db');
	try {
		const fs = require('fs');
		if (fs.existsSync(testDbPath)) {
			fs.unlinkSync(testDbPath);
		}
	} catch (error) {
	}
});
