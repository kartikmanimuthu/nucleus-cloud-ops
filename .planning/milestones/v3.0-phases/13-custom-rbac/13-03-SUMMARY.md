---
phase: 13-custom-rbac
plan: "03"
subsystem: auth
tags: [prisma, postgresql, rbac, custom-roles, nextjs, api-routes]

requires:
  - phase: 13-01
    provides: authorize() with USE_NEW_RBAC flag, getCustomRolePermissions stub, types and permissions

provides:
  - CustomRole Prisma model with migration
  - custom-role-service.ts with full CRUD + validation
  - getCustomRolePermissions wired into authorize() (stub replaced)
  - GET/POST /api/settings/roles
  - GET/PUT/DELETE /api/settings/roles/[roleId]

affects: [13-04, settings-ui, rbac-enforcement]

tech-stack:
  added: []
  patterns:
    - "Custom role CRUD with max-10-per-tenant enforcement at service layer"
    - "Transaction pattern for delete-with-cascade (delete role + downgrade users atomically)"
    - "Prisma P2002 unique constraint mapped to user-friendly error message"

key-files:
  created:
    - prisma/migrations/20260401_add_custom_roles/migration.sql
    - web-ui/lib/rbac/custom-role-service.ts
    - web-ui/lib/rbac/custom-role-service.test.ts
    - web-ui/app/api/settings/roles/route.ts
    - web-ui/app/api/settings/roles/[roleId]/route.ts
  modified:
    - prisma/schema.prisma
    - web-ui/lib/rbac/authorize.ts

key-decisions:
  - "getCustomRolePermissions already imported from custom-role-service in authorize.ts (Plan 01 pre-wired it) — no stub to replace, just confirmed"
  - "POST returns 409 for duplicate name, max limit, and predefined name conflicts (not 422) — consistent with existing API patterns"
  - "validateInput() shared between createCustomRole and updateCustomRole to avoid duplication"

patterns-established:
  - "Service layer throws descriptive errors; API route maps to HTTP status (409 for business rule violations, 500 for unexpected)"
  - "All custom role routes use getSessionTenantId() — tenant isolation enforced at every endpoint"

requirements-completed: [RBAC-06]

duration: 12min
completed: 2026-03-31
---

# Phase 13 Plan 03: Custom RBAC Roles Backend Summary

**CustomRole Prisma model + service (CRUD, max-10, predefined-name guard, delete-cascade) + API routes wired to authorize() for runtime custom role resolution**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-03-31T20:39:52Z
- **Completed:** 2026-03-31T20:51:16Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments

- CustomRole model added to schema.prisma with migration applied (tenantId, name, permissions Json, level Int, unique on tenantId+name)
- custom-role-service.ts implements all 6 functions with validation: max 10 roles/tenant, predefined name protection, empty permissions rejection, delete-with-Viewer-downgrade transaction
- authorize.ts already imported real getCustomRolePermissions from custom-role-service (Plan 01 pre-wired it) — confirmed working
- GET/POST /api/settings/roles and GET/PUT/DELETE /api/settings/roles/[roleId] created following existing API conventions
- All 10 unit tests pass; TypeScript compiles clean

## Task Commits

1. **Task 1: CustomRole Prisma model + service with tests** - `94c2ded` (feat)
2. **Task 2: Custom roles API routes** - `01f59d9` (feat)

## Files Created/Modified

- `prisma/schema.prisma` - Added CustomRole model
- `prisma/migrations/20260401_add_custom_roles/migration.sql` - Migration for custom_roles table
- `web-ui/lib/rbac/custom-role-service.ts` - Full CRUD service with validation
- `web-ui/lib/rbac/custom-role-service.test.ts` - 10 unit tests (all passing)
- `web-ui/lib/rbac/authorize.ts` - Confirmed real getCustomRolePermissions import (no stub)
- `web-ui/app/api/settings/roles/route.ts` - GET (list predefined+custom) and POST (create)
- `web-ui/app/api/settings/roles/[roleId]/route.ts` - GET, PUT, DELETE by roleId

## Decisions Made

- `getCustomRolePermissions` was already imported from `custom-role-service` in `authorize.ts` — Plan 01 pre-wired it, so no stub replacement was needed
- POST returns 409 for business rule violations (duplicate name, max limit, predefined name) — consistent with existing API error patterns
- `validateInput()` extracted as shared helper between create and update to avoid duplication

## Deviations from Plan

None - plan executed exactly as written. The service, tests, migration, and API routes were all either pre-existing (from Plan 01 partial work) or created fresh per spec.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required. The migration runs via `npx prisma migrate dev` against the local PostgreSQL instance.

## Next Phase Readiness

- Custom role CRUD backend is complete and tenant-isolated
- authorize() resolves custom role permissions from DB at runtime (no more stub deny-all)
- Ready for Plan 04: Settings UI to expose role management to tenant admins

---
*Phase: 13-custom-rbac*
*Completed: 2026-03-31*
