-- Migration: 008_add_admins_table
-- Description: Create admins table for bot admin management
-- Date: 2026-01-20

CREATE TABLE IF NOT EXISTS admins (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id TEXT NOT NULL UNIQUE,
	added_by TEXT NOT NULL,
	added_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO migrations (name) VALUES ('008_add_admins_table');
