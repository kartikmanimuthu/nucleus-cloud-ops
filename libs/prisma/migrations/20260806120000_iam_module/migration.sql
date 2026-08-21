-- Splits Members / Roles / Permissions / Modules off the general "Settings"
-- module into their own "IAM" module — the RBAC/IAM administration surface
-- moved into its own top-level nav section (see 2026-08-06 IAM nav plan) but
-- was still gated by the same generic 'Settings' subject as billing, logo and
-- certificates, and the dedicated 'Role' subject seeded in 20260730000000 was
-- never referenced by any route. This migration gives IAM its own module so
-- it can be granted/revoked independently of general tenant settings.
--
-- Same shape as the six modules seeded in 20260730000000_dynamic_abac: a
-- module row, a module-wide subject row (mirroring 'AIOps'/'Settings'), the
-- CRUD grid, and preset-role grants byte-for-byte matching what Settings
-- already had for these roles (permissions.ts ROLE_PERMISSIONS.*.IAM).
--
-- 'User' and 'Role' (already-seeded subjects) are repointed from Settings to
-- IAM. Repointing (not inserting a new global row) is correct here: this is a
-- one-time system-wide realignment, not a tenant-local override, and
-- rbac_subject_modules has a global-uniqueness index on subjectId alone
-- (rbac_subject_modules_global_key), so a second global row for the same
-- subject would violate it. 'Tenant', 'Billing', 'Certificate' and the
-- module-wide 'Settings' subject are unaffected and stay under Settings.

-- ── Module ─────────────────────────────────────────────────────────────────

INSERT INTO "rbac_modules" ("id", "tenantId", "key", "label", "description", "icon", "navPath", "sortOrder", "isSystem") VALUES
    ('sys-mod-iam', NULL, 'IAM', 'IAM', 'Members, roles, permissions and modules', 'ShieldCheck', '/app/iam', 45, true)
ON CONFLICT ("id") DO NOTHING;

-- ── Module-wide subject — same pattern as sys-subj-aiops / sys-subj-settings ─
-- Several routes (settings/rbac/modules, settings/rbac/permissions,
-- settings/rbac/registry) authorize against the module itself rather than a
-- specific resource, same as authorize('update', 'AIOps') elsewhere.

INSERT INTO "rbac_subjects" ("id", "tenantId", "key", "label", "kind", "isSystem") VALUES
    ('sys-subj-iam', NULL, 'IAM', 'IAM (module-wide)', 'resource', true)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "rbac_subject_modules" ("id", "tenantId", "subjectId", "moduleId") VALUES
    ('sys-sm-iam', NULL, 'sys-subj-iam', 'sys-mod-iam')
ON CONFLICT ("id") DO NOTHING;

-- ── Repoint User/Role off Settings, onto IAM ──────────────────────────────
-- rbac_protect_system_rows() only blocks changing key/isSystem on a system
-- row (or deleting it) — updating moduleId on rbac_subject_modules is
-- untouched by that trigger, and rbac_subject_modules carries no protect
-- trigger of its own.

UPDATE "rbac_subject_modules"
   SET "moduleId" = 'sys-mod-iam'
 WHERE "subjectId" IN ('sys-subj-user', 'sys-subj-role')
   AND "tenantId" IS NULL;

-- ── CRUD grid for the new module ─────────────────────────────────────────

INSERT INTO "rbac_module_actions" ("id", "tenantId", "moduleId", "actionId", "grantable")
SELECT
    'sys-ma-IAM-' || a."key",
    NULL,
    'sys-mod-iam',
    a."id",
    true
FROM "rbac_actions" a
WHERE a."tenantId" IS NULL
  AND a."key" IN ('create', 'read', 'update', 'delete')
ON CONFLICT ("id") DO NOTHING;

-- ── Preset grants — byte-for-byte what Settings already gave these roles ────
-- Owner CRUD, Admin CRU (no delete), Member R, Viewer R — see
-- permissions.ts ROLE_PERMISSIONS.*.IAM.

INSERT INTO "rbac_role_rules" ("id", "tenantId", "roleId", "actionId", "moduleId", "createdBy")
SELECT
    'sys-rule-' || g.role_id || '-IAM-' || act,
    NULL,
    g.role_id,
    a."id",
    'sys-mod-iam',
    'system'
FROM (VALUES
    ('preset-owner',  ARRAY['create', 'read', 'update', 'delete']),
    ('preset-admin',  ARRAY['create', 'read', 'update']),
    ('preset-member', ARRAY['read']),
    ('preset-viewer', ARRAY['read'])
) AS g(role_id, actions)
CROSS JOIN LATERAL unnest(g.actions) AS act
JOIN "rbac_actions" a ON a."key" = act AND a."tenantId" IS NULL
JOIN "custom_roles" r ON r."id" = g.role_id
ON CONFLICT ("id") DO NOTHING;
