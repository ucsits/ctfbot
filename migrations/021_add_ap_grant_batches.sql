-- Migration 021: Idempotency ledger for batched AP grants
--
-- A single blockchain block covers a whole batch of AP grants (a role grant or
-- a CSV bulk grant), but the grants themselves were applied in a loop of
-- independent transactions. A failure partway through credited a prefix of the
-- recipients while the block claimed the whole batch, and a retry re-applied
-- grants that had already been written.
--
-- Each batch is now keyed by the originating Discord interaction id, so
-- grantPointsMany can detect an already-applied batch and refuse to re-apply.

CREATE TABLE IF NOT EXISTS ap_grant_batches (
    batch_key    TEXT PRIMARY KEY,
    block_height INTEGER,
    created_at   INTEGER NOT NULL
);
