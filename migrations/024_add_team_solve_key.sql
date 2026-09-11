-- Migration 024: Enforce one solve per team in the database
--
-- Team-mode deduplication was application-only: solvectf and syncchallenges
-- checked every team member for an existing solve and then inserted. The only
-- schema guarantee was UNIQUE(challenge_id, user_id), which is per user, so two
-- team members could both be recorded for the same challenge if the check was
-- bypassed or a second process raced it.
--
-- team_key carries the team name for team-mode solves and stays NULL for
-- individual solves. The partial unique index then enforces one solve per team
-- per challenge while leaving individual mode completely unaffected.

ALTER TABLE ctf_challenge_solves ADD COLUMN team_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_solves_challenge_team
    ON ctf_challenge_solves(challenge_id, team_key)
    WHERE team_key IS NOT NULL;
