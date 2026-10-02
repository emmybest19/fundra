-- Give append-only violations their own SQLSTATE.
--
-- The previous version raised 23001 (restrict_violation). Prisma's pg adapter maps 23001 to
-- "Foreign key constraint violated" (P2003), which misreports the error and makes it
-- indistinguishable from a real foreign-key failure. FN001 is in a Fundra-reserved class the
-- adapter passes through unchanged, with the original message.
--
-- Fundra SQLSTATEs:
--   FN001  append-only table modified (ledger_entries, audit_logs)
-- (Balanced-ledger failures keep the standard 23514 check_violation; the adapter passes it through.)

CREATE OR REPLACE FUNCTION fundra_reject_modification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'FN001',
          HINT = 'Record a new, offsetting entry instead of changing history.';
END;
$$;
