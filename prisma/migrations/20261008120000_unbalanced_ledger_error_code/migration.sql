-- Give an unbalanced ledger transaction its own SQLSTATE.
--
-- The deferred `ledger_entries_balanced` trigger raised the standard 23514 check_violation
-- with CONSTRAINT = 'ledger_entries_balanced'. Testing through Prisma 7 (Stage 11) showed the
-- failure arrives at COMMIT as a bare DriverAdapterError whose cause keeps the code but drops
-- the constraint name, so it was indistinguishable from an ordinary CHECK violation (e.g. a
-- wallet going negative) except by its message text. FN002 is unambiguous, like FN001.
--
-- Fundra SQLSTATEs:
--   FN001  append-only table modified (ledger_entries, audit_logs, ledger_accounts)
--   FN002  ledger transaction unbalanced at COMMIT
--
-- Same function, same trigger; only the error code changes.

CREATE OR REPLACE FUNCTION fundra_assert_transaction_balanced() RETURNS trigger
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
      USING ERRCODE = 'FN002',
            CONSTRAINT = 'ledger_entries_balanced',
            TABLE = 'ledger_entries';
  END IF;

  RETURN NULL;
END;
$$;
