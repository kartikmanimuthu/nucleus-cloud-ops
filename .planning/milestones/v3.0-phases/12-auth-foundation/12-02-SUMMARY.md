---
phase: 12-auth-foundation
plan: "02"
subsystem: auth
tags: [nextauth, middleware, session-helpers, tenant-context, super-admin]
dependency_graph:
  requires: [12-01]
  provides: [session-helpers, middleware-tenant-injection, admin-route-guard]
  affects: [web-ui/lib/auth-session.ts, web-ui/middleware.ts, web-ui/lib/auth-options.ts, web-ui/lib/auth-types.ts]
tech_stack:
  added: []
  patterns: [withAuth-middleware, jwt-enrichment, x-tenant-id-header, super-admin-guard]
key_files:
  created: []
  modified:
    - web-ui/lib/auth-session.ts
    - web-ui/middleware.ts
    - web-ui/lib/auth-options.ts
    - web-ui/lib/auth-types.ts
decisions:
  - "jwt callback enriches token with tenantId/role/isSuperAdmin — middleware reads JWT not database session even with database strategy"
  - "JWT type augmented in auth-types.ts to avoid TypeScript errors in middleware"
  - "assertSuperAdmin returns 401 (no session) or 403 (not super admin) — callers use return pattern"
metrics:
  duration: "~11 minutes"
  completed: "2026-03-31"
  tasks: 2
  files: 4
---

# Phase 12 Plan 02: Session Helpers + Middleware Summary

Session helpers `getSessionTenantId` and `assertSuperAdmin` added to auth-session.ts; middleware rewritten to inject `x-tenant-id` header and guard `/admin` routes via JWT token enrichment.

## What Was Built

**Task 1 — Rewrite auth-session.ts with session helpers**

Rewrote `web-ui/lib/auth-session.ts` with four exported functions:
- `getAuthSession()` — raw session access, returns null if unauthenticated
- `getSessionTenantId()` — extracts tenantId, throws if missing (callers return 401)
- `getSessionUserId()` — backward-compatible `USER#id` format, throws if no session
- `assertSuperAdmin()` — returns `NextResponse` 401 (no session) or 403 (not super admin), null if authorized

Also brought in Plan 12-01 prerequisites: `auth-types.ts`, `auth-options.ts` (PrismaAdapter + dual providers), `pg-config.ts`, and `prisma/schema.prisma` with auth models.

**Task 2 — Middleware x-tenant-id injection + admin guard**

Rewrote `web-ui/middleware.ts` using `withAuth` from `next-auth/middleware`:
- Injects `x-tenant-id` header from JWT token on every authenticated request
- Guards `/admin` and `/api/admin` routes — returns 403 for non-super-admin users
- Public routes (`/login`, `/`, `/docs`) remain accessible without auth
- Matcher unchanged from original (excludes api/auth, api/health, _next/static, etc.)

Added `jwt` callback to `web-ui/lib/auth-options.ts` to enrich the JWT token with `tenantId`, `role`, and `isSuperAdmin` on initial sign-in. This is required because middleware reads the JWT token, not the database session, even when `strategy: "database"` is configured.

Augmented `JWT` interface in `web-ui/lib/auth-types.ts` with `tenantId`, `role`, and `isSuperAdmin` fields.

## Deviations from Plan

**1. [Rule 2 - Missing Critical Functionality] JWT type augmentation**
- **Found during:** Task 2
- **Issue:** Plan specified adding `jwt` callback but did not mention augmenting the `JWT` interface in `auth-types.ts`. Without this, TypeScript would error on `token.tenantId` and `token.isSuperAdmin` in middleware.
- **Fix:** Added `declare module "next-auth/jwt" { interface JWT { tenantId, role, isSuperAdmin } }` to `auth-types.ts`
- **Files modified:** `web-ui/lib/auth-types.ts`
- **Commit:** 4e883fd

**2. [Rule 3 - Blocking] Plan 12-01 prerequisites missing in worktree**
- **Found during:** Task 1
- **Issue:** Worktree branch `worktree-agent-ade466f1` was at commit `4864a74` (before Plan 12-01). Files `auth-types.ts`, updated `auth-options.ts`, `pg-config.ts`, and `prisma/schema.prisma` were missing.
- **Fix:** Used `git checkout multitenancy -- <files>` to bring in Plan 12-01 artifacts before implementing Plan 12-02.
- **Files modified:** `web-ui/lib/auth-types.ts`, `web-ui/lib/auth-options.ts`, `web-ui/lib/db/pg-config.ts`, `prisma/schema.prisma`, `prisma/migrations/20260331_add_auth_models/migration.sql`, `web-ui/package.json`, `web-ui/package-lock.json`
- **Commit:** 4c14c58

## Known Stubs

None — all session helpers are fully implemented with real logic.

## Self-Check: PASSED

- FOUND: .planning/phases/12-auth-foundation/12-02-SUMMARY.md
- FOUND: web-ui/lib/auth-session.ts
- FOUND: web-ui/middleware.ts
- FOUND: commit 4c14c58 (Task 1)
- FOUND: commit 4e883fd (Task 2)
