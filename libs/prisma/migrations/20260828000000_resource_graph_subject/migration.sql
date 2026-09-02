-- Registers 'ResourceGraph' as an RBAC subject under Inventory.
-- Same omission as 20260813000000_scaling_audit_subject: the routes shipped
-- gating on this subject but no registry row existed, so with DYNAMIC_ABAC_ENABLED
-- the compiled ability never mentions it and every principal below SuperAdmin 403s.
-- Read-only subject (no update/delete call site), so it inherits Inventory's
-- preset grants and needs no new rbac_role_rules.

INSERT INTO "rbac_subjects" ("id", "tenantId", "key", "label", "kind", "isSystem") VALUES
    ('sys-subj-resourcegraph', NULL, 'ResourceGraph', 'Resource Graph', 'resource', true)
ON CONFLICT DO NOTHING;

INSERT INTO "rbac_subject_modules" ("id", "tenantId", "subjectId", "moduleId") VALUES
    ('sys-sm-resourcegraph', NULL, 'sys-subj-resourcegraph', 'sys-mod-inventory')
ON CONFLICT DO NOTHING;

-- Mandatory: ability caches are keyed on the version and immutable, so without
-- this bump running tasks keep serving abilities compiled before the subject existed.
UPDATE "rbac_global_version" SET "version" = "version" + 1 WHERE "id" = 1;

INSERT INTO "rbac_global_version" ("id", "version")
VALUES (1, 1)
ON CONFLICT ("id") DO NOTHING;
