-- Migration: 002_add_archived_field
-- Description: Add archived field to ctfs table
-- Date: 2025-10-30

-- Archived column is already defined inline in database/index.js.
-- Only the index is needed here.
CREATE INDEX IF NOT EXISTS idx_ctfs_archived ON ctfs(archived);
