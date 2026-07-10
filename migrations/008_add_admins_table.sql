-- Migration: 008_add_admins_table
-- Description: Create admins table for bot admin management
-- Date: 2026-01-20

-- The admins table is NOT created inline in database/index.js,
-- so this CREATE TABLE is still needed.
CREATE TABLE IF NOT EXISTS admins (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id TEXT NOT NULL UNIQUE,
	added_by TEXT NOT NULL,
	added_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Note: the migration runner automatically inserts into the migrations table.
-- Do NOT add INSERT OR IGNORE INTO migrations here — it causes a UNIQUE conflict.
