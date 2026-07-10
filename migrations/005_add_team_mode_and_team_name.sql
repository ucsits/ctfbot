-- Migration: 005_add_team_mode_and_team_name
-- Description: Add team_mode to CTFs and team_name to registrations for team-based competition tracking
-- Date: 2025-10-30

-- Add team_mode column to ctfs table (0 = individual, 1 = team)
ALTER TABLE ctfs ADD COLUMN team_mode INTEGER DEFAULT 0;

-- Add team_name column to ctf_registrations for manual team tracking
ALTER TABLE ctf_registrations ADD COLUMN team_name TEXT;

-- Create index for team-based queries
CREATE INDEX IF NOT EXISTS idx_registrations_team ON ctf_registrations(ctf_id, team_name);
