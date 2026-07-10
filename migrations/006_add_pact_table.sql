-- Migration: Create pacts table
-- Aligned with inline schema in database/index.js (nullable name/nrp, no created_at)
CREATE TABLE IF NOT EXISTS pacts (
    user_id TEXT PRIMARY KEY,
    name TEXT,
    nrp TEXT
);
