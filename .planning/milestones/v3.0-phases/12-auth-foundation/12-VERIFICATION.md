---
status: human_needed
phase: 12-auth-foundation
verifier: orchestrator-inline
verified_at: "2026-03-31"
score: 5/5
---

# Phase 12: Auth Foundation — Verification

## Goal
Users can authenticate via Cognito or email/password; every session carries tenantId, role, and isSuperAdmin regardless of provider.

## Success Criteria

### SC1: User can log in with email + bcrypt password via Credentials provider
**Status:** PASS
**Evidence:** `web-ui/lib/auth-options.ts:29-95` — CredentialsProvider with `bcrypt.compare()`, account lockout (5 attempts / 15 min), failed attempt tracking.

### SC2: User can log in via Cognito SSO; session shape identical to Credentials
**Status:** PASS
**Evidence:** `web-ui/lib/auth-options.ts:97-101` — CognitoProvider configured. `session` callback (line 122-139) normalizes both providers to `{ id, email, tenantId, role, isSuperAdmin }` via `UserTenantRole` lookup.

### SC3: Session contains tenantId, role, isSuperAdmin via helpers
**Status:** PASS
**Evidence:** `web-ui/lib/auth-session.ts:17-26` — `getSessionTenantId()` extracts tenantId, throws if missing. `assertSuperAdmin()` (line 44-59) returns 401/403 NextResponse.

### SC4: Every authenticated request has x-tenant-id header
**Status:** PASS
**Evidence:** `web-ui/middleware.ts:20-22` — `requestHeaders.set("x-tenant-id", token.tenantId)` injected via `NextResponse.next({ request: { headers } })`.

### SC5: /admin and /api/admin routes return 403 for non-super-admins
**Status:** PASS
**Evidence:** `web-ui/middleware.ts:9-16` — `pathname.startsWith("/admin") || pathname.startsWith("/api/admin")` guard checks `token?.isSuperAdmin !== true` and returns 403.

## Requirement Traceability

| Req ID | Description | Status | Evidence |
|--------|-------------|--------|----------|
| AUTH-01 | Prisma adapter persists auth models in PostgreSQL | PASS | `prisma/schema.prisma` AuthUser/AuthAccount/AuthSession/VerificationToken models with `@@map` to `auth_*` tables |
| AUTH-02 | CredentialsProvider with bcrypt alongside Cognito | PASS | `auth-options.ts` dual providers |
| AUTH-03 | Session normalized to `{ id, email, tenantId, role, isSuperAdmin }` | PASS | `session` callback + `jwt` callback + `auth-types.ts` type augmentation |
| AUTH-04 | Database session strategy for server-side invalidation | PASS | `session.strategy: "database"`, 24h maxAge |
| AUTH-05 | `getSessionTenantId()` helper | PASS | `auth-session.ts:17-26` |
| AUTH-06 | `assertSuperAdmin()` helper | PASS | `auth-session.ts:44-59` |
| AUTH-07 | Middleware injects x-tenant-id header | PASS | `middleware.ts:20-22` |

## Human Verification Required

The following items need manual testing with a running dev server:

1. **Credentials login flow**: Start dev server, navigate to `/login`, submit email + password on "Email & Password" tab — verify session created with correct shape
2. **Cognito SSO flow**: Click "Sign in with SSO" tab — verify redirect to Cognito and session normalization on callback
3. **Login page UI**: Verify two tabs render correctly, inline validation errors appear, loading states work
4. **Lockout behavior**: Submit 5 wrong passwords — verify account locks for 15 minutes with appropriate error message
5. **Admin route guard**: As non-super-admin, navigate to `/admin` — verify 403 response

## Test Suite

No automated tests were created in this phase (auth integration tests require a running database + seeded users). Manual verification covers the critical paths above.
