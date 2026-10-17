-- The role the application connects as (docs/DATABASE.md, "Database roles").
--
-- Migrations run as the schema owner. The app connects as fundra_app, which owns nothing, so
-- it can't ALTER, DROP or TRUNCATE a table, or disable the ledger's append-only triggers: only
-- an owner can, so a bug or an injection in the app can't switch the ledger's guards off.
--
-- Run once per database, as the owner, after `prisma migrate deploy`. Safe to run again.
-- The password is set separately from a secret, never stored here:
--   ALTER ROLE fundra_app PASSWORD '<from your secret manager>';
-- then point the app's DATABASE_URL at fundra_app (and keep the owner's URL for migrations).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fundra_app') THEN
    CREATE ROLE fundra_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO fundra_app;

-- Ordinary tables: read and write rows, nothing structural.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO fundra_app;

-- Append-only tables: rows are added and read, never changed or removed. The triggers say so
-- too; without UPDATE and DELETE the role can't even try.
REVOKE UPDATE, DELETE ON ledger_entries, ledger_accounts, audit_logs FROM fundra_app;

-- Prisma's migration history is the owner's business (the table exists once `migrate deploy` ran).
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON _prisma_migrations FROM fundra_app';
  END IF;
END
$$;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO fundra_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO fundra_app;

-- Tables later migrations create get the same everyday access (not TRUNCATE or REFERENCES).
-- A new append-only table must repeat the REVOKE above in its own migration.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fundra_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO fundra_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO fundra_app;
