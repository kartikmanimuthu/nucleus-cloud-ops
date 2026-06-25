-- Fix role CHECK constraint on user_tenant_roles
-- Old constraint allowed: 'SuperAdmin','TenantAdmin','TenantOperator','TenantViewer'
-- New RBAC system uses: 'Owner','Admin','Member','Viewer'

-- Step 1: Drop old constraint first (allows old values during data migration)
ALTER TABLE "user_tenant_roles"
    DROP CONSTRAINT IF EXISTS "user_tenant_roles_role_check";

-- Step 2: Migrate existing rows to new role names
UPDATE "user_tenant_roles" SET role = 'Owner'  WHERE role = 'SuperAdmin';
UPDATE "user_tenant_roles" SET role = 'Admin'  WHERE role = 'TenantAdmin';
UPDATE "user_tenant_roles" SET role = 'Member' WHERE role = 'TenantOperator';
UPDATE "user_tenant_roles" SET role = 'Viewer' WHERE role = 'TenantViewer';

-- Step 3: Add new constraint with updated role names
ALTER TABLE "user_tenant_roles"
    ADD CONSTRAINT "user_tenant_roles_role_check"
    CHECK (role IN ('Owner','Admin','Member','Viewer'));
