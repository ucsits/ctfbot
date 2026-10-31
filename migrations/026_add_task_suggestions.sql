-- Migration 026: Persist task suggestions posted from conversations
--
-- Suggestion cards used to live only in memory, so their buttons stopped
-- working after 24 hours or on any bot restart. One row per card keeps it
-- actionable until someone creates the task or dismisses it.
--
-- status: open → working (claimed by a click, lease until claimed_until)
--         → created | dismissed. An expired lease counts as open again, so a
--         crash mid-creation cannot lock a card forever.
-- The (channel_id, source_message_id) key stops the same decision from being
-- suggested twice, including across restarts.

CREATE TABLE IF NOT EXISTS task_suggestions (
    id                TEXT PRIMARY KEY,
    channel_id        TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    card_message_id   TEXT,
    title             TEXT NOT NULL,
    description       TEXT,
    assignee_id       TEXT NOT NULL,
    deadline          INTEGER,
    status            TEXT NOT NULL DEFAULT 'open',
    claimed_until     INTEGER,
    handled_by        TEXT,
    task_id           TEXT,
    created_at        INTEGER NOT NULL,
    handled_at        INTEGER,
    UNIQUE (channel_id, source_message_id)
);
