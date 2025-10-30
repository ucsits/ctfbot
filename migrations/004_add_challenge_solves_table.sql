-- Migration: 004_add_challenge_solves_table
-- Description: Add challenge solves table for tracking multiple solvers per challenge
-- Date: 2025-10-30

-- Create challenge solves table (many-to-many relationship)
CREATE TABLE IF NOT EXISTS ctf_challenge_solves (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	challenge_id INTEGER NOT NULL,
	user_id TEXT NOT NULL,
	solved_at TEXT DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (challenge_id) REFERENCES ctf_challenges(id) ON DELETE CASCADE,
	UNIQUE(challenge_id, user_id)
);

-- Create index for better performance
CREATE INDEX IF NOT EXISTS idx_challenge_solves_challenge_id ON ctf_challenge_solves(challenge_id);
CREATE INDEX IF NOT EXISTS idx_challenge_solves_user_id ON ctf_challenge_solves(user_id);
