-- Migration 013: Add 'cancelled' column to tasks table
-- Allows tasks to be cancelled via /task cancel

ALTER TABLE tasks ADD COLUMN cancelled INTEGER NOT NULL DEFAULT 0;
