-- Migration: 003_add_challenges_table
-- Description: Add challenges table for tracking CTF challenges
-- Date: 2025-10-30

-- The ctf_challenges table is already created inline in database/index.js
-- (without the solved/solved_by/solved_at columns).
-- Only indexes on columns that actually exist in the inline schema are needed.
CREATE INDEX IF NOT EXISTS idx_challenges_ctf_id ON ctf_challenges(ctf_id);
CREATE INDEX IF NOT EXISTS idx_challenges_category ON ctf_challenges(chal_category);
