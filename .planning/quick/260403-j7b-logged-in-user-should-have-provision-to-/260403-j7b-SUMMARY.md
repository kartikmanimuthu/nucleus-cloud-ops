---
phase: quick
plan: 260403-j7b
subsystem: multi-tenancy
tags: [org-switcher, tenant-creation, multi-org]
tech-stack:
  added: []
  patterns: [multi-org membership, auto-switch on create]
key-files:
  modified:
    - web-ui/app/api/tenants/route.ts
    - web-ui/app/create-org/page.tsx
    - web-ui/components/settings/org-switcher.tsx
decisions:
  - Removed single-org guard from POST /api/tenants — any authenticated user can now create additional orgs
  - Auto-switch activeTenantId immediately after tenant creation (outside transaction, same pattern as /api/tenants/switch)
  - Single-org OrgSwitcher converted from static div to dropdown — enables create-new-org discovery for all users
metrics:
  duration: 3 minutes
  completed: 2026-04-03T08:31:22Z
  tasks: 2
  files: 3
---

# Phase quick Plan 260403-j7b: Multi-org creation and OrgSwitcher entry point Summary

Multi-org creation enabled for existing users — removed the single-org guard from the tenant API, auto-switch to new org on creation, and added "Create new organization" to OrgSwitcher for both single-org and multi-org users.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Remove single-org guard + auto-switch on create | d9912b2 | web-ui/app/api/tenants/route.ts, web-ui/app/create-org/page.tsx |
| 2 | Add "Create new organization" to OrgSwitcher | d9912b2 | web-ui/components/settings/org-switcher.tsx |

## Changes

**`web-ui/app/api/tenants/route.ts`**
- Removed the 409 guard that blocked users with an existing `tenantId`
- Added `prisma.authUser.update({ activeTenantId: result.id })` after the transaction to auto-switch the user to their new org

**`web-ui/app/create-org/page.tsx`**
- Removed the `useEffect` redirect that sent users with `session.user.tenantId` to `/app/dashboard`
- Unauthenticated redirect kept intact

**`web-ui/components/settings/org-switcher.tsx`**
- Added `Plus` import from lucide-react
- Extracted shared `createOrgItem` JSX (separator + dashed-border Plus button → `/create-org`)
- Single-org branch: converted static div to a full dropdown with current org + `createOrgItem`
- Multi-org branch: appended `createOrgItem` after the existing org list

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- `web-ui/app/api/tenants/route.ts` — modified, committed d9912b2
- `web-ui/app/create-org/page.tsx` — modified, committed d9912b2
- `web-ui/components/settings/org-switcher.tsx` — modified, committed d9912b2
- TypeScript: `npx tsc --noEmit` passed with no errors
