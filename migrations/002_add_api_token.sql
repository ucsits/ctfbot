-- Migration: 002_add_api_token
-- Description: Add api_token column to ctfs table for CTFd integration
-- Date: 2025-10-29

-- Add api_token column to ctfs table
ALTER TABLE ctfs ADD COLUMN api_token TEXT;

-- Record this migration
INSERT OR IGNORE INTO migrations (name) VALUES ('002_add_api_token');
