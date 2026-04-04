---
plan: 260403-seb-01
phase: quick
subsystem: settings
tags: [bug-fix, custom-roles, invite, logo-upload, s3]
completed: "2026-04-03"
duration: "~10 min"
tasks_completed: 2
files_changed: 5
commits:
  - hash: 5055a7c
    message: "feat(quick-260403-seb): fetch and merge custom roles in invite dropdown"
  - hash: e994405
    message: "fix(quick-260403-seb): surface logo upload errors and guard missing env var"
key_decisions:
  - "Store custom roles as { name, level }[] so level-based filtering matches predefined role behavior"
  - "Custom role fetch is non-blocking — predefined roles still work if /api/settings/roles fails"
  - "ASSETS_BUCKET_NAME guard placed at top of POST handler before any S3 client instantiation"
key_files:
  modified:
    - web-ui/app/app/settings/members/page.tsx
    - web-ui/components/settings/organization-settings-form.tsx
    - web-ui/app/api/tenants/logo/route.ts
    - scripts/generate-env.ts
    - web-ui/.env.local.example
---

# Phase quick Plan 260403-seb: Fix Custom Roles Not Appearing in Invite Summary

Custom roles now appear in the invite dropdown; logo upload surfaces errors instead of silently proceeding.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Fetch and merge custom roles in invite dropdown | 5055a7c | web-ui/app/app/settings/members/page.tsx |
| 2 | Fix logo upload silent failure and missing env var guard | e994405 | organization-settings-form.tsx, logo/route.ts, generate-env.ts, .env.local.example |

## What Changed

**Task 1 — Custom roles in invite dropdown**

`members/page.tsx` was hardcoding only `ALL_ROLES` (Owner/Admin/Member/Viewer). Added:
- `customRoles` state typed as `{ name: string; level: number }[]`
- `fetchRoles` callback that calls `GET /api/settings/roles` and extracts `data.custom`
- `fetchRoles()` called in the existing `useEffect` alongside `fetchMembers` and `fetchInvitations`
- `availableRoles` now merges `predefinedFiltered` + `customFiltered` (both gated by `userLevel`)

**Task 2 — Logo upload error surfacing**

- `organization-settings-form.tsx`: S3 PUT response was already captured as `s3Res` with `if (!s3Res.ok)` guard — confirmed correct
- `logo/route.ts`: Early return at top of POST handler when `ASSETS_BUCKET_NAME` is missing, returning 500 with `"Logo storage not configured (ASSETS_BUCKET_NAME missing)"`
- `generate-env.ts`: Added `if (o.assetsBucketName) set("ASSETS_BUCKET_NAME", o.assetsBucketName)` in S3 buckets section
- `.env.local.example`: Added `# ASSETS_BUCKET_NAME=your-assets-bucket  # Required for org logo upload` after `CHECKPOINT_S3_BUCKET`

## Deviations from Plan

None — plan executed exactly as written. All changes were already partially implemented; verified and committed cleanly.

## Self-Check: PASSED

- `web-ui/app/app/settings/members/page.tsx` — FOUND (commit 5055a7c)
- `web-ui/app/api/tenants/logo/route.ts` — FOUND (commit e994405)
- `web-ui/components/settings/organization-settings-form.tsx` — FOUND (commit e994405)
- `scripts/generate-env.ts` — FOUND (commit e994405)
- `web-ui/.env.local.example` — FOUND (commit e994405)
