-- Migration 017: Add retry and delivery state for reminders and digests
ALTER TABLE task_reminders ADD COLUMN processing_until INTEGER;
ALTER TABLE task_reminders ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_reminders ADD COLUMN last_error TEXT;
ALTER TABLE task_reminders ADD COLUMN failed_permanently INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS task_digest_deliveries (
    digest_key TEXT PRIMARY KEY,
    delivered_at INTEGER NOT NULL DEFAULT 0,
    processing_until INTEGER
);
