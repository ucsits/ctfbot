-- Migration 027: Remember people the bot talks to
--
-- actor_profiles holds per-user preferences. language is free text such as
-- "English"; NULL means the bot default (Indonesian, set in the prompt).
-- actor_memories holds short notes the bot learned from conversations or
-- that the user added with /memory, shown to the model on later passes so it
-- can pick assignees and deadlines the way each person prefers.

CREATE TABLE IF NOT EXISTS actor_profiles (
    user_id    TEXT PRIMARY KEY,
    language   TEXT,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS actor_memories (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           TEXT NOT NULL,
    note              TEXT NOT NULL,
    added_by          TEXT,
    source_message_id TEXT,
    created_at        INTEGER NOT NULL,
    UNIQUE (user_id, note)
);

CREATE INDEX IF NOT EXISTS idx_actor_memories_user ON actor_memories (user_id, created_at);
