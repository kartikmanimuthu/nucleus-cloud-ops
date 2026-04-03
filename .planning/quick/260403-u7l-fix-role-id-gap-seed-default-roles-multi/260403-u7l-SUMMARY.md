---
plan: 260403-u7l
phase: quick
subsystem: rbac, multitenancy
tags: [bug-fix, rbac, schema, migration, multi-org]
completed: "2026-04-03"
duration: "~15 min"
tasks_completed: 3
files_changed: 7
commits:
  - hash: 3cdac08
    message: "feat(quick-260403-u7l): add roleId FK to user_tenant_roles + migration"
  - hash: f0f5c04
    message: "feat(quick-260403-u7l): seed default roles on tenant creation + auto-migrate on startup"
  - hash: 10f5497
    message: "fix(quick-260403-u7l): fix multi-org JWT fallback + populate roleId in assignUserRole"
key_decisions:
  - "roleId is nullable — predefined roles (Owner/Admin/Member/Viewer) keep role string only; custom roles get both"
  - "Default roles seeded inside the tenant creation transaction (atomic with tenant + owner assignment)"
  - "predev/prestart hooks use prisma migrate deploy (idempotent, safe for production)"
  - "JWT fallback uses orderBy assignedAt desc to pick most recent tenant for multi-org users"
key_files:
  created:
    - prisma/seed.ts
    - prisma/migrations/20260403_add_role_id_fk/migration.sql
  modified:
    - prisma/schema.prisma
    - web-ui/app/api/tenants/route.ts
    - web-ui/lib/invitation-service.ts
    - web-ui/lib/db/repositories/rbac/postgres.ts
    - web-ui/lib/auth-options.ts
    - web-ui/package.json
---

# Phase quick Plan 260403-u7l: Fix Role ID Gap + Seed Default Roles Summary

Added roleId FK to user_tenant_roles, seeded default roles per-tenant on creation, fixed multi-org JWT fallback ordering, and wired auto-migrate on startup.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add roleId FK to user_tenant_roles + migration | 3cdac08 | prisma/schema.prisma, migrations/20260403_add_role_id_fk/migration.sql |
| 2 | Seed default roles per tenant + auto-migrate on startup | f0f5c04 | prisma/seed.ts, tenants/route.ts, invitation-service.ts, package.json |
| 3 | Fix multi-org membership + populate roleId in assignUserRole | 10f5497 | auth-options.ts, rbac/postgres.ts |

## What Changed

**Task 1 — roleId FK on user_tenant_roles**

Added nullable `roleId String?` to `UserTenantRole` model with FK to `custom_roles.id` (ON DELETE SET NULL). Added `userRoles UserTenantRole[]` back-relation on `CustomRole`. Migration SQL adds the column, index, and FK constraint.

**Task 2 — Default roles seeded per tenant**

`POST /api/tenants` now seeds Owner/Admin/Member/Viewer into `custom_roles` inside the same `$transaction` as tenant creation. The Owner role's `id` is immediately used to populate `roleId` on the creator's `userTenantRole` row. `invitation-service.ts` now looks up the matching `custom_roles` row and populates `roleId` in both the auto-join path and `acceptPendingInvitation`. `package.json` gains `predev` and `prestart` hooks running `prisma migrate deploy` (idempotent).

**Task 3 — Multi-org JWT fallback + assignUserRole**

JWT callback fallback `findFirst` now uses `orderBy: { assignedAt: 'desc' }` so multi-org users land on their most recently joined tenant when `activeTenantId` is unset. `RbacPostgresRepository.assignUserRole` now looks up the matching `custom_roles` row and populates `roleId` alongside the `role` string.

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- `prisma/schema.prisma` — FOUND (commit 3cdac08)
- `prisma/migrations/20260403_add_role_id_fk/migration.sql` — FOUND (commit 3cdac08)
- `prisma/seed.ts` — FOUND (commit f0f5c04)
- `web-ui/app/api/tenants/route.ts` — FOUND (commit f0f5c04)
- `web-ui/lib/invitation-service.ts` — FOUND (commit f0f5c04)
- `web-ui/package.json` — FOUND (commit f0f5c04)
- `web-ui/lib/auth-options.ts` — FOUND (commit 10f5497)
- `web-ui/lib/db/repositories/rbac/postgres.ts` — FOUND (commit 10f5497)
