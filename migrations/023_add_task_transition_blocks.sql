-- Migration 023: Idempotency record for task transition blocks
--
-- A task done/cancel transition claims a lease, appends a blockchain block, then
-- writes the DB transition. If the block were persisted but the response lost,
-- the catch released the claim and a retry appended a SECOND task_done block
-- for the same transition.
--
-- One row per (task, action) records the anchored height, so a retry can see
-- that the chain write already happened and skip it.

CREATE TABLE IF NOT EXISTS task_transition_blocks (
    task_id      TEXT NOT NULL,
    action       TEXT NOT NULL,
    actor_id     TEXT,
    block_height INTEGER,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (task_id, action)
);
