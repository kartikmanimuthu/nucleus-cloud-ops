---
phase: 17-org-switcher-tenant-settings
plan: 01
subsystem: auth
tags: [nextauth, prisma, session, multi-tenant, org-switcher]

requires:
  - phase: 16-user-invitations-onboarding-completion
    provides: InvitationService, UserTenantRole model, auth session foundation

provides:
  - activeTenantId field on AuthUser (Prisma + migration)
  - Session callback honors activeTenantId for tenant resolution
  - JWT callback honors activeTenantId on initial sign-in
  - POST /api/tenants/switch — validates membership, persists activeTenantId
  - GET /api/tenants/my-orgs — returns all user orgs with name, slug, role, logoUrl

affects: [17-02-tenant-settings-ui, 17-03-org-switcher-ui]

tech-stack:
  added: []
  patterns:
    - "activeTenantId on AuthUser: nullable String, no FK — same pattern as other tenantId fields"
    - "Switch API uses getPrismaClient() not getTenantClient() — AuthUser is not tenant-scoped"
    - "Session callback: activeTenantId check before generic findFirst fallback"

key-files:
  created:
    - prisma/migrations/20260401_add_active_tenant_id/migration.sql
    - web-ui/app/api/tenants/switch/route.ts
    - web-ui/app/api/tenants/my-orgs/route.ts
  modified:
    - prisma/schema.prisma
    - web-ui/lib/auth-types.ts
    - web-ui/lib/auth-options.ts

key-decisions:
  - "activeTenantId stored on AuthUser (not session table) — persists across sessions, survives logout"
  - "Switch API validates UserTenantRole membership before setting activeTenantId — prevents tenant hopping"
  - "Session callback falls through to generic findFirst if activeTenantId is stale (user removed from org)"
  - "my-orgs uses getPrismaClient() for cross-tenant queries (UserTenantRole + Tenant)"

patterns-established:
  - "Tenant switch: validate membership → update authUser.activeTenantId → session picks it up on next request"
  - "my-orgs logo: TenantConfigService.getConfig('org_logo', tenantId) per tenant"

requirements-completed: [ORGW-01, ORGW-02, ORGW-03, ORGW-04]

duration: 18min
completed: 2026-04-01
---

# Phase 17 Plan 01: Org Switch Backend Summary

**activeTenantId on AuthUser with session callback integration, tenant switch API, and multi-org list API**

## Performance

- **Duration:** 18 min
- **Started:** 2026-04-01T18:15:00Z
- **Completed:** 2026-04-01T18:33:00Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- Added `activeTenantId String?` to AuthUser model with Prisma migration applied to local DB
- Updated session and JWT callbacks to prefer activeTenantId before falling back to generic findFirst
- Created POST /api/tenants/switch with membership validation before persisting choice
- Created GET /api/tenants/my-orgs returning all user orgs with name, slug, role, and logoUrl

## Task Commits

1. **Task 1: Add activeTenantId to AuthUser + update session/jwt callbacks** - `96a1ccc` (feat)
2. **Task 2: Tenant switch API + my-orgs list API** - `dd8b3bc` (feat)

## Files Created/Modified
- `prisma/schema.prisma` - Added `activeTenantId String?` to AuthUser model
- `prisma/migrations/20260401_add_active_tenant_id/migration.sql` - ALTER TABLE auth_users ADD COLUMN active_tenant_id TEXT
- `web-ui/lib/auth-types.ts` - Added `activeTenantId?: string | null` to User and AdapterUser interfaces
- `web-ui/lib/auth-options.ts` - Updated session + jwt callbacks to honor activeTenantId
- `web-ui/app/api/tenants/switch/route.ts` - POST endpoint: validates membership, sets activeTenantId
- `web-ui/app/api/tenants/my-orgs/route.ts` - GET endpoint: returns all user orgs with logo URLs

## Decisions Made
- activeTenantId stored on AuthUser (not session table) so it persists across sessions and survives logout/re-login
- Switch API validates UserTenantRole membership before setting activeTenantId — prevents unauthorized tenant access
- Session callback falls through to generic findFirst if activeTenantId is stale (user removed from org) — graceful degradation
- Both new routes use `getPrismaClient()` not `getTenantClient()` — they query across tenants by design

## Deviations from Plan

**1. [Rule 3 - Blocking] Used `prisma migrate deploy` instead of `prisma migrate dev`**
- **Found during:** Task 1 (Prisma migration)
- **Issue:** `prisma migrate dev` requires interactive TTY; non-interactive environment
- **Fix:** Created migration SQL file manually, applied with `prisma migrate deploy`
- **Files modified:** prisma/migrations/20260401_add_active_tenant_id/migration.sql
- **Verification:** Migration applied successfully, `prisma validate` passes
- **Committed in:** 96a1ccc (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Functionally identical outcome — migration applied and schema valid.

## Issues Encountered
- DATABASE_URL not in environment — sourced from web-ui/.env.local for all Prisma commands

## Next Phase Readiness
- Backend org switch infrastructure complete — frontend org switcher (Plan 03) can now call POST /api/tenants/switch
- GET /api/tenants/my-orgs ready for org switcher dropdown population
- activeTenantId persists across sessions; session callback picks it up automatically on next request

---
*Phase: 17-org-switcher-tenant-settings*
*Completed: 2026-04-01*
