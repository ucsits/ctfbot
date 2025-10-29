-- Migration: 002_add_archived_field
-- Description: Add archived field to ctfs table
-- Date: 2025-10-30

-- Add archived column to ctfs table
ALTER TABLE ctfs ADD COLUMN archived INTEGER DEFAULT 0;

-- Create index for archived field
CREATE INDEX IF NOT EXISTS idx_ctfs_archived ON ctfs(archived);
