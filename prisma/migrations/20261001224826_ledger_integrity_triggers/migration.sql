-- Ledger and audit integrity enforced by the database (docs/DATABASE.md §8, rules 1, 3 and 4).
-- The application checks these first; the triggers guarantee them even if application code has a bug.
-- Prisma does not track triggers or functions, so they don't cause schema drift.

-- ─── Append-only tables ──────────────────────────────────────────────────────
-- Financial history and the audit trail are never changed or removed. Mistakes are
-- corrected with new, offsetting records (e.g. a REVERSAL transaction).

CREATE FUNCTION fundra_reject_modification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Record a new, offsetting entry instead of changing history.';
END;
$$;

CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION fundra_reject_modification();

-- TRUNCATE bypasses row-level triggers, so it is blocked separately.
CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON "ledger_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION fundra_reject_modification();

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION fundra_reject_modification();

CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION fundra_reject_modification();

-- ─── Balanced transactions ───────────────────────────────────────────────────
-- Entries are inserted one by one, so a transaction is briefly unbalanced while it is
-- being written. The check is DEFERRED to COMMIT: intermediate states are allowed,
-- committing unbalanced books is not. It also fires if a later database transaction
-- adds entries to an already-committed ledger transaction.

CREATE FUNCTION fundra_assert_transaction_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  total_debits  numeric;
  total_credits numeric;
BEGIN
  SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'), 0),
         COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0)
    INTO total_debits, total_credits
    FROM "ledger_entries"
   WHERE transaction_id = NEW.transaction_id;

  IF total_debits <> total_credits THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced: debits % <> credits %',
        NEW.transaction_id, total_debits, total_credits
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'ledger_entries_balanced',
            TABLE = 'ledger_entries';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON "ledger_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fundra_assert_transaction_balanced();
