---
phase: 13-custom-rbac
plan: 01
subsystem: auth
tags: [rbac, permissions, casl, feature-flag, typescript]

requires:
  - phase: 12-auth-foundation
    provides: session with role/tenantId/isSuperAdmin fields from Phase 12 auth

provides:
  - Static ROLE_PERMISSIONS map for Owner/Admin/Member/Viewer across 5 modules
  - hasPermission(), canAssignRole(), getAutoLevel() helpers
  - authorize() rewritten with USE_NEW_RBAC feature flag wrapper
  - SUBJECT_TO_MODULE and ACTION_MAP for backward-compat during migration
  - getCustomRolePermissions() stub (deny-all) for Plan 03 to implement

affects: [13-02, 13-03, 13-04, all API routes using authorize()]

tech-stack:
  added: []
  patterns:
    - "Feature flag USE_NEW_RBAC=true activates new permission path; unset = CASL fallback"
    - "SUBJECT_TO_MODULE maps old CASL subjects to new modules for zero-change call sites"
    - "ACTION_MAP maps old CASL actions (execute, manage, export) to CRUD equivalents"

key-files:
  created:
    - web-ui/lib/rbac/permissions.ts
    - web-ui/lib/rbac/permissions.test.ts
  modified:
    - web-ui/lib/rbac/types.ts
    - web-ui/lib/rbac/authorize.ts

key-decisions:
  - "USE_NEW_RBAC env var (not per-route flags) — all routes migrate together in Plan 02"
  - "SuperAdmin bypasses all permission checks in new RBAC path"
  - "getCustomRolePermissions() stub returns null (deny) — Plan 03 wires real DB lookup"
  - "Legacy CASL types kept @deprecated in types.ts — removed after Plan 02 migration"

patterns-established:
  - "Permission check: hasPermission(role, action, module) — pure function, no async"
  - "Role hierarchy: canAssignRole(assigner, target) — Admin(3)+ can assign, Member/Viewer cannot"
  - "Custom role auto-level: getAutoLevel(permissionSet) — by total action count thresholds"

requirements-completed: [RBAC-01, RBAC-02, RBAC-03, RBAC-07]

duration: 7min
completed: 2026-03-31
---

# Phase 13 Plan 01: Custom RBAC Core Summary

**Static ROLE_PERMISSIONS map (Owner/Admin/Member/Viewer x 5 modules) with authorize() rewritten behind USE_NEW_RBAC feature flag — CASL stays active until flag is flipped**

## Performance

- **Duration:** 7 min
- **Started:** 2026-03-31T20:30:43Z
- **Completed:** 2026-03-31T20:37:45Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- New module-based RBAC types (Module, Action, PredefinedRole, PermissionSet) with SUBJECT_TO_MODULE and ACTION_MAP for backward compat
- Static ROLE_PERMISSIONS map covering all 4 roles x 5 modules with 25 passing unit tests
- authorize() rewritten with USE_NEW_RBAC feature flag — CASL fallback when unset, new hasPermission() path when true

## Task Commits

1. **Task 1: New RBAC types and static permission map with tests** - `04aaba0` (feat)
2. **Task 2: Rewrite authorize() with feature flag wrapper** - `68ab2ae` (feat)

## Files Created/Modified

- `web-ui/lib/rbac/types.ts` - New Module/Action/PredefinedRole types + SUBJECT_TO_MODULE/ACTION_MAP; legacy CASL types kept @deprecated
- `web-ui/lib/rbac/permissions.ts` - ROLE_PERMISSIONS, ROLE_LEVELS, hasPermission, hasCustomPermission, canAssignRole, getAutoLevel
- `web-ui/lib/rbac/permissions.test.ts` - 25 unit tests covering full permission matrix and role hierarchy
- `web-ui/lib/rbac/authorize.ts` - Feature flag wrapper; new path uses hasPermission(); CASL fallback preserved

## Decisions Made

- USE_NEW_RBAC as a single global env var (not per-route flags) — all routes migrate together in Plan 02, simpler than 20 individual flags
- SuperAdmin (isSuperAdmin=true from session) bypasses all permission checks in the new path
- getCustomRolePermissions() stub returns null (deny-all) — Plan 03 implements real DB lookup
- Legacy CASL types marked @deprecated in types.ts rather than deleted — removed after Plan 02 completes migration

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

Worktree was at old base commit (pre-Phase 12). Merged multitenancy branch to get updated auth-session.ts (getAuthSession, role/tenantId in session) before starting implementation.

## User Setup Required

None - no external service configuration required. Set `USE_NEW_RBAC=true` in `.env.local` to activate new permission system (safe to leave unset — CASL remains active).

## Next Phase Readiness

- Plan 02 (API route migration) can proceed — authorize() signature unchanged, all call sites work without modification
- Flip USE_NEW_RBAC=true to activate new system; flip back to revert instantly
- Plan 03 (custom roles) can implement getCustomRolePermissions() DB lookup — stub is already wired in authorize()

---
*Phase: 13-custom-rbac*
*Completed: 2026-03-31*
