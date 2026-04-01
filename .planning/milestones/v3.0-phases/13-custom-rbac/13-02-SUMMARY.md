---
phase: 13-custom-rbac
plan: "02"
subsystem: rbac
tags: [rbac, casl-removal, permissions, api-routes]
dependency_graph:
  requires: [13-01]
  provides: [casl-free-rbac, role-hierarchy-enforcement]
  affects: [all-api-routes, admin-ui]
tech_stack:
  added: []
  patterns: [canAssignRole hierarchy check, authorize() as sole permission path]
key_files:
  created: []
  modified:
    - web-ui/lib/rbac/authorize.ts
    - web-ui/lib/rbac/types.ts
    - web-ui/lib/rbac/index.ts
    - web-ui/app/api/admin/users/role/route.ts
    - web-ui/app/app/admin/users/page.tsx
    - web-ui/app/app/admin/layout.tsx
    - web-ui/components/auth/AuthorizePage.tsx
    - web-ui/package.json
  deleted:
    - web-ui/lib/rbac/abilities.ts
    - web-ui/lib/rbac/server-ability.ts
    - web-ui/lib/rbac/AbilityContext.tsx
    - web-ui/providers/RBACProvider.tsx
decisions:
  - CASL fully removed — authorize() is now the sole permission path with no feature flag
  - TenantRole/UserTenantRole kept in types.ts (repository layer still uses them as persistence types)
  - admin/layout.tsx migrated to isAdmin() — simpler than ability.cannot('read','User')
  - AuthorizePage.tsx rewritten to use can() — string params for forward compatibility
metrics:
  duration: 12m
  completed: "2026-04-01"
  tasks: 2
  files: 12
requirements: [RBAC-04, RBAC-05]
---

# Phase 13 Plan 02: CASL Removal and Route Migration Summary

CASL fully removed from the codebase. All 10 authorize() call sites across 8 API routes now use the new custom RBAC system exclusively. Role assignment endpoint enforces hierarchy per D-09.

## What Was Done

**Task 1 — Role hierarchy enforcement on assignment endpoint**

Updated `web-ui/app/api/admin/users/role/route.ts`:
- Replaced `TenantRole` with `PredefinedRole` (Owner/Admin/Member/Viewer)
- Added `canAssignRole(currentUserRole, targetRole)` check after the existing `authorize()` gate
- Returns 403 with `'Cannot assign a role above your own level'` when hierarchy violated
- Uses `getAuthSession()` instead of `getServerSession` for consistency

**Task 2 — CASL removal**

- Deleted 4 CASL-only files: `abilities.ts`, `server-ability.ts`, `AbilityContext.tsx`, `RBACProvider.tsx`
- Stripped `USE_NEW_RBAC` feature flag from `authorize.ts` — new system is permanent
- Removed `@casl/ability` and `@casl/react` from `package.json` (6 packages, ~50KB)
- Cleaned legacy types from `types.ts` (`AppAbility`, `Subjects`, `Actions`, `SystemRole`, `ROLE_DEFINITIONS`) — kept `TenantRole`/`UserTenantRole` (repository layer uses them)
- Rewrote `index.ts` to export only new RBAC symbols
- Migrated `admin/layout.tsx` to `isAdmin()`, `AuthorizePage.tsx` to `can()`
- Updated `admin/users/page.tsx` to use `PredefinedRole` with inline role definitions

## Deviations from Plan

**1. [Rule 2 - Missing] Fixed admin/layout.tsx and AuthorizePage.tsx**
- Found during: Task 2 (grep for remaining server-ability references)
- Issue: Two files outside the plan's file list still imported `getServerAbility` from the deleted `server-ability.ts`
- Fix: `admin/layout.tsx` → `isAdmin()`; `AuthorizePage.tsx` → `can()` with string params
- Files modified: `web-ui/app/app/admin/layout.tsx`, `web-ui/components/auth/AuthorizePage.tsx`
- Commit: ac00c04

**2. [Rule 2 - Missing] Fixed admin/users/page.tsx**
- Found during: Task 2 (grep for TenantRole/ROLE_DEFINITIONS usages)
- Issue: Page imported `ROLE_DEFINITIONS` and `TenantRole` from types.ts (both removed)
- Fix: Replaced with inline `PredefinedRole`-based definitions matching new role names
- Files modified: `web-ui/app/app/admin/users/page.tsx`
- Commit: ac00c04

## Verification Results

- `npx tsc --noEmit` — PASSED
- `grep -r "@casl" web-ui/ --include="*.ts" --include="*.tsx" | grep -v node_modules` — 0 results
- `grep -r "from '@/lib/rbac/authorize'" web-ui/app/api/` — 10 call sites across 8 route files
- `grep "canAssignRole(" web-ui/app/api/admin/users/role/route.ts` — present
- `grep "USE_NEW_RBAC" web-ui/lib/rbac/authorize.ts` — 0 results
- `grep "casl" web-ui/package.json` — 0 results

## Known Stubs

None — all routes use live permission checks.

## Self-Check: PASSED
