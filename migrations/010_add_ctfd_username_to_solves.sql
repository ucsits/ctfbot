-- Migration: 010_add_ctfd_username_to_solves
-- Description: Add ctfd_username column to ctf_challenge_solves for unregistered user tracking

CREATE TABLE IF NOT EXISTS ctf_challenge_solves_new (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	challenge_id INTEGER NOT NULL,
	user_id TEXT NOT NULL,
	ctfd_username TEXT,
	solved_at TEXT DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (challenge_id) REFERENCES ctf_challenges(id) ON DELETE CASCADE,
	UNIQUE(challenge_id, user_id)
);

INSERT INTO ctf_challenge_solves_new (challenge_id, user_id, solved_at)
SELECT challenge_id, user_id, solved_at FROM ctf_challenge_solves;

DROP TABLE IF EXISTS ctf_challenge_solves;

ALTER TABLE ctf_challenge_solves_new RENAME TO ctf_challenge_solves;

CREATE INDEX IF NOT EXISTS idx_challenge_solves_challenge_id ON ctf_challenge_solves(challenge_id);
CREATE INDEX IF NOT EXISTS idx_challenge_solves_user_id ON ctf_challenge_solves(user_id);
