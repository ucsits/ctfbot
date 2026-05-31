-- Migration: 009_fix_challenge_solves_unique
-- Description: Ensure UNIQUE constraint on ctf_challenge_solves exists
-- Date: 2026-05-31

-- Recreate ctf_challenge_solves with UNIQUE constraint if missing
-- SQLite does not support adding UNIQUE constraints to existing tables
CREATE TABLE IF NOT EXISTS ctf_challenge_solves_new (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	challenge_id INTEGER NOT NULL,
	user_id TEXT NOT NULL,
	solved_at TEXT DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (challenge_id) REFERENCES ctf_challenges(id) ON DELETE CASCADE,
	UNIQUE(challenge_id, user_id)
);

INSERT OR IGNORE INTO ctf_challenge_solves_new (challenge_id, user_id, solved_at)
SELECT challenge_id, user_id, solved_at FROM ctf_challenge_solves;

DROP TABLE IF EXISTS ctf_challenge_solves;

ALTER TABLE ctf_challenge_solves_new RENAME TO ctf_challenge_solves;

CREATE INDEX IF NOT EXISTS idx_challenge_solves_challenge_id ON ctf_challenge_solves(challenge_id);
CREATE INDEX IF NOT EXISTS idx_challenge_solves_user_id ON ctf_challenge_solves(user_id);
