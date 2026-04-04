---
phase: quick
plan: 260403-wqs
type: execute
wave: 1
depends_on: []
files_modified:
  - prisma/schema.prisma
  - prisma/seed.ts
  - web-ui/lib/rbac/custom-role-service.ts
  - web-ui/app/api/tenants/route.ts
  - web-ui/app/api/settings/roles/route.ts
  - web-ui/app/app/settings/members/page.tsx
autonomous: true
requirements: []

must_haves:
  truths:
    - "Preset roles (Owner/Admin/Member/Viewer) exist once globally with tenantId=null, type=preset"
    - "Custom roles are tenant-scoped with type=custom"
    - "Roles page Predefined section shows DB preset roles; Custom section shows only type=custom rows"
    - "Preset roles have no edit/delete buttons"
    - "Invite dialog dropdown shows preset + tenant custom roles combined"
    - "New tenant creation assigns Owner roleId from global preset, no per-tenant role duplication"
  artifacts:
    - path: "prisma/schema.prisma"
      provides: "CustomRole with nullable tenantId + type field"
    - path: "prisma/seed.ts"
      provides: "Upserts 4 global preset roles"
    - path: "web-ui/lib/rbac/custom-role-service.ts"
      provides: "getCustomRoles filters type=custom; getCustomRolePermissions falls back to preset"
  key_links:
    - from: "web-ui/app/api/settings/roles/route.ts"
      to: "custom_roles WHERE type=preset"
      via: "getPresetRoles()"
    - from: "web-ui/app/api/tenants/route.ts"
      to: "custom_roles WHERE type=preset AND name=Owner"
      via: "prisma.customRole.findFirst({ where: { type: 'preset', name: 'Owner' } })"
---

<objective>
Segregate CustomRole rows into preset (global, tenantId=null) and custom (tenant-scoped) types.
Preset roles are seeded once globally; tenant creation no longer duplicates them per-tenant.
The roles UI and invite dropdown correctly split and display both types.

Purpose: Eliminate per-tenant duplication of Owner/Admin/Member/Viewer; enable clean role management UI.
Output: Schema migration, updated seed, service, two API routes, and members page.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
</execution_context>

<context>
@prisma/schema.prisma
@prisma/seed.ts
@web-ui/lib/rbac/custom-role-service.ts
@web-ui/app/api/tenants/route.ts
@web-ui/app/api/settings/roles/route.ts
@web-ui/app/app/settings/members/page.tsx

<interfaces>
<!-- CustomRole model (current) -->
model CustomRole {
  id          String   @id @default(cuid())
  tenantId    String           // will become String?
  name        String
  permissions Json
  level       Int      @default(1)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  createdBy   String
  userRoles   UserTenantRole[]
  @@unique([tenantId, name])   // will be replaced with partial indexes
  @@index([tenantId])
  @@map("custom_roles")
}

<!-- custom-role-service key functions -->
getCustomRoles(tenantId): CustomRoleOutput[]   // currently: findMany({ where: { tenantId } })
getCustomRolePermissions(roleName, tenantId)   // currently: findFirst({ where: { tenantId, name } })
createCustomRole count check: count({ where: { tenantId } })  // counts ALL roles incl. presets

<!-- roles API response shape (unchanged) -->
{ data: { predefined: RoleShape[], custom: CustomRoleOutput[] } }

<!-- members page role assembly (current) -->
const ALL_ROLES = ["Owner", "Admin", "Member", "Viewer"];  // hardcoded
const customFiltered = customRoles.filter(...).map(r => r.name);
const availableRoles = [...predefinedFiltered, ...customFiltered];
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Schema migration — add type field, make tenantId nullable, partial unique indexes</name>
  <files>prisma/schema.prisma</files>
  <action>
1. Edit `prisma/schema.prisma` — update the `CustomRole` model:
   - Add `type  String  @default("custom")` field (after `name`)
   - Change `tenantId  String` → `tenantId  String?`
   - Remove `@@unique([tenantId, name])` (Prisma can't express partial unique indexes)
   - Keep `@@index([tenantId])`

2. Run the migration:
   ```bash
   cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/multitenancy && npx prisma migrate dev --name add_role_type_preset
   ```

3. After migration is created, open the generated SQL file in `prisma/migrations/*/migration.sql` and append these statements at the end:

   ```sql
   -- Partial unique index: custom roles unique by (tenant_id, name) when tenant_id is not null
   CREATE UNIQUE INDEX custom_roles_tenant_name_unique
     ON custom_roles (tenant_id, name)
     WHERE tenant_id IS NOT NULL;

   -- Partial unique index: preset roles unique by name when tenant_id is null
   CREATE UNIQUE INDEX custom_roles_preset_name_unique
     ON custom_roles (name)
     WHERE tenant_id IS NULL;

   -- Data migration: remove per-tenant copies of preset roles
   -- UserTenantRole.role_id will be set to NULL via SetNull cascade (acceptable — role string field preserved)
   DELETE FROM custom_roles
     WHERE name IN ('Owner', 'Admin', 'Member', 'Viewer')
     AND tenant_id IS NOT NULL;
   ```

4. Re-run `npx prisma migrate dev` to apply the appended SQL, then run `npx prisma generate` to regenerate the client.

   Verify: `npx prisma studio` or query `SELECT * FROM custom_roles` — table should be empty (all per-tenant presets deleted).
  </action>
  <verify>
    <automated>cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/multitenancy && npx prisma validate && npx prisma generate 2>&1 | tail -5</automated>
  </verify>
  <done>Schema valid, client generated, migration applied, custom_roles table has type column and nullable tenant_id</done>
</task>

<task type="auto">
  <name>Task 2: Seed global presets + update service, tenant creation, roles API, members page</name>
  <files>
    prisma/seed.ts,
    web-ui/lib/rbac/custom-role-service.ts,
    web-ui/app/api/tenants/route.ts,
    web-ui/app/api/settings/roles/route.ts,
    web-ui/app/app/settings/members/page.tsx
  </files>
  <action>
**prisma/seed.ts** — replace the no-op with actual preset role upserts:
```typescript
import { PrismaClient } from '@prisma/client';
import { ROLE_PERMISSIONS, ROLE_LEVELS } from '../web-ui/lib/rbac/permissions';

const prisma = new PrismaClient();

async function main() {
    const presets = [
        { name: 'Owner', level: 4 },
        { name: 'Admin', level: 3 },
        { name: 'Member', level: 2 },
        { name: 'Viewer', level: 1 },
    ] as const;

    for (const p of presets) {
        await prisma.customRole.upsert({
            where: { id: `preset-${p.name.toLowerCase()}` },  // stable ID
            update: { permissions: ROLE_PERMISSIONS[p.name] as object, level: p.level },
            create: {
                id: `preset-${p.name.toLowerCase()}`,
                tenantId: null,
                type: 'preset',
                name: p.name,
                permissions: ROLE_PERMISSIONS[p.name] as object,
                level: p.level,
                createdBy: 'system',
            },
        });
    }
    console.log('Seed: 4 preset roles upserted (tenantId=null, type=preset).');
}

main().catch(console.error).finally(() => prisma.$disconnect());
```
Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/multitenancy && npx prisma db seed`

---

**web-ui/lib/rbac/custom-role-service.ts** — three changes:

1. `getCustomRoles`: filter to `type: 'custom'` only:
   ```typescript
   export async function getCustomRoles(tenantId: string): Promise<CustomRoleOutput[]> {
       const prisma = getPrismaClient();
       const roles = await prisma.customRole.findMany({
           where: { tenantId, type: 'custom' },
           orderBy: { name: 'asc' },
       });
       return roles.map(castRole);
   }
   ```

2. Add `getPresetRoles()`:
   ```typescript
   export async function getPresetRoles(): Promise<CustomRoleOutput[]> {
       const prisma = getPrismaClient();
       const roles = await prisma.customRole.findMany({
           where: { type: 'preset' },
           orderBy: { level: 'desc' },
       });
       return roles.map(castRole);
   }
   ```

3. `createCustomRole` count check — only count custom roles:
   ```typescript
   const count = await prisma.customRole.count({ where: { tenantId, type: 'custom' } });
   ```

4. `getCustomRolePermissions` — fall back to preset if not found in tenant:
   ```typescript
   export async function getCustomRolePermissions(roleName: string, tenantId: string): Promise<PermissionSet | null> {
       const prisma = getPrismaClient();
       // Try tenant-scoped custom role first
       const role = await prisma.customRole.findFirst({
           where: { OR: [{ tenantId, name: roleName }, { type: 'preset', name: roleName }] },
           orderBy: { type: 'asc' }, // 'custom' < 'preset' — prefer tenant custom if both exist
       });
       return role ? (role.permissions as PermissionSet) : null;
   }
   ```

Also update `castRole` to handle nullable tenantId — change the raw type signature:
```typescript
function castRole(raw: {
    id: string;
    tenantId: string | null;
    name: string;
    permissions: unknown;
    level: number;
    createdAt: Date;
    updatedAt: Date;
    createdBy: string;
}): CustomRoleOutput {
    return { ...raw, tenantId: raw.tenantId ?? '', permissions: raw.permissions as PermissionSet };
}
```

---

**web-ui/app/api/tenants/route.ts** — remove per-tenant role seeding; look up global preset Owner:

Replace the `defaultRoles` createMany block and the `ownerRole` findFirst with:
```typescript
// Look up the global preset Owner role (seeded once globally)
const ownerRole = await tx.customRole.findFirst({
    where: { type: 'preset', name: 'Owner' },
});

await tx.userTenantRole.create({
    data: {
        userId: session.user.id,
        tenantId: tenant.id,
        email: session.user.email,
        role: 'Owner',
        roleId: ownerRole?.id ?? null,
        assignedBy: session.user.id,
    },
});
```
Remove the entire `defaultRoles` array and `tx.customRole.createMany(...)` call.

---

**web-ui/app/api/settings/roles/route.ts** — fetch preset roles from DB instead of hardcoded constant:

```typescript
import { createCustomRole, getCustomRoles, getPresetRoles } from '@/lib/rbac/custom-role-service';
// Remove: import { ROLE_PERMISSIONS, ROLE_LEVELS } from '@/lib/rbac/permissions';
// Remove: import type { PermissionSet, PredefinedRole } from '@/lib/rbac/types';

// In GET handler, replace the hardcoded predefined block:
const tenantId = await getSessionTenantId();
const [customRoles, presetRoles] = await Promise.all([
    getCustomRoles(tenantId),
    getPresetRoles(),
]);

return NextResponse.json({
    success: true,
    data: { predefined: presetRoles, custom: customRoles },
});
```

---

**web-ui/app/app/settings/members/page.tsx** — use predefined from API instead of hardcoded ALL_ROLES:

1. Remove `const ALL_ROLES = ["Owner", "Admin", "Member", "Viewer"];`
2. Change `customRoles` state to hold both predefined and custom:
   ```typescript
   const [predefinedRoles, setPredefinedRoles] = useState<{ name: string; level: number }[]>([]);
   const [customRoles, setCustomRoles] = useState<{ name: string; level: number }[]>([]);
   ```
3. Update `fetchRoles`:
   ```typescript
   const fetchRoles = useCallback(async () => {
       try {
           const res = await fetch("/api/settings/roles");
           const json = await res.json();
           if (!res.ok || !json.success) return;
           const predefined = (json.data?.predefined ?? []) as { name: string; level: number }[];
           const custom = (json.data?.custom ?? []) as { name: string; level: number }[];
           setPredefinedRoles(predefined);
           setCustomRoles(custom);
       } catch { /* non-blocking */ }
   }, []);
   ```
4. Update role assembly:
   ```typescript
   const predefinedFiltered = predefinedRoles.filter((r) => r.level <= userLevel).map((r) => r.name);
   const customFiltered = customRoles.filter((r) => r.level <= userLevel).map((r) => r.name);
   const availableRoles = [...predefinedFiltered, ...customFiltered];
   ```
  </action>
  <verify>
    <automated>cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/multitenancy/web-ui && npm run build 2>&1 | tail -20</automated>
  </verify>
  <done>
    - Seed runs without error, 4 preset rows in custom_roles with tenantId=null, type=preset
    - POST /api/tenants creates tenant + assigns Owner roleId from global preset (no per-tenant role rows)
    - GET /api/settings/roles returns preset roles from DB in predefined array
    - Roles page Predefined section shows 4 preset roles (no edit/delete); Custom section shows only type=custom
    - Invite dialog dropdown shows preset + custom roles combined
    - Build passes with no TypeScript errors
  </done>
</task>

</tasks>

<verification>
After both tasks:
1. Run seed: `npx prisma db seed` — should log "4 preset roles upserted"
2. Query DB: `SELECT id, tenant_id, type, name FROM custom_roles ORDER BY type, name` — should show 4 preset rows (tenant_id=null) and any custom rows with tenant_id set
3. Create a new tenant via UI — verify no new rows appear in custom_roles for that tenant
4. Visit /app/settings/roles — Predefined section shows Owner/Admin/Member/Viewer without edit buttons; Custom section empty (or shows actual custom roles)
5. Open Invite Member dialog — dropdown shows Owner/Admin/Member/Viewer plus any custom roles
</verification>

<success_criteria>
- `custom_roles` table has `type` column and nullable `tenant_id`
- Preset roles exist exactly once globally (4 rows, tenant_id=null)
- No per-tenant copies of preset roles are created on tenant creation
- Roles UI correctly segregates preset vs custom with appropriate edit controls
- Invite dropdown shows all available roles (preset + tenant custom)
- `npm run build` passes
</success_criteria>

<output>
After completion, create `.planning/quick/260403-wqs-add-preset-custom-type-segregation-to-cu/260403-wqs-SUMMARY.md`
</output>
