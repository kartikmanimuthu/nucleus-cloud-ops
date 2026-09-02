-- Backfills navPath for the five subjects that 20260812100000 could only ever
-- set on INSERT.
--
-- ── THE GAP ─────────────────────────────────────────────────────────────────
-- 20260812100000_subject_nav_paths handled its subjects two different ways:
--
--   * the 18 subjects that already existed got
--         UPDATE ... SET navPath = '...' WHERE key = 'X' AND navPath IS NULL
--     which is idempotent and re-runnable, and
--
--   * the 5 subjects it INTRODUCED (Provider, AgentOps, ScheduledTask,
--     McpServer, ScalingAudit) got their navPath only as a column in
--         INSERT ... ON CONFLICT ("id") DO NOTHING
--
-- For that second group the navPath is applied only if the row did not already
-- exist. When it did, ON CONFLICT skipped the row and navPath stayed NULL --
-- and no later migration revisits it. 20260813000000_scaling_audit_subject:41
-- documents exactly that precondition ("a database where someone hand-inserted
-- this subject to work around the 403 stays valid"), and its own INSERT omits
-- navPath entirely, so it cannot repair the row either.
--
-- ── WHY A NULL navPath IS NOT COSMETIC ──────────────────────────────────────
-- resolveNavOwner() matches a destination by navPath. With none, NOTHING claims
-- /app/cloud-operations/scale-sentinel, and useNavGate's canSeeHref returns
-- TRUE for an unclaimed href (use-can.ts:142-147 -- deliberate: failing closed
-- there would blank the sidebar for any route the registry has not been taught).
-- lib/nav-config.ts carried no `module` annotation for Scale Sentinel either, so
-- both fail-closed paths were absent and the entry rendered for EVERY role,
-- including one with no Inventory grant at all.
--
-- Not a data leak: every /api/scaling-audit/* route enforces
-- authorize(..., 'ScalingAudit'), which resolves through the legacy matrix to
-- Inventory while DYNAMIC_ABAC_ENABLED is false. The link led to a page whose
-- data calls 403'd -- a dead end, not an exposure.
--
-- Written as UPDATE ... WHERE navPath IS NULL, matching the idiom of the 18 rows
-- that were done correctly: a tenant that has since authored its own navPath is
-- never clobbered, and re-running this is a no-op.

UPDATE "rbac_subjects" SET "navPath" = '/app/agent-ops/providers',              "sortOrder" = 70 WHERE "key" = 'Provider'      AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/agent-ops',                        "sortOrder" = 20 WHERE "key" = 'AgentOps'      AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/agent-ops/scheduled-tasks',        "sortOrder" = 30 WHERE "key" = 'ScheduledTask' AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/agent-ops/mcp-settings',           "sortOrder" = 90 WHERE "key" = 'McpServer'     AND "navPath" IS NULL;
UPDATE "rbac_subjects" SET "navPath" = '/app/cloud-operations/scale-sentinel',  "sortOrder" = 40 WHERE "key" = 'ScalingAudit'  AND "navPath" IS NULL;

-- ── MANDATORY: invalidate the ability caches ────────────────────────────────
-- ability-cache.ts keys both layers on
-- `${rbac_global_version.version}.${tenants.rbacVersion}` and those entries are
-- immutable -- bumping the version does not clear the cache, it makes the old
-- keys unreachable. Without this, every running task keeps serving abilities
-- (and the `subjects` payload behind nav gating) compiled before these navPaths
-- existed, so the sidebar would not change until the next deploy.
UPDATE "rbac_global_version" SET "version" = "version" + 1 WHERE "id" = 1;
INSERT INTO "rbac_global_version" ("id", "version") VALUES (1, 1) ON CONFLICT ("id") DO NOTHING;
