-- Migration: Create pacts table
CREATE TABLE IF NOT EXISTS pacts (
    user_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    nrp TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
