-- Drop the role CHECK constraint on user_tenant_roles.
-- The constraint (Owner/Admin/Member/Viewer) blocks custom roles created via the RBAC system.
-- Role validation is enforced at the application layer (invitation-service, custom-role-service).
ALTER TABLE "user_tenant_roles"
    DROP CONSTRAINT IF EXISTS "user_tenant_roles_role_check";
