-- Migration: 001_initial_schema
-- Description: Create initial database schema for CTFBot
-- Date: 2025-10-29

-- Create CTFs table
CREATE TABLE IF NOT EXISTS ctfs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	guild_id TEXT NOT NULL,
	channel_id TEXT NOT NULL UNIQUE,
	event_id TEXT,
	ctf_name TEXT NOT NULL,
	ctf_base_url TEXT NOT NULL,
	ctf_date TEXT NOT NULL,
	description TEXT,
	banner_url TEXT,
	created_at TEXT DEFAULT CURRENT_TIMESTAMP,
	created_by TEXT NOT NULL
);

-- Create CTF registrations table
CREATE TABLE IF NOT EXISTS ctf_registrations (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	ctf_id INTEGER NOT NULL,
	user_id TEXT NOT NULL,
	username TEXT NOT NULL,
	ctfd_user_id TEXT,
	ctfd_team_name TEXT,
	registered_at TEXT DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (ctf_id) REFERENCES ctfs(id) ON DELETE CASCADE,
	UNIQUE(ctf_id, user_id)
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_ctfs_guild_id ON ctfs(guild_id);
CREATE INDEX IF NOT EXISTS idx_ctfs_channel_id ON ctfs(channel_id);
CREATE INDEX IF NOT EXISTS idx_registrations_ctf_id ON ctf_registrations(ctf_id);
CREATE INDEX IF NOT EXISTS idx_registrations_user_id ON ctf_registrations(user_id);

-- Create migrations table to track applied migrations
CREATE TABLE IF NOT EXISTS migrations (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL UNIQUE,
	applied_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Record this migration
INSERT OR IGNORE INTO migrations (name) VALUES ('001_initial_schema');
