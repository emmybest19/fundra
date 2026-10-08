-- Ledger accounts are append-only (docs/DATABASE.md §8, rule 12).
--
-- An account's code, type and currency define what its entries mean. Changing `type` silently
-- flips the sign of its balance (an ASSET is debit-normal, a LIABILITY credit-normal), and
-- changing `currency` cascades through the composite foreign keys (ON UPDATE CASCADE) into
-- the wallet that owns the account. Its other columns (id, created_at) must never change
-- either, so the whole row is immutable. Deleting is refused too: system accounts are found
-- by code (FEE_REVENUE:NGN, …), so deleting even an unused one breaks the next posting.
--
-- INSERT stays allowed: wallet creation (Stage 10) and the seed create accounts.
-- Violations raise FN001, like ledger_entries and audit_logs (migration 20261002134012).

CREATE TRIGGER ledger_accounts_append_only
  BEFORE UPDATE OR DELETE ON "ledger_accounts"
  FOR EACH ROW EXECUTE FUNCTION fundra_reject_modification();

-- TRUNCATE bypasses row-level triggers, so it is blocked separately.
CREATE TRIGGER ledger_accounts_no_truncate
  BEFORE TRUNCATE ON "ledger_accounts"
  FOR EACH STATEMENT EXECUTE FUNCTION fundra_reject_modification();
