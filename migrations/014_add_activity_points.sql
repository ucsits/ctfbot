-- Migration 014: Activity points economy
-- Adds the activity board ledger, running balances, store catalog, and purchases.
-- Every AP transaction corresponds to a Luce blockchain block.

-- Append-only ledger of AP value movements.
CREATE TABLE IF NOT EXISTS activity_ledger (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      TEXT NOT NULL,
    amount       INTEGER NOT NULL,                    -- positive = grant, negative = spend
    kind         TEXT NOT NULL CHECK(kind IN ('grant', 'purchase')),
    granted_by   TEXT,                                 -- admin who granted (kind = 'grant')
    reference_id TEXT,                                 -- purchase id when kind = 'purchase'
    note         TEXT,
    block_height INTEGER NOT NULL,
    created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_ledger_user
    ON activity_ledger(user_id);

-- Denormalized current balance per user, updated atomically in a transaction.
CREATE TABLE IF NOT EXISTS activity_balances (
    user_id  TEXT PRIMARY KEY,
    balance  INTEGER NOT NULL DEFAULT 0
);

-- Store catalog (AP and Rp are both denormalized prices per item).
CREATE TABLE IF NOT EXISTS store_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT NOT NULL UNIQUE,                 -- 'sticker', 'shirt', 'jacket'
    name        TEXT NOT NULL,
    description TEXT,
    ap_price    INTEGER NOT NULL DEFAULT 0,
    rp_price    INTEGER NOT NULL DEFAULT 0
);

-- Purchase records. AP purchases complete immediately; Rp purchases start
-- 'pending' and an admin confirms them once payment arrives offline.
CREATE TABLE IF NOT EXISTS purchases (
    id             TEXT PRIMARY KEY,                  -- uuid
    user_id        TEXT NOT NULL,
    item_id        INTEGER NOT NULL,
    payment_method TEXT NOT NULL CHECK(payment_method IN ('ap', 'rp')),
    status         TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'cancelled')),
    cost_ap        INTEGER NOT NULL DEFAULT 0,
    cost_rp        INTEGER NOT NULL DEFAULT 0,
    block_height   INTEGER,                            -- set on completion/confirmation
    created_at     INTEGER NOT NULL,
    confirmed_at   INTEGER,
    confirmed_by   TEXT,
    FOREIGN KEY (item_id) REFERENCES store_items(id)
);

CREATE INDEX IF NOT EXISTS idx_purchases_user
    ON purchases(user_id);

-- Seed the store catalog with the three merchandise items.
INSERT OR IGNORE INTO store_items (slug, name, description, ap_price, rp_price) VALUES
    ('sticker', 'Sticker', 'A collectible activity sticker', 10, 25000),
    ('shirt',   'Shirt',   'Official activity shirt',        200, 120000),
    ('jacket',  'Jacket',  'Official activity jacket',       700, 250000);