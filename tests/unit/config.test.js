import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import config from '../../src/config/index.js';

describe('Config Module', () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	describe('validate', () => {
		it('should not throw when all required env vars are set', () => {
			process.env.DISCORD_TOKEN = 'test-token';
			process.env.CTF_CATEGORY_ID = 'test-category';

			expect(() => config.validate()).not.toThrow();
		});

		it('should throw when DISCORD_TOKEN is missing', () => {
			process.env.DISCORD_TOKEN = undefined;
			process.env.CTF_CATEGORY_ID = 'test-category';

			expect(() => config.validate()).toThrow('Missing required environment variables');
		});

		it('should throw when CTF_CATEGORY_ID is missing', () => {
			process.env.DISCORD_TOKEN = 'test-token';
			process.env.CTF_CATEGORY_ID = undefined;

			expect(() => config.validate()).toThrow('Missing required environment variables');
		});
	});

	describe('discord', () => {
		it('should return discord token when set', () => {
			process.env.DISCORD_TOKEN = 'test-token';
			expect(config.discord.token).toBe('test-token');
		});

		it('should throw error when token is not set', () => {
			process.env.DISCORD_TOKEN = undefined;
			expect(() => config.discord.token).toThrow('DISCORD_TOKEN environment variable is not set');
		});

		it('should return guildId when set', () => {
			process.env.GUILD_ID = 'test-guild';
			expect(config.discord.guildId).toBe('test-guild');
		});

		it('should return null when guildId is not set', () => {
			process.env.GUILD_ID = undefined;
			expect(config.discord.guildId).toBeNull();
		});
	});

	describe('ctf', () => {
		it('should return categoryId when set', () => {
			process.env.CTF_CATEGORY_ID = 'test-category';
			expect(config.ctf.categoryId).toBe('test-category');
		});

		it('should throw error when categoryId is not set', () => {
			process.env.CTF_CATEGORY_ID = undefined;
			expect(() => config.ctf.categoryId).toThrow('CTF_CATEGORY_ID environment variable is not set');
		});
	});

	describe('node', () => {
		it('should default to development when NODE_ENV is not set', () => {
			process.env.NODE_ENV = undefined;
			expect(config.node.env).toBe('development');
		});

		it('should return NODE_ENV when set', () => {
			process.env.NODE_ENV = 'test';
			expect(config.node.env).toBe('test');
		});

		it('should return isTest correctly', () => {
			process.env.NODE_ENV = 'test';
			expect(config.node.isTest).toBe(true);

			process.env.NODE_ENV = 'production';
			expect(config.node.isTest).toBe(false);
		});

		it('should return isProduction correctly', () => {
			process.env.NODE_ENV = 'production';
			expect(config.node.isProduction).toBe(true);

			process.env.NODE_ENV = 'development';
			expect(config.node.isProduction).toBe(false);
		});

		it('should return isDevelopment correctly', () => {
			process.env.NODE_ENV = 'development';
			expect(config.node.isDevelopment).toBe(true);

			process.env.NODE_ENV = 'test';
			expect(config.node.isDevelopment).toBe(false);
		});
	});
});
