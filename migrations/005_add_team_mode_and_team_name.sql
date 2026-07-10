-- Migration: 005_add_team_mode_and_team_name
-- Description: Add team_mode to CTFs and team_name to registrations for team-based competition tracking
-- Date: 2025-10-30

-- team_mode and team_name are already defined inline in database/index.js.
-- Only the index is needed here.
CREATE INDEX IF NOT EXISTS idx_registrations_team ON ctf_registrations(ctf_id, team_name);
