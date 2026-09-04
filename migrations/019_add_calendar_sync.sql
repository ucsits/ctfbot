-- Migration 019: Google Calendar bidirectional sync for tasks (Option A).
-- Adds the columns and tables needed to mirror bot tasks to a shared Google
-- Calendar and reconcile bot-owned calendar events back into the task DB.

-- Link tasks to the Google Calendar event created for them.
ALTER TABLE tasks ADD COLUMN calendar_event_id TEXT;
ALTER TABLE tasks ADD COLUMN calendar_synced_at INTEGER;
ALTER TABLE tasks ADD COLUMN calendar_source TEXT;

-- Single-row store for the shared org Google credentials used by the sync
-- service. Provisioned once (via a helper script or trusted admin) and
-- refreshed at runtime. CHECK(id = 1) enforces the single-row invariant.
CREATE TABLE IF NOT EXISTS google_credentials (
    id            INTEGER PRIMARY KEY CHECK(id = 1),
    client_id     TEXT NOT NULL,
    client_secret TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    calendar_id   TEXT NOT NULL,
    updated_at    INTEGER NOT NULL
);

-- Single-row incremental-sync cursor for the Calendar API. The sync_token
-- drives incremental updates via the events.list nextSyncToken field; clearing
-- it forces a full re-scan.
CREATE TABLE IF NOT EXISTS calendar_sync_state (
    id           INTEGER PRIMARY KEY CHECK(id = 1),
    sync_token   TEXT,
    last_sync_at INTEGER
);