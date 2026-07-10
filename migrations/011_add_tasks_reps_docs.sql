-- Migration 011: Add tasks, reputation, and document tables
-- for blockchain-integrated features.

CREATE TABLE IF NOT EXISTS tasks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id         TEXT NOT NULL UNIQUE,
    title           TEXT NOT NULL,
    description     TEXT,
    assigned_to     TEXT NOT NULL,
    created_by      TEXT NOT NULL,
    deadline        INTEGER NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending', 'done')),
    completed_by    TEXT,
    completed_at    INTEGER,
    block_height    INTEGER NOT NULL,
    created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_reminders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id     TEXT NOT NULL,
    channel_id  TEXT NOT NULL,
    remind_at   INTEGER NOT NULL,
    sent        INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (task_id) REFERENCES tasks(task_id)
);

CREATE INDEX IF NOT EXISTS idx_task_reminders_unsent
    ON task_reminders(sent, remind_at);

CREATE TABLE IF NOT EXISTS reputations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL,
    from_user   TEXT NOT NULL,
    amount      INTEGER NOT NULL CHECK(amount IN (1, -1)),
    reason      TEXT,
    date        TEXT NOT NULL,
    block_height INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reputations_user
    ON reputations(user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reputations_giver_date
    ON reputations(from_user, date);

CREATE TABLE IF NOT EXISTS documents (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id      TEXT NOT NULL UNIQUE,
    title       TEXT NOT NULL,
    content     TEXT NOT NULL,
    author      TEXT NOT NULL,
    mime_type   TEXT NOT NULL DEFAULT 'text/plain',
    block_height INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
);
