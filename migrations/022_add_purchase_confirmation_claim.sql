-- Migration 022: Confirmation claim for pending Rp purchases
--
-- /store-confirm read the purchase, checked its status, appended the
-- confirmation block, and then called confirmPurchase, discarding the boolean
-- result. Two rapid invocations both saw "pending", both anchored a
-- confirmation block, and both reported success while only one row changed.
--
-- The claim columns let one invocation reserve the purchase before the block is
-- anchored. The lease makes an abandoned claim (crashed process) recoverable.

ALTER TABLE purchases ADD COLUMN confirm_claim_by TEXT;
ALTER TABLE purchases ADD COLUMN confirm_claim_until INTEGER;

CREATE INDEX IF NOT EXISTS idx_purchases_confirm_claim ON purchases(confirm_claim_until);
