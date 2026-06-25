-- Add roleId FK to user_tenant_roles pointing to custom_roles.id
-- roleId is nullable: NULL for predefined roles (Owner/Admin/Member/Viewer),
-- populated for custom role assignments.

ALTER TABLE "user_tenant_roles" ADD COLUMN "roleId" TEXT;

CREATE INDEX "user_tenant_roles_roleId_idx" ON "user_tenant_roles"("roleId");

ALTER TABLE "user_tenant_roles"
    ADD CONSTRAINT "user_tenant_roles_roleId_fkey"
    FOREIGN KEY ("roleId") REFERENCES "custom_roles"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
