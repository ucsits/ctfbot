-- Migration: 003_add_challenges_table
-- Description: Add challenges table for tracking CTF challenges
-- Date: 2025-10-30

-- Create challenges table
CREATE TABLE IF NOT EXISTS ctf_challenges (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	ctf_id INTEGER NOT NULL,
	chal_name TEXT NOT NULL,
	chal_category TEXT NOT NULL,
	solved INTEGER DEFAULT 0,
	solved_by TEXT,
	solved_at TEXT,
	created_at TEXT DEFAULT CURRENT_TIMESTAMP,
	created_by TEXT NOT NULL,
	FOREIGN KEY (ctf_id) REFERENCES ctfs(id) ON DELETE CASCADE,
	UNIQUE(ctf_id, chal_name)
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_challenges_ctf_id ON ctf_challenges(ctf_id);
CREATE INDEX IF NOT EXISTS idx_challenges_category ON ctf_challenges(chal_category);
CREATE INDEX IF NOT EXISTS idx_challenges_solved ON ctf_challenges(solved);
