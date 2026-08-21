-- Bumps the global RBAC version so the ability caches recompile and pick up the
-- 'Channel' subject added in 20260811120000_channel_subject_aiops.
--
-- ── WHY THIS IS A SEPARATE, MANDATORY STEP ─────────────────────────────────
-- lib/rbac/ability-cache.ts keys both its layers on the RBAC version returned by
-- registry.ts: `${rbac_global_version.version}.${tenants.rbacVersion}`. Those
-- entries are immutable by design — bumping the version does not clear the cache,
-- it makes the old keys unreachable. Nothing else invalidates them.
--
-- rbac_global_version is written ONLY by the registry-admin code paths (the role
-- and permission editors). No trigger watches rbac_subjects or
-- rbac_subject_modules, so a migration that seeds registry rows directly is
-- invisible to every already-running process: it keeps serving abilities compiled
-- under the old key, which were built before the new subject existed.
--
-- The symptom is precise and misleading: the rows are all correct in the
-- database, the rule compiler would expand the AIOps module grant onto 'Channel'
-- exactly as it does for KnowledgeBase and Skill (rule-compiler.ts:324,
-- `targets = subjectsByModuleId.get(module.id)`), and yet every Channel control
-- renders disabled and every channel route 403s — because no cached ability
-- contains a Channel rule at all. A holder of AIOps create+read+update sees the
-- same dead buttons as a Viewer.
--
-- The version probe refreshes every 5s, so this takes effect without a restart.
--
-- ANY future migration that inserts, updates or deletes rows in rbac_modules,
-- rbac_actions, rbac_subjects, rbac_subject_modules, rbac_module_actions or
-- rbac_role_rules must do this too. 20260806120000_iam_module did not, and would
-- have had the same problem had the deploy not replaced the running tasks.

UPDATE "rbac_global_version" SET "version" = "version" + 1 WHERE "id" = 1;

-- Defensive: the singleton row is created with a DEFAULT but never explicitly
-- seeded, so on a database where it is absent the UPDATE above is a silent no-op
-- and the cache would never invalidate.
INSERT INTO "rbac_global_version" ("id", "version")
VALUES (1, 1)
ON CONFLICT ("id") DO NOTHING;
