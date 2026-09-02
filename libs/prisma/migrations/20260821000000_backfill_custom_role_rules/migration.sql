-- Projects every tenant custom role's legacy `permissions` blob onto
-- `rbac_role_rules`, so a role grants under CASL exactly what it grants under the
-- legacy matrix. This is `apps/web-ui/scripts/backfill-rbac.ts` as a migration.
--
-- ── WHY THIS HAS TO BE A MIGRATION ──────────────────────────────────────────
-- `apps/web-ui/docker-entrypoint.sh:11` runs `prisma migrate deploy` and nothing
-- else. The seed never runs in production and neither does backfill-rbac.ts --
-- its own header calls it "one-shot, run manually against production". So the
-- blob -> rules projection was the ONE piece of RBAC data setup with no automatic
-- path into a deployed environment, and the two places that do perform it both
-- require a human:
--
--   * `lib/rbac/role-rule-sync.ts` -- runs inside createCustomRole /
--     updateCustomRole, so it only covers roles someone has saved through the
--     Roles UI SINCE that module shipped. A role created before it, and never
--     re-saved, has whatever rules existed at the time and no more.
--   * `scripts/backfill-rbac.ts` -- never invoked by any deploy step.
--
-- Migrations DO run on every environment, which is the whole argument
-- docs/rbac-registry-migrations.md makes for registry rows. The same argument
-- applies to this projection, and this migration is what closes the gap.
--
-- ── THE BUG THIS REPAIRS ────────────────────────────────────────────────────
-- The sidebar reads compiled CASL rules unconditionally: /api/me/ability ->
-- session-ability.ts -> ability-cache.ts, with no DYNAMIC_ABAC_ENABLED check
-- anywhere on that path. `authorize()` reads the legacy blob whenever the flag is
-- false (authorize.ts:187). A role whose blob and rules disagree therefore gets a
-- page it can open with no nav entry pointing at it -- reported against
-- /app/cost-optimization/spot-guard, where `read SpotGuard` was absent from the
-- rules while `Schedules: [read]` was present in the blob.
--
-- Once DYNAMIC_ABAC_ENABLED is true the same drift stops being a cosmetic
-- mismatch and becomes a 403 on a page that worked the day before. This
-- migration must therefore be APPLIED BEFORE THAT FLAG FLIPS, which -- being a
-- migration -- it is: the entrypoint runs migrate deploy before starting Next.
--
-- ── SCOPE, AND WHAT IS DELIBERATELY LEFT OUT ────────────────────────────────
--
-- 1. INSERT ONLY. Never deletes. A rule present here but absent from the blob is
--    reported below as a WARNING, not removed. `role-rule-sync.ts` does delete
--    (that is how unticking a box revokes), but it does so with a UI-supplied
--    blob it can trust. A migration deleting rules would fire on every
--    environment against blobs it cannot vet -- and a role whose blob is `{}`
--    (every preset, per 20260730000000, and any role authored after Workstream J
--    drops the column) would have its rules silently wiped. Additive is the only
--    safe direction for an unattended repair.
--
-- 2. CRUD VERBS ONLY -- 'create', 'read', 'update', 'delete'. This deliberately
--    does NOT expand the ACTION_MAP aliases ('manage', 'execute', 'approve',
--    'export', 'validate', 'use') the way role-rule-sync.ts does, and it matches
--    backfill-rbac.ts's own CRUD filter.
--
--    Expanding them would WIDEN grants at cutover. legacyDecision() resolves the
--    REQUESTED action through ACTION_MAP and then looks for it literally in the
--    blob (permissions.ts:78), so a blob holding `['manage']` grants nothing
--    under the legacy matrix -- `hasCustomPermission(perms, 'delete', M)` asks
--    whether the array contains 'delete', and it does not. Expanding 'manage' to
--    four rules here would hand that role delete rights it does not have today.
--    Parity is the point of this migration; anything else is a permission change
--    wearing a repair's clothing. Non-CRUD verbs are reported below instead.
--
-- 3. `custom_roles.level` IS NOT TOUCHED. backfill-rbac.ts pins it from
--    getAutoLevel() (its step 2, the D-8 concern). That is a count-threshold
--    derivation over the registry's grantable cells, it feeds canAssignRole(),
--    and reimplementing it in SQL to run unattended on every environment is a
--    privilege-adjacent calculation with no upside here. The roles UI already
--    recomputes level on every save.
--
-- 4. Subject-level rules (`subjectId IS NOT NULL`) and `cannot` rules
--    (`inverted = true`) are untouched, matching role-rule-sync.ts's scope.
--    Record<Module, Action[]> cannot express either, so the blob has no opinion
--    about them and this migration must not invent one.
--
-- 5. Preset roles (`isSystem = true`) are skipped. Their rules are seeded by
--    20260730000000_dynamic_abac and their blob is deliberately '{}'::jsonb, so
--    projecting it would mean projecting nothing.
--
-- Re-runnable: additive, with untargeted ON CONFLICT DO NOTHING (invariant 2 in
-- docs/rbac-registry-migrations.md -- the real guard here is the PARTIAL unique
-- index `rbac_role_rules_module_target_key` on ("roleId","actionId","moduleId")
-- WHERE "subjectId" IS NULL, since the composite unique does not constrain rows
-- with a NULL subjectId at all; see 20260730000000:226-234).

-- ── 1. Report blob entries that cannot be resolved ──────────────────────────
-- backfill-rbac.ts warns and skips on these (its lines 112, 118). Silence would
-- turn "this role is missing a module" into "this module key is a typo nobody
-- ever saw".
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT cr."name" AS role_name, blob.module_key
          FROM "custom_roles" cr
          CROSS JOIN LATERAL jsonb_each(
              CASE WHEN jsonb_typeof(cr."permissions") = 'object'
                   THEN cr."permissions" ELSE '{}'::jsonb END
          ) AS blob(module_key, verbs)
         WHERE cr."isSystem" = false
           AND NOT EXISTS (
               SELECT 1 FROM "rbac_modules" m
                WHERE m."key" = blob.module_key
                  AND m."enabled"
                  AND (m."tenantId" = cr."tenantId" OR m."tenantId" IS NULL)
           )
    LOOP
        RAISE NOTICE 'backfill_custom_role_rules: role "%" references module "%" which is absent or disabled in the registry - skipped',
            r.role_name, r.module_key;
    END LOOP;

    FOR r IN
        SELECT DISTINCT cr."name" AS role_name, v.verb
          FROM "custom_roles" cr
          CROSS JOIN LATERAL jsonb_each(
              CASE WHEN jsonb_typeof(cr."permissions") = 'object'
                   THEN cr."permissions" ELSE '{}'::jsonb END
          ) AS blob(module_key, verbs)
          CROSS JOIN LATERAL jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(blob.verbs) = 'array'
                   THEN blob.verbs ELSE '[]'::jsonb END
          ) AS v(verb)
         WHERE cr."isSystem" = false
           AND v.verb NOT IN ('create', 'read', 'update', 'delete')
    LOOP
        RAISE NOTICE 'backfill_custom_role_rules: role "%" carries non-CRUD verb "%" - NOT expanded, see note 2 in this migration',
            r.role_name, r.verb;
    END LOOP;
END $$;

-- ── 2. The projection ───────────────────────────────────────────────────────
-- Module and action keys resolve tenant-override-beats-global, the same
-- precedence as role-rule-sync.ts's indexByKey() and registry.ts's mergeByKey().
-- Expressed as `ORDER BY (tenantId IS NULL) LIMIT 1` because a plain
-- `ORDER BY "tenantId" DESC` sorts NULLS FIRST in PostgreSQL and would pick the
-- global row precisely when a tenant override exists -- the exact trap
-- role-rule-sync.ts:86-93 documents.
--
-- The id is derived rather than random so re-running is a no-op on the primary
-- key as well as on the partial unique index (invariant 1).
INSERT INTO "rbac_role_rules" (
    "id", "tenantId", "roleId", "actionId", "moduleId", "subjectId",
    "inverted", "createdBy", "createdAt", "updatedAt"
)
SELECT
    'bf-role-rule-' || cr."id" || '-' || m."id" || '-' || a."id",
    cr."tenantId",
    cr."id",
    a."id",
    m."id",
    NULL::TEXT,
    false,
    'migration:20260821000000',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "custom_roles" cr
CROSS JOIN LATERAL jsonb_each(
    CASE WHEN jsonb_typeof(cr."permissions") = 'object'
         THEN cr."permissions" ELSE '{}'::jsonb END
) AS blob(module_key, verbs)
CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(blob.verbs) = 'array'
         THEN blob.verbs ELSE '[]'::jsonb END
) AS v(verb)
JOIN LATERAL (
    SELECT mm."id"
      FROM "rbac_modules" mm
     WHERE mm."key" = blob.module_key
       AND mm."enabled"
       AND (mm."tenantId" = cr."tenantId" OR mm."tenantId" IS NULL)
     ORDER BY (mm."tenantId" IS NULL)
     LIMIT 1
) m ON true
JOIN LATERAL (
    SELECT aa."id"
      FROM "rbac_actions" aa
     WHERE aa."key" = v.verb
       AND (aa."tenantId" = cr."tenantId" OR aa."tenantId" IS NULL)
     ORDER BY (aa."tenantId" IS NULL)
     LIMIT 1
) a ON true
WHERE cr."isSystem" = false
  AND v.verb IN ('create', 'read', 'update', 'delete')
ON CONFLICT DO NOTHING;

-- ── 3. Post-conditions, reported never enforced ─────────────────────────────
-- RAISE WARNING, not EXCEPTION. A failed migration here would abort
-- `migrate deploy`, and docker-entrypoint.sh exits the container after 10 failed
-- attempts -- turning a permissions report into an outage. The deploy log is the
-- right severity for this.
DO $$
DECLARE
    v_missing INT;
    v_extra   INT;
BEGIN
    -- Should be 0: every CRUD grant in a blob now has a rule.
    --
    -- Resolves module and action through the SAME `ORDER BY (tenantId IS NULL)
    -- LIMIT 1` lateral the projection uses. A plain join on
    -- `(m."tenantId" = cr."tenantId" OR m."tenantId" IS NULL)` would match BOTH
    -- rows wherever a tenant override shadows a global key, and then report the
    -- global one as missing a rule that was never supposed to exist.
    SELECT count(*) INTO v_missing
      FROM "custom_roles" cr
      CROSS JOIN LATERAL jsonb_each(
          CASE WHEN jsonb_typeof(cr."permissions") = 'object'
               THEN cr."permissions" ELSE '{}'::jsonb END
      ) AS blob(module_key, verbs)
      CROSS JOIN LATERAL jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(blob.verbs) = 'array'
               THEN blob.verbs ELSE '[]'::jsonb END
      ) AS v(verb)
      JOIN LATERAL (
          SELECT mm."id"
            FROM "rbac_modules" mm
           WHERE mm."key" = blob.module_key
             AND mm."enabled"
             AND (mm."tenantId" = cr."tenantId" OR mm."tenantId" IS NULL)
           ORDER BY (mm."tenantId" IS NULL)
           LIMIT 1
      ) m ON true
      JOIN LATERAL (
          SELECT aa."id"
            FROM "rbac_actions" aa
           WHERE aa."key" = v.verb
             AND (aa."tenantId" = cr."tenantId" OR aa."tenantId" IS NULL)
           ORDER BY (aa."tenantId" IS NULL)
           LIMIT 1
      ) a ON true
     WHERE cr."isSystem" = false
       AND v.verb IN ('create', 'read', 'update', 'delete')
       AND NOT EXISTS (
           SELECT 1 FROM "rbac_role_rules" rr
            WHERE rr."roleId" = cr."id"
              AND rr."actionId" = a."id"
              AND rr."moduleId" = m."id"
              AND rr."subjectId" IS NULL
              AND rr."inverted" = false
       );

    -- The OTHER drift direction, which this migration cannot fix by design (see
    -- note 1). A module-level grant in the rules with nothing behind it in the
    -- blob is a role that GAINS access when DYNAMIC_ABAC_ENABLED flips. Worth a
    -- human look before that deploy; it is not always wrong, because
    -- role-rule-sync.ts expands aliases the blob then no longer reflects.
    SELECT count(*) INTO v_extra
      FROM "rbac_role_rules" rr
      JOIN "custom_roles" cr ON cr."id" = rr."roleId"
      JOIN "rbac_modules"  m ON m."id"  = rr."moduleId"
      JOIN "rbac_actions"  a ON a."id"  = rr."actionId"
     WHERE rr."subjectId" IS NULL
       AND rr."inverted" = false
       AND cr."isSystem" = false
       AND NOT jsonb_exists(
           CASE WHEN jsonb_typeof(cr."permissions") = 'object'
                     AND jsonb_typeof(cr."permissions" -> m."key") = 'array'
                THEN cr."permissions" -> m."key"
                ELSE '[]'::jsonb END,
           a."key"
       );

    IF v_missing > 0 THEN
        RAISE WARNING 'backfill_custom_role_rules: % blob grant(s) still have no rule after the projection - investigate before flipping DYNAMIC_ABAC_ENABLED', v_missing;
    ELSE
        RAISE NOTICE 'backfill_custom_role_rules: every CRUD blob grant now has a matching rule';
    END IF;

    IF v_extra > 0 THEN
        RAISE WARNING 'backfill_custom_role_rules: % rule(s) grant more than the legacy blob does; these roles GAIN access at cutover - review, this migration never deletes', v_extra;
    END IF;
END $$;

-- ── 4. MANDATORY: invalidate the ability caches ─────────────────────────────
-- ability-cache.ts keys both levels on
-- `${rbac_global_version.version}.${tenants.rbacVersion}` and those entries are
-- IMMUTABLE -- bumping does not clear the cache, it makes the old keys
-- unreachable. Without this, every running task keeps serving abilities compiled
-- before these rules existed and a correct database still hides the nav entry.
-- The version probe refreshes every 5s, so this applies without a restart.
--
-- Bumped globally rather than per-tenant (backfill-rbac.ts:202-209 increments
-- tenants.rbacVersion) because the key concatenates both: one global bump
-- invalidates every tenant, and this migration can touch any of them.
UPDATE "rbac_global_version" SET "version" = "version" + 1 WHERE "id" = 1;
-- Defensive: the singleton is created by DEFAULT but never explicitly seeded, so
-- where it is absent the UPDATE above is a silent no-op and nothing invalidates.
INSERT INTO "rbac_global_version" ("id", "version") VALUES (1, 1) ON CONFLICT ("id") DO NOTHING;
