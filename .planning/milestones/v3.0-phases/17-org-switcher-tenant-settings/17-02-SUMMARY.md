---
phase: 17-org-switcher-tenant-settings
plan: "02"
subsystem: api
tags: [tenant-settings, s3, presigned-url, rbac, prisma, zod]

requires:
  - phase: 17-01-org-switcher-tenant-settings
    provides: activeTenantId in session, tenant switch API
  - phase: 14-tenant-context-enforcement
    provides: getTenantClient, getPrismaClient, TenantConfig model
  - phase: 13-custom-rbac
    provides: authorize(), SUBJECT_TO_MODULE, Settings module

provides:
  - TenantSettingsService with getSettings/updateSettings/getLogo/saveLogo
  - GET /api/tenants/settings — returns org name, slug, timezone, notifications
  - PUT /api/tenants/settings — updates Tenant.name + TenantConfig org_settings (RBAC-protected)
  - POST /api/tenants/logo — generates presigned S3 PUT URL scoped to tenant
  - PUT /api/tenants/logo — saves S3 key in TenantConfig org_logo (RBAC-protected)

affects:
  - 17-03-org-switcher-tenant-settings (settings UI consumes these APIs)

tech-stack:
  added: []
  patterns:
    - "Settings service merges two data sources: Tenant.name (direct field) + TenantConfig JSON blob"
    - "Logo upload uses presigned S3 PUT URL pattern — client uploads directly, then calls PUT to save key"
    - "ASSETS_BUCKET_NAME + ASSETS_CDN_URL env vars for S3 logo storage"

key-files:
  created:
    - web-ui/lib/tenant-settings-service.ts
    - web-ui/app/api/tenants/settings/route.ts
    - web-ui/app/api/tenants/logo/route.ts
  modified: []

key-decisions:
  - "Tenant.name updated directly on Tenant model; timezone+notifications stored in TenantConfig org_settings JSON"
  - "Logo S3 key pattern: logos/{tenantId}/{timestamp}.{ext} — tenant-scoped, no cross-tenant access"
  - "GET /api/tenants/settings is open to all authenticated users; PUT/POST/PUT logo require Owner/Admin"
  - "ASSETS_CDN_URL env var for CloudFront URL; falls back to direct S3 URL if unset"

patterns-established:
  - "Settings service pattern: static class wrapping TenantConfigService + getPrismaClient for mixed data sources"
  - "Presigned URL pattern: POST generates URL + key, client uploads, PUT saves key to TenantConfig"

requirements-completed:
  - STNG-01
  - STNG-02
  - STNG-03

duration: 3min
completed: 2026-04-01
---

# Phase 17 Plan 02: Tenant Settings Backend Summary

**Org settings CRUD + S3 presigned logo upload via TenantSettingsService and two API routes**

## Performance

- **Duration:** 3 min
- **Started:** 2026-04-01T18:18:13Z
- **Completed:** 2026-04-01T18:21:04Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- TenantSettingsService merges Tenant.name with TenantConfig org_settings for typed settings CRUD
- Settings API (GET/PUT) with zod validation and RBAC enforcement on writes
- Logo API (POST presigned URL / PUT save key) with 2MB limit, PNG/JPG/SVG type guard, tenant-scoped S3 keys

## Task Commits

1. **Task 1: TenantSettingsService** - `7a8fa03` (feat)
2. **Task 2: Settings + logo API routes** - `2a9fbdb` (feat)

## Files Created/Modified

- `web-ui/lib/tenant-settings-service.ts` - Static service class: getSettings, updateSettings, getLogo, saveLogo
- `web-ui/app/api/tenants/settings/route.ts` - GET (any auth) + PUT (Owner/Admin) for org name/timezone/notifications
- `web-ui/app/api/tenants/logo/route.ts` - POST (presigned S3 URL) + PUT (save key) for org logo

## Decisions Made

- Tenant.name lives on the Tenant model directly; timezone and notifications go in TenantConfig `org_settings` JSON — keeps the Tenant table lean while allowing flexible config extension
- Logo S3 key is `logos/{tenantId}/{timestamp}.{ext}` — tenant-scoped prefix prevents cross-tenant access even without bucket policies
- GET settings is open to all authenticated users (Members/Viewers need to read org name/timezone); writes require Owner/Admin via `authorize("update", "Settings")`

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

Two new environment variables needed for logo upload:
- `ASSETS_BUCKET_NAME` — S3 bucket name for logo storage
- `ASSETS_CDN_URL` — (optional) CloudFront distribution URL; falls back to direct S3 URL if unset

## Next Phase Readiness

- All three API endpoints are live and TypeScript-clean
- Plan 03 (settings UI) can consume GET/PUT /api/tenants/settings and POST/PUT /api/tenants/logo directly
- No blockers

---
*Phase: 17-org-switcher-tenant-settings*
*Completed: 2026-04-01*
