-- Migration 029. Tool-driven task suggestions.
--
-- The suggestion pass now uses tool calls, so one NEW message can queue several
-- cards (for example "cancel the old LPJ, then do it today and tomorrow").
-- The old UNIQUE (channel_id, source_message_id) key allowed only one card per
-- message and is therefore gone. Duplicates are rejected by the service by
-- title, which is the real identity of a card.
--
-- kind separates the two card actions:
--   create  a card that creates a task when someone confirms
--   cancel  a card that cancels target_task_id when someone confirms
--
-- status is open -> working (claimed by a click, lease until claimed_until)
--         -> created | cancelled | kept | dismissed. An expired lease counts as
--         open again, so a crash mid-action cannot lock a card forever.

CREATE TABLE IF NOT EXISTS task_suggestions_new (
    id                TEXT PRIMARY KEY,
    channel_id        TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    card_message_id   TEXT,
    kind              TEXT NOT NULL DEFAULT 'create',
    target_task_id    TEXT,
    title             TEXT NOT NULL,
    description       TEXT,
    assignee_id       TEXT NOT NULL,
    deadline          INTEGER,
    status            TEXT NOT NULL DEFAULT 'open',
    claimed_until     INTEGER,
    handled_by        TEXT,
    task_id           TEXT,
    created_at        INTEGER NOT NULL,
    handled_at        INTEGER
);

INSERT OR IGNORE INTO task_suggestions_new
    (id, channel_id, source_message_id, card_message_id, kind, target_task_id, title,
     description, assignee_id, deadline, status, claimed_until, handled_by, task_id,
     created_at, handled_at)
SELECT id, channel_id, source_message_id, card_message_id, 'create', NULL, title,
       description, assignee_id, deadline, status, claimed_until, handled_by, task_id,
       created_at, handled_at
FROM task_suggestions;

DROP TABLE task_suggestions;

ALTER TABLE task_suggestions_new RENAME TO task_suggestions;

CREATE INDEX IF NOT EXISTS idx_task_suggestions_source
    ON task_suggestions(channel_id, source_message_id);

CREATE INDEX IF NOT EXISTS idx_task_suggestions_status
    ON task_suggestions(channel_id, status);

CREATE INDEX IF NOT EXISTS idx_task_suggestions_target
    ON task_suggestions(channel_id, kind, target_task_id);
