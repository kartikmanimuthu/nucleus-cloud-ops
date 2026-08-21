-- Registers 'ScalingAudit' (Scale Sentinel) as an RBAC subject under Inventory.
--
-- ── THE BUG ────────────────────────────────────────────────────────────────
-- 20260805120000_add_scaling_audit and its five follow-ups created the tables,
-- the anti-DELETE trigger and the enrichment columns, but never inserted the
-- registry rows. Eleven routes gate on this subject —
--   app/api/scaling-audit/{events,events/[id],export,resources,runs,summary}
--   app/api/capacity-planning/{breaches,runs,summary}   (same subject key)
-- — and with DYNAMIC_ABAC_ENABLED=true the CASL ability is compiled ONLY from
-- registry rows. No rbac_subjects row means no compiled rule mentioning
-- 'ScalingAudit', so ability.can('read','ScalingAudit') is false for every
-- principal except SuperAdmin (authorize.ts:180). Owner 403s exactly like Viewer.
--
-- It failed silently in two ways. `dropped` only reports rules that REFERENCE a
-- missing registry row; here nothing referenced it at all, so no
-- '[rbac] rules dropped' line ever appeared and the 403 carried no reason. And
-- the legacy matrix disagreed but was not consulted: SUBJECT_TO_MODULE already
-- maps ScalingAudit -> Inventory (types.ts:82), so with the flag off this works.
-- Only the dynamic path breaks — a parity mismatch that a shadow-mode soak would
-- have logged.
--
-- ── WHY INVENTORY, AND WHY NO NEW GRANTS ───────────────────────────────────
-- Same reasoning as sys-subj-rightsizing, which already hangs off this module
-- (20260730000000_dynamic_abac:504): Scale Sentinel reads AWS scaling-activity
-- history and writes advisory/audit rows, and never calls a mutating AWS API.
--
-- The compiler expands a module grant onto every subject of that module
-- (rule-compiler.ts:324, `targets = subjectsByModuleId.get(module.id)`), so
-- attaching to sys-mod-inventory inherits the preset rules Inventory already
-- carries — Owner/Admin CRUD, Member CRU, Viewer R — with no new rbac_role_rules
-- and no new rbac_module_actions. That lines up with the call sites: 'read' on
-- the nine query routes, 'update' on the two on-demand poll routes, so a Viewer
-- can read the audit but cannot trigger a poll.
--
-- Inventory's action set includes 'delete', inert here by construction: the
-- repository exposes no delete method and the database rejects DELETE on
-- scaling_events via a trigger (20260805120000_add_scaling_audit). This is the
-- same honest-existing-mapping tradeoff documented at types.ts:73.
--
-- ON CONFLICT is untargeted so it covers both the primary key and the partial
-- global unique indexes (rbac_subjects_global_key /
-- rbac_subject_modules_global_key, dynamic_abac:244-245) — a database where
-- someone hand-inserted this subject to work around the 403 stays valid.

INSERT INTO "rbac_subjects" ("id", "tenantId", "key", "label", "kind", "isSystem") VALUES
    ('sys-subj-scalingaudit', NULL, 'ScalingAudit', 'Scale Sentinel', 'resource', true)
ON CONFLICT DO NOTHING;

INSERT INTO "rbac_subject_modules" ("id", "tenantId", "subjectId", "moduleId") VALUES
    ('sys-sm-scalingaudit', NULL, 'sys-subj-scalingaudit', 'sys-mod-inventory')
ON CONFLICT DO NOTHING;

-- ── MANDATORY: invalidate the ability caches ───────────────────────────────
-- ability-cache.ts keys both layers on `${rbac_global_version}.${tenants.rbacVersion}`
-- and those entries are immutable — bumping the version does not clear them, it
-- makes the old keys unreachable. rbac_global_version is written only by the
-- registry-admin code paths; no trigger watches rbac_subjects. Without this bump
-- every running task keeps serving abilities compiled before the subject existed,
-- and the 403 survives a correct database. See the full write-up in
-- 20260811130000_bump_rbac_version_channel_subject. The probe refreshes every 5s,
-- so this applies without a restart.

UPDATE "rbac_global_version" SET "version" = "version" + 1 WHERE "id" = 1;

-- Defensive: the singleton is created by DEFAULT but never explicitly seeded, so
-- where it is absent the UPDATE above is a silent no-op and nothing invalidates.
INSERT INTO "rbac_global_version" ("id", "version")
VALUES (1, 1)
ON CONFLICT ("id") DO NOTHING;
