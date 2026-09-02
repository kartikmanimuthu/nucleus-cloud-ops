-- Resets role assignments WITHIN THE `smc` TENANT ONLY, via truncate-and-rebuild.
--
--   arijitamin@smcindiaonline.com        -> Owner
--   divyanshuavasthi@smcindiaonline.com  -> Owner
--   kartikchouhan@smcindiaonline.com     -> Owner
--   kartikmanimuthu@gmail.com            -> Owner
--   every other `smc` member             -> Viewer
--
-- Memberships in every OTHER tenant keep the role they already hold. That is
-- deliberate and load-bearing: 11 of the 13 tenants are single-member orgs whose
-- only member is their Owner (adyatiwari, ashokjangir, sumitsingh2004,
-- test@graphify.io). Applying the Viewer default globally would leave those 11
-- tenants with NO Owner, nobody able to administer permissions, and — with zero
-- SuperAdmin accounts in production — no recovery path short of direct database
-- access. assertNoLockout() exists to prevent exactly that, and a migration
-- bypasses it.
--
-- ── SOURCED FROM THE LIVE TABLE ─────────────────────────────────────────────
-- No row list is hardcoded. The table is copied to a TEMP table, truncated, then
-- rebuilt from that copy — so memberships created after this file was written
-- are carried through rather than destroyed. The real table is emptied, never
-- dropped, so the primary key, the (userId, tenantId) unique constraint, both
-- indexes and the FK to custom_roles all survive untouched.
--
-- ── roleId IS COMPUTED, NOT COPIED ──────────────────────────────────────────
-- On re-insert roleId is derived from the resulting role name. Owner and Viewer
-- are predefined, so every rewritten `smc` row gets roleId NULL — the documented
-- meaning for built-ins (schema.prisma:200), which resolveRole() handles by
-- falling back to the name. Rows in other tenants naming a custom role have
-- their FK recomputed from that name, which also repairs the role/roleId
-- divergence described in docs/rca-2026-08-21-role-column-divergence.md.
--
-- ── SAFETY ──────────────────────────────────────────────────────────────────
-- One transaction (TRUNCATE is transactional in PostgreSQL). The guards RAISE
-- EXCEPTION rather than WARNING, so any row loss, lost id, or tenant left
-- without an administrator rolls the whole thing back.
--
-- ── CONSEQUENCE TO BE AWARE OF ──────────────────────────────────────────────
-- 17 `smc` members drop to Viewer, including 7 current cloud-admins. They lose
-- all write access. dipanshutyagi@smcindiaonline.com is among them and will lose
-- IAM, so cannot undo this through the UI afterwards.
--
-- ── ENVIRONMENTS WITHOUT AN `smc` TENANT ────────────────────────────────────
-- This migration is only meaningful where the `smc` tenant exists (prod). sbx/
-- uat/dev are seeded with different tenant data, so the guard below skips with a
-- NOTICE instead of raising — a hard failure here left the migration recorded as
-- failed and blocked every later `migrate deploy` on that database (P3009)
-- until someone ran `prisma migrate resolve` by hand.
--
-- Everything below now runs inside one DO block so the skip can short-circuit
-- before any DDL runs. TRUNCATE/CREATE TEMP TABLE/DROP TABLE need EXECUTE here
-- only because PL/pgSQL requires it for DDL — none of it is dynamic, it's the
-- same fixed statements the top-level form used.

DO $outer$
DECLARE
    v_smc    TEXT;
    v_tot    INT;
    v_own    INT;
    v_view   INT;
    v_src    INT;
    v_live   INT;
    v_new    INT;
    v_bad    INT;
    v_orphan INT;
BEGIN
    -- ── 1. Preview ───────────────────────────────────────────────────────────
    SELECT "id" INTO v_smc FROM "tenants" WHERE "slug" = 'smc';
    IF v_smc IS NULL THEN
        RAISE NOTICE 'reset_smc_tenant_roles: no tenant with slug ''smc'' in this database - skipping';
        RETURN;
    END IF;

    SELECT count(*) INTO v_tot FROM "user_tenant_roles" WHERE "tenantId" = v_smc;
    SELECT count(*) INTO v_own FROM "user_tenant_roles"
     WHERE "tenantId" = v_smc
       AND lower("email") IN ('arijitamin@smcindiaonline.com','divyanshuavasthi@smcindiaonline.com',
                              'kartikchouhan@smcindiaonline.com','kartikmanimuthu@gmail.com');
    v_view := v_tot - v_own;

    RAISE NOTICE 'reset_smc_tenant_roles: smc has % member(s) -> % Owner, % Viewer', v_tot, v_own, v_view;

    IF v_own = 0 THEN
        RAISE EXCEPTION 'reset_smc_tenant_roles: none of the four named accounts hold an smc membership — refusing to leave the tenant without an Owner';
    END IF;

    -- ── 2. Copy the live table ──────────────────────────────────────────────
    EXECUTE 'CREATE TEMP TABLE "utr_reset_source" AS SELECT * FROM "user_tenant_roles"';

    SELECT count(*) INTO v_src  FROM "utr_reset_source";
    SELECT count(*) INTO v_live FROM "user_tenant_roles";
    IF v_src = 0 OR v_src <> v_live THEN
        RAISE EXCEPTION 'reset_smc_tenant_roles: refusing to truncate — copied % row(s) but the table holds %', v_src, v_live;
    END IF;
    RAISE NOTICE 'reset_smc_tenant_roles: % row(s) copied', v_src;

    -- ── 3. Truncate ───────────────────────────────────────────────────────────
    EXECUTE 'TRUNCATE TABLE "user_tenant_roles"';

    -- ── 4. Rebuild ────────────────────────────────────────────────────────────
    -- Ids, userId, tenantId, email, assignedAt and assignedBy are carried through
    -- verbatim — assignedBy and the audit trail reference these ids, and minting
    -- new cuids would orphan that history.
    INSERT INTO "user_tenant_roles" ("id", "userId", "tenantId", "email", "role", "roleId", "assignedAt", "assignedBy")
    SELECT
        s."id",
        s."userId",
        s."tenantId",
        s."email",
        -- role: rewritten inside smc, preserved everywhere else
        CASE
            WHEN s."tenantId" = v_smc
                 AND lower(s."email") IN ('arijitamin@smcindiaonline.com','divyanshuavasthi@smcindiaonline.com',
                                          'kartikchouhan@smcindiaonline.com','kartikmanimuthu@gmail.com')
                THEN 'Owner'
            WHEN s."tenantId" = v_smc
                THEN 'Viewer'
            ELSE s."role"
        END,
        -- roleId: derived from the role above, never copied
        CASE
            WHEN s."tenantId" = v_smc
                THEN NULL                                   -- Owner and Viewer are predefined
            WHEN s."role" IN ('Owner', 'Admin', 'Member', 'Viewer')
                THEN NULL
            ELSE (
                -- Tenant-local beats global. `ORDER BY (tenantId IS NULL)`, never
                -- `ORDER BY tenantId DESC` — Postgres sorts DESC with NULLS FIRST
                -- and would return precisely the wrong row.
                SELECT c."id" FROM "custom_roles" c
                 WHERE c."name" = s."role"
                   AND (c."tenantId" = s."tenantId" OR c."tenantId" IS NULL)
                 ORDER BY (c."tenantId" IS NULL)
                 LIMIT 1
            )
        END,
        s."assignedAt",
        s."assignedBy"
    FROM "utr_reset_source" s;

    -- ── 5. Assertions — any failure rolls the truncate back ──────────────────
    SELECT count(*) INTO v_src FROM "utr_reset_source";
    SELECT count(*) INTO v_new FROM "user_tenant_roles";
    IF v_src <> v_new THEN
        RAISE EXCEPTION 'reset_smc_tenant_roles: row count changed (% -> %), rolling back', v_src, v_new;
    END IF;

    IF EXISTS (SELECT 1 FROM "utr_reset_source" s
                WHERE NOT EXISTS (SELECT 1 FROM "user_tenant_roles" u WHERE u."id" = s."id")) THEN
        RAISE EXCEPTION 'reset_smc_tenant_roles: a membership id was lost, rolling back';
    END IF;

    SELECT count(*) INTO v_bad
      FROM "user_tenant_roles" utr JOIN "custom_roles" fk ON fk."id" = utr."roleId"
     WHERE utr."roleId" IS NOT NULL AND utr."role" IS NOT NULL AND utr."role" <> fk."name";
    IF v_bad > 0 THEN
        RAISE EXCEPTION 'reset_smc_tenant_roles: % row(s) mismatched after rebuild, rolling back', v_bad;
    END IF;

    SELECT count(*) INTO v_own FROM "user_tenant_roles" WHERE "tenantId" = v_smc AND "role" = 'Owner';
    IF v_own < 1 THEN
        RAISE EXCEPTION 'reset_smc_tenant_roles: smc left with no Owner, rolling back';
    END IF;

    -- The lockout invariant, per tenant: someone must still be able to
    -- administer permissions. Predefined Owner/Admin qualify; so does any custom
    -- role granting 'update' on Settings.
    SELECT count(*) INTO v_orphan
      FROM "tenants" t
     WHERE EXISTS (SELECT 1 FROM "user_tenant_roles" u WHERE u."tenantId" = t."id")
       AND NOT EXISTS (
           SELECT 1 FROM "user_tenant_roles" u
            LEFT JOIN "custom_roles" c ON c."id" = u."roleId"
            WHERE u."tenantId" = t."id"
              AND (u."role" IN ('Owner', 'Admin')
                   OR (c."permissions" -> 'Settings') ? 'update')
       );
    IF v_orphan > 0 THEN
        RAISE EXCEPTION 'reset_smc_tenant_roles: % tenant(s) would be left with nobody able to administer permissions, rolling back', v_orphan;
    END IF;

    RAISE NOTICE 'reset_smc_tenant_roles: % row(s) rebuilt, % Owner in smc, 0 mismatched, 0 tenants locked out', v_new, v_own;

    EXECUTE 'DROP TABLE "utr_reset_source"';

    -- ── 6. MANDATORY: invalidate the ability caches ──────────────────────────
    -- ability-cache.ts keys on `${rbac_global_version.version}.${tenants.rbacVersion}`
    -- and those entries are IMMUTABLE. principalCache (session-ability.ts:131) is
    -- keyed `tenantId:userId:version` and would keep serving the OLD role for the
    -- life of the process. Without this the reset appears to do nothing.
    UPDATE "tenants" SET "rbacVersion" = "rbacVersion" + 1;

    UPDATE "rbac_global_version" SET "version" = "version" + 1 WHERE "id" = 1;
    INSERT INTO "rbac_global_version" ("id", "version") VALUES (1, 1) ON CONFLICT ("id") DO NOTHING;
END $outer$;
