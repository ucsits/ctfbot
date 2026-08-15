-- Migration 015: Store catalog price adjustments + new keychain item
-- Sticker Rp 25,000 -> Rp 1,000 (AP 10 unchanged)
-- Jacket Rp 250,000 -> Rp 200,000 (AP 700 unchanged)
-- New: Keychain (50 AP; Rp 10,000)
UPDATE store_items SET rp_price = 1000   WHERE slug = 'sticker';
UPDATE store_items SET rp_price = 200000 WHERE slug = 'jacket';
INSERT OR IGNORE INTO store_items (slug, name, description, ap_price, rp_price) VALUES
    ('keychain', 'Keychain', 'Official activity keychain', 50, 10000);
