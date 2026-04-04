-- Partial unique index: custom roles unique by (tenantId, name) when tenantId is not null
CREATE UNIQUE INDEX custom_roles_tenant_name_unique
  ON custom_roles ("tenantId", name)
  WHERE "tenantId" IS NOT NULL;

-- Partial unique index: preset roles unique by name when tenantId is null
CREATE UNIQUE INDEX custom_roles_preset_name_unique
  ON custom_roles (name)
  WHERE "tenantId" IS NULL;

-- Data migration: remove per-tenant copies of preset roles
-- UserTenantRole.roleId will be set to NULL via SetNull cascade (role string field preserved)
DELETE FROM custom_roles
  WHERE name IN ('Owner', 'Admin', 'Member', 'Viewer')
  AND "tenantId" IS NOT NULL;
