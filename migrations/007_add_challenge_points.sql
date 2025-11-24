-- Add points column to ctf_challenges table
ALTER TABLE ctf_challenges ADD COLUMN points INTEGER DEFAULT 0;
