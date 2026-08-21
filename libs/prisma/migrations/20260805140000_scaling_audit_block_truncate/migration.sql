-- Close the TRUNCATE gap in the Scale Sentinel append-only guarantee (SA-001).
--
-- The 20260805120000_add_scaling_audit migration protected scaling_events and
-- scaling_audit_daily_seals with:
--     REVOKE UPDATE, DELETE ...
--     CREATE TRIGGER ... BEFORE UPDATE OR DELETE ... FOR EACH ROW
--
-- TRUNCATE defeats BOTH of those, for two independent reasons:
--
--   1. TRUNCATE is its own privilege in PostgreSQL, not a variety of DELETE.
--      "REVOKE UPDATE, DELETE" leaves it untouched. Verified against the live sbx
--      database on 2026-08-05: information_schema.table_privileges for the app
--      role listed INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE — UPDATE and
--      DELETE correctly absent, TRUNCATE still granted.
--
--   2. Row-level (FOR EACH ROW) triggers never fire on TRUNCATE. TRUNCATE does
--      not visit rows — it deallocates the table's storage — so there are no
--      per-row events to fire on. Only a statement-level BEFORE TRUNCATE trigger
--      can intercept it.
--
-- Net effect before this migration: `DELETE FROM scaling_events` was correctly
-- rejected, while `TRUNCATE TABLE scaling_events` silently destroyed every row
-- for every tenant at once, leaving no row-level trace. That was demonstrated,
-- not theorised — it is how the sbx table was reset on 2026-08-05.
--
-- Detection did not cover it either: the daily hash-chain seal only detects loss
-- for days already sealed, so an unsealed window was both unprevented and
-- undetectable.
--
-- Reuses scaling_audit_reject_mutation() unchanged — it reports TG_OP and
-- TG_TABLE_NAME, and TG_OP is 'TRUNCATE' here, so the raised message reads
-- "... : TRUNCATE on "scaling_events" is not permitted ...".

-- DROP IF EXISTS so re-running this migration during a repair is safe.
DROP TRIGGER IF EXISTS trg_scaling_events_no_truncate ON "scaling_events";
DROP TRIGGER IF EXISTS trg_scaling_audit_daily_seals_no_truncate ON "scaling_audit_daily_seals";

CREATE TRIGGER trg_scaling_events_no_truncate
  BEFORE TRUNCATE ON "scaling_events"
  FOR EACH STATEMENT
  EXECUTE FUNCTION scaling_audit_reject_mutation();

CREATE TRIGGER trg_scaling_audit_daily_seals_no_truncate
  BEFORE TRUNCATE ON "scaling_audit_daily_seals"
  FOR EACH STATEMENT
  EXECUTE FUNCTION scaling_audit_reject_mutation();

-- Same CURRENT_USER rationale as the original migration: one DATABASE_URL serves
-- both migrations and the app, so this is the role the app connects as. As there,
-- the REVOKE is real hardening for a non-superuser app role while the trigger is
-- the unconditional enforcement (superusers bypass privilege checks entirely).
REVOKE TRUNCATE ON "scaling_events" FROM CURRENT_USER;
REVOKE TRUNCATE ON "scaling_audit_daily_seals" FROM CURRENT_USER;

-- ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
-- This stops accidental and casual destruction. It does NOT make these tables
-- immutable against anyone holding the application's credentials, because that
-- role OWNS the tables — and an owner may DROP TRIGGER or GRANT privileges back
-- to itself at will. These controls are a guardrail against mistakes and
-- careless scripts, not a barrier against a determined actor with app creds.
--
-- Regulator-grade immutability additionally requires the table owner to be a
-- DIFFERENT role from the application role (app holds INSERT/SELECT only, with
-- no authority over triggers), plus an external control — PITR/WAL archiving,
-- replication into an append-only store, or S3 Object Lock on the exports.
-- That is a deployment/ownership decision, not something a migration can assert.
--
-- ── BREAK-GLASS (non-production only) ───────────────────────────────────────
-- Resetting a sandbox to force a full re-capture is now a deliberate act rather
-- than something the app role can do casually. As the table owner:
--     DROP TRIGGER trg_scaling_events_no_truncate ON "scaling_events";
--     TRUNCATE TABLE scaling_events;
--     -- also clear scaling_audit_watermarks for the tenant, or the re-poll
--     -- resumes from the old mark and captures nothing
--     CREATE TRIGGER trg_scaling_events_no_truncate
--       BEFORE TRUNCATE ON "scaling_events"
--       FOR EACH STATEMENT EXECUTE FUNCTION scaling_audit_reject_mutation();
-- Never in production: these rows are the SEBI evidence record.
