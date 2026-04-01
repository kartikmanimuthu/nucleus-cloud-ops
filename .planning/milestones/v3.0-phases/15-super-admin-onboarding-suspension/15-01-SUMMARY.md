---
phase: 15-super-admin-onboarding-suspension
plan: 01
subsystem: auth
tags: [prisma, postgresql, bcrypt, nextjs, api, signup, multitenancy]

requires:
  - phase: 12-auth-foundation
    provides: AuthUser model, PrismaAdapter, database session strategy
  - phase: 13-custom-rbac
    provides: UserTenantRole model, Owner/Admin/Member/Viewer roles
  - phase: 14-tenant-context-enforcement
    provides: getTenantClient, Tenant.status column

provides:
  - Tenant.slug column (nullable, unique) with migration SQL
  - POST /api/auth/signup — user registration with bcrypt, 409 for duplicates
  - GET /api/tenants/check-slug — slug availability check with format validation
  - POST /api/tenants — atomic tenant creation + Owner role assignment in $transaction

affects: [15-02-signup-ui, plan-02]

tech-stack:
  added: []
  patterns:
    - "Signup uses getPrismaClient() (unscoped) — platform-level op, tenant doesn't exist yet"
    - "$transaction for tenant creation — atomicity between Tenant + UserTenantRole"
    - "Slug uniqueness checked inside transaction — prevents TOCTOU race conditions"

key-files:
  created:
    - prisma/migrations/20260401_add_tenant_slug/migration.sql
    - web-ui/app/api/auth/signup/route.ts
    - web-ui/app/api/tenants/check-slug/route.ts
    - web-ui/app/api/tenants/route.ts
  modified:
    - prisma/schema.prisma

key-decisions:
  - "slug is String? (nullable) — existing tenants from Phase 14 don't have slugs; new tenants always will"
  - "Signup uses getPrismaClient() not getTenantClient() — user has no tenant yet at registration time"
  - "Tenant creation blocks users with existing tenantId — multi-org is Phase 17 scope"
  - "Slug uniqueness re-checked inside $transaction — prevents race condition between check-slug and create"

patterns-established:
  - "Platform-level ops (signup, tenant create) use getPrismaClient() directly — no tenant scope"
  - "Error messages match UI-SPEC copywriting contract exactly"

requirements-completed: [ONBD-01]

duration: 21min
completed: 2026-04-01
---

# Phase 15 Plan 01: Schema + Backend APIs for Self-Service Signup Summary

**Prisma slug migration + three API endpoints enabling user registration, slug availability check, and atomic tenant creation with Owner role assignment**

## Performance

- **Duration:** 21 min
- **Started:** 2026-04-01T15:00:00Z
- **Completed:** 2026-04-01T15:21:46Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Added `slug String? @unique` to Tenant model with migration SQL
- POST /api/auth/signup creates AuthUser with bcrypt-hashed password, returns 409 for duplicate emails
- GET /api/tenants/check-slug validates slug format and returns availability status
- POST /api/tenants atomically creates Tenant + Owner UserTenantRole in a single $transaction

## Task Commits

1. **Task 1: Add slug to Tenant model + user registration API** - `c068aa4` (feat)
2. **Task 2: Slug availability check + tenant creation API** - `9edd068` (feat)

## Files Created/Modified
- `prisma/schema.prisma` - Added `slug String? @unique` to Tenant model
- `prisma/migrations/20260401_add_tenant_slug/migration.sql` - ALTER TABLE + unique index
- `web-ui/app/api/auth/signup/route.ts` - POST: bcrypt hash, 409 duplicate, 201 success
- `web-ui/app/api/tenants/check-slug/route.ts` - GET: slug format validation + availability check
- `web-ui/app/api/tenants/route.ts` - POST: $transaction creates Tenant + Owner UserTenantRole

## Decisions Made
- `slug` is nullable (`String?`) so existing Phase 14 tenants remain valid without migration data backfill
- Signup and tenant creation both use `getPrismaClient()` (unscoped) — the tenant doesn't exist yet at these points, so `getTenantClient()` would throw
- Slug uniqueness is re-checked inside the `$transaction` to prevent TOCTOU race conditions between the check-slug call and the create call
- Users with an existing `tenantId` are blocked from creating another org (multi-org is Phase 17 scope)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All three API endpoints are ready for Plan 02 UI pages to consume
- POST /api/auth/signup, GET /api/tenants/check-slug, POST /api/tenants all verified
- Plan 02 can build the signup page, create-org page, and post-login redirect flow

---
*Phase: 15-super-admin-onboarding-suspension*
*Completed: 2026-04-01*
