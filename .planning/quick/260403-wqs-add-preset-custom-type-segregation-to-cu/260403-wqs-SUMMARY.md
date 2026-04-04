---
phase: quick
plan: 260403-wqs
subsystem: rbac
tags: [custom-roles, preset-roles, schema-migration, multi-tenancy]
dependency_graph:
  requires: []
  provides: [global-preset-roles, type-segregated-custom-roles]
  affects: [custom-role-service, roles-api, tenants-api, members-page]
tech_stack:
  added: []
  patterns: [partial-unique-indexes, global-singleton-seed]
key_files:
  created:
    - prisma/migrations/20260403181424_add_role_type_preset/migration.sql
    - prisma/migrations/20260403181458_add_role_partial_indexes_and_cleanup/migration.sql
  modified:
    - prisma/schema.prisma
    - prisma/seed.ts
    - web-ui/lib/rbac/custom-role-service.ts
    - web-ui/app/api/tenants/route.ts
    - web-ui/app/api/settings/roles/route.ts
    - web-ui/app/app/settings/members/page.tsx
decisions:
  - Stable preset IDs (preset-owner, preset-admin, etc.) enable idempotent upserts
  - Partial unique indexes in raw SQL (Prisma can't express WHERE clause on @@unique)
  - castRole maps tenantId null → empty string to preserve CustomRoleOutput interface
  - getCustomRolePermissions uses OR query with orderBy type asc (custom < preset) to prefer tenant custom over preset
metrics:
  duration: ~15min
  completed: 2026-04-03
  tasks_completed: 2
  files_changed: 6
---

# Phase quick Plan 260403-wqs: Preset/Custom Role Type Segregation Summary

Global preset roles (Owner/Admin/Member/Viewer) now exist once in `custom_roles` with `tenantId=null, type=preset`. Tenant creation no longer duplicates them per-tenant. The roles UI and invite dropdown source presets from the DB.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Schema migration — type field, nullable tenantId, partial indexes | d4db5b6 | prisma/schema.prisma, 2 migration SQL files |
| 2 | Seed global presets + update service, tenant creation, roles API, members page | 41bda37 | prisma/seed.ts, custom-role-service.ts, tenants/route.ts, roles/route.ts, members/page.tsx |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] prisma/.env conflict prevented migration**
- **Found during:** Task 1
- **Issue:** Prisma refused to run with conflicting DATABASE_URL in both `.env` and `prisma/.env`
- **Fix:** Renamed `prisma/.env` to `prisma/.env.bak` (both files had identical values)
- **Files modified:** prisma/.env.bak (renamed)
- **Commit:** d4db5b6

**2. [Rule 1 - Bug] Root @prisma/client stale — seed used wrong generated client**
- **Found during:** Task 2 seed run
- **Issue:** Root `node_modules/@prisma/client` was pre-migration; schema output is `web-ui/node_modules/.prisma/client`
- **Fix:** Changed seed.ts import to `../web-ui/node_modules/.prisma/client`
- **Files modified:** prisma/seed.ts
- **Commit:** 41bda37

## Known Stubs

None — preset roles are fully wired from DB.

## Self-Check: PASSED

- prisma/schema.prisma — FOUND, type field + nullable tenantId present
- prisma/migrations/20260403181424_add_role_type_preset/migration.sql — FOUND
- prisma/migrations/20260403181458_add_role_partial_indexes_and_cleanup/migration.sql — FOUND
- prisma/seed.ts — FOUND, upserts 4 preset roles
- web-ui/lib/rbac/custom-role-service.ts — FOUND, getPresetRoles() exported
- web-ui/app/api/tenants/route.ts — FOUND, no createMany defaultRoles block
- web-ui/app/api/settings/roles/route.ts — FOUND, uses getPresetRoles()
- web-ui/app/app/settings/members/page.tsx — FOUND, predefinedRoles state from API
- Commit d4db5b6 — FOUND
- Commit 41bda37 — FOUND
