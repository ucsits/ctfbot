-- Migration 018: Add recoverable claims for task lifecycle transitions
ALTER TABLE tasks ADD COLUMN transition_by TEXT;
ALTER TABLE tasks ADD COLUMN transition_until INTEGER;
CREATE INDEX IF NOT EXISTS idx_tasks_transition ON tasks(transition_until);
