---
phase: 15-super-admin-onboarding-suspension
verified: 2026-04-01T16:00:00Z
status: human_needed
score: 5/5 must-haves verified
re_verification: false
human_verification:
  - test: "Complete signup → auto-login → /create-org redirect → org creation → /app/dashboard flow"
    expected: "New user registers, gets auto-signed-in, middleware redirects to /create-org (no tenantId), user creates org, session updates with tenantId, lands in /app/dashboard"
    why_human: "Requires running dev server; middleware redirect behavior and session update() after org creation can only be confirmed at runtime"
  - test: "Cognito SSO signup on /signup"
    expected: "Clicking 'Sign up with SSO' triggers Cognito OAuth flow; after Cognito auth, user lands on /create-org (no tenantId yet)"
    why_human: "Requires live Cognito configuration and OAuth callback; cannot verify programmatically"
  - test: "Authenticated user with tenantId visiting /signup is redirected to /app/dashboard"
    expected: "useEffect in signup page detects status === 'authenticated' and calls router.push('/app/dashboard')"
    why_human: "Requires running session; client-side redirect logic cannot be verified without a browser"
  - test: "Visual layout of /signup and /create-org matches login page"
    expected: "Centered card, logo row, correct heading copy, tab layout on signup, slug status icons on create-org"
    why_human: "Visual correctness requires browser rendering"
---

# Phase 15: Self-Service Signup + Org Creation — Verification Report

**Phase Goal:** Users can self-service sign up and create their own organization; authenticated users without a tenant are redirected to org creation
**Verified:** 2026-04-01T16:00:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | New user can sign up via email/password or Cognito SSO on /signup | ✓ VERIFIED | `web-ui/app/signup/page.tsx` exists with tabbed Credentials + SSO; `fetch("/api/auth/signup")` + `signIn("credentials")` for credentials; `signIn("cognito", ...)` for SSO |
| 2 | After login, user without a tenant is redirected to /create-org by middleware | ✓ VERIFIED | `web-ui/middleware.ts` line 29: `if (!skipNoTenantRedirect && token && !token.tenantId)` → `NextResponse.redirect(createOrgUrl)` |
| 3 | User can create an org (name + slug) and be assigned Owner role automatically | ✓ VERIFIED | `web-ui/app/api/tenants/route.ts` uses `$transaction` to atomically create Tenant + `userTenantRole` with `role: "Owner"` |
| 4 | Slug uniqueness is enforced with real-time availability check | ✓ VERIFIED | `web-ui/app/api/tenants/check-slug/route.ts` queries `prisma.tenant.findUnique({ where: { slug } })`; `create-org/page.tsx` calls it on blur with 300ms debounce and shows CheckCircle2/XCircle icons |
| 5 | Login page links to signup; signup page links back to login | ✓ VERIFIED | `login/page.tsx` line 253: `Don't have an account?` + `<Link href="/signup">`; `signup/page.tsx` line 291: `Already have an account?` + `<Link href="/login">` |

**Score:** 5/5 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `prisma/schema.prisma` | Tenant model with `slug String? @unique` | ✓ VERIFIED | Line 19: `slug String? @unique` present inside Tenant model; `@@map("tenants")` preserved |
| `prisma/migrations/20260401_add_tenant_slug/migration.sql` | ALTER TABLE + unique index | ✓ VERIFIED | `ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "slug" TEXT` + `CREATE UNIQUE INDEX IF NOT EXISTS "tenants_slug_key"` |
| `web-ui/app/api/auth/signup/route.ts` | POST endpoint for user registration | ✓ VERIFIED | `export async function POST`; `bcrypt.hash(password, 12)`; `prisma.authUser.create`; 409 for duplicate email with exact copy |
| `web-ui/app/api/tenants/check-slug/route.ts` | GET endpoint for slug availability | ✓ VERIFIED | `export async function GET`; slug format regex; `prisma.tenant.findUnique({ where: { slug } })`; returns `{ available: boolean }` |
| `web-ui/app/api/tenants/route.ts` | POST endpoint for tenant creation | ✓ VERIFIED | `export async function POST`; `$transaction`; `tx.tenant.create`; `tx.userTenantRole.create` with `role: "Owner"`; SLUG_TAKEN error handling |
| `web-ui/middleware.ts` | No-tenant redirect + /signup public route | ✓ VERIFIED | `NextResponse.redirect` to `/create-org`; `!token.tenantId` guard; `signup` in matcher exclusion regex; `/create-org` in skipNoTenantRedirect list |
| `web-ui/app/signup/page.tsx` | Signup page with tabbed Credentials + SSO | ✓ VERIFIED | "Create your account" heading; "Sign up to get started" subheading; confirmPassword field; `fetch("/api/auth/signup")`; `signIn("credentials")`; `signIn("cognito")`; link to /login |
| `web-ui/app/create-org/page.tsx` | Org creation page with slug validation | ✓ VERIFIED | "Create your organization" heading; CheckCircle2/XCircle imports; `fetch("/api/tenants/check-slug")`; `fetch("/api/tenants")`; "Slug is available" / "This slug is already taken" text; `update()` called after creation |
| `web-ui/app/login/page.tsx` | Updated footer with signup link | ✓ VERIFIED | `Don't have an account?` + `<Link href="/signup">Sign up</Link>`; `import Link from "next/link"` present |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `web-ui/app/signup/page.tsx` | `/api/auth/signup` | `fetch POST` | ✓ WIRED | Line 57: `fetch("/api/auth/signup", { method: "POST", ... })` with response handling |
| `web-ui/app/signup/page.tsx` | `signIn("credentials")` | auto-login after registration | ✓ WIRED | Line 77: `signIn("credentials", { email, password, redirect: false })` with result check |
| `web-ui/app/create-org/page.tsx` | `/api/tenants/check-slug` | fetch GET on slug blur | ✓ WIRED | Line 67: `fetch(\`/api/tenants/check-slug?slug=...\`)` inside `checkSlugAvailability` called from `handleSlugBlur` |
| `web-ui/app/create-org/page.tsx` | `/api/tenants` | fetch POST on form submit | ✓ WIRED | Line 89: `fetch("/api/tenants", { method: "POST", ... })` with 409/error handling and `update()` on success |
| `web-ui/middleware.ts` | `/create-org` | redirect when authenticated + no tenantId | ✓ WIRED | Line 30-31: `new URL("/create-org", req.url)` + `NextResponse.redirect(createOrgUrl)` |
| `web-ui/app/api/auth/signup/route.ts` | `prisma.authUser.create` | bcrypt hash + Prisma create | ✓ WIRED | `bcrypt.hash(password, 12)` result passed to `prisma.authUser.create({ data: { email, passwordHash, ... } })` |
| `web-ui/app/api/tenants/route.ts` | `prisma.$transaction` | atomic tenant + role creation | ✓ WIRED | `prisma.$transaction(async (tx) => { tx.tenant.create(...); tx.userTenantRole.create(...) })` |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `create-org/page.tsx` | `slugStatus` | `fetch /api/tenants/check-slug` → `prisma.tenant.findUnique` | Yes — DB query against `tenants` table | ✓ FLOWING |
| `create-org/page.tsx` | `onSubmit` result | `fetch /api/tenants` → `prisma.$transaction` → `tx.tenant.create` | Yes — DB write creates real Tenant row | ✓ FLOWING |
| `signup/page.tsx` | `onCredentialsSubmit` result | `fetch /api/auth/signup` → `prisma.authUser.create` | Yes — DB write creates real AuthUser row | ✓ FLOWING |

### Behavioral Spot-Checks

Step 7b: SKIPPED — requires running dev server (Next.js app). API routes cannot be invoked without a live server and authenticated session.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| ONBD-01 | 15-01-PLAN, 15-02-PLAN | Tenant creation generates Tenant record (status=active) with slug, display name, and default settings | ✓ SATISFIED | `POST /api/tenants` creates Tenant with `name`, `slug`, `status: "active"`; Owner role assigned via `userTenantRole.create` |
| ADMIN-01 | 15-01-PLAN (deferred) | `/admin` route accessible only to super admins | DEFERRED | Explicitly deferred to future phase per CONTEXT.md and ROADMAP.md scope note |
| ADMIN-02 | 15-01-PLAN (deferred) | Super admin can list all tenants | DEFERRED | Explicitly deferred |
| ADMIN-03 | 15-01-PLAN (deferred) | Super admin can create a new tenant | DEFERRED | Explicitly deferred |
| ADMIN-04 | 15-01-PLAN (deferred) | Super admin can view tenant details | DEFERRED | Explicitly deferred |
| ADMIN-05 | 15-01-PLAN (deferred) | Super admin can suspend a tenant | DEFERRED | Explicitly deferred |
| ADMIN-06 | 15-01-PLAN (deferred) | Super admin can unsuspend a tenant | DEFERRED | Explicitly deferred |
| ADMIN-07 | 15-01-PLAN (deferred) | Admin actions are audit-logged | DEFERRED | Explicitly deferred |
| SUSP-01 | 15-01-PLAN (deferred) | Middleware checks tenant status on every request | DEFERRED | Explicitly deferred |
| SUSP-02 | 15-01-PLAN (deferred) | Read-only suspended tenants: writes return 423 | DEFERRED | Explicitly deferred |
| SUSP-03 | 15-01-PLAN (deferred) | Locked suspended tenants: all calls return 423 | DEFERRED | Explicitly deferred |
| SUSP-04 | 15-01-PLAN (deferred) | On suspension, active sessions deleted | DEFERRED | Explicitly deferred |

Note: ADMIN-01–07 and SUSP-01–04 are listed in ROADMAP.md as Phase 15 requirements but were explicitly descoped per the ROADMAP.md scope note and CONTEXT.md: "User decided self-service onboarding replaces admin-initiated onboarding. ADMIN-01–07 and SUSP-01–04 deferred to a future phase." These are not gaps — they are intentional deferrals.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `web-ui/app/signup/page.tsx` | 165 | `placeholder="you@example.com"` | ℹ️ Info | HTML input placeholder attribute — not a stub; expected UX pattern |

No blockers or warnings found. The single grep match is an HTML `placeholder` attribute on an email input, not a code stub.

### Human Verification Required

#### 1. End-to-End Signup + Org Creation Flow

**Test:** Start dev server (`cd web-ui && npm run dev`). Visit `/signup`, register with email + password, confirm auto-sign-in occurs, verify middleware redirects to `/create-org`, create an org with a valid slug, confirm redirect to `/app/dashboard` with the new org active.
**Expected:** Full flow completes without errors; session contains `tenantId` after org creation; user lands in the app.
**Why human:** Requires running Next.js server, live PostgreSQL, and a browser session to verify middleware redirect behavior and `update()` session refresh.

#### 2. Cognito SSO Signup

**Test:** On `/signup`, click the SSO tab, click "Sign up with SSO", complete Cognito OAuth flow.
**Expected:** After Cognito auth, user is redirected to `/create-org` (no tenantId yet); org creation flow proceeds normally.
**Why human:** Requires live Cognito configuration and OAuth callback; cannot verify programmatically.

#### 3. Authenticated User Redirect from /signup

**Test:** While logged in with an existing tenant, navigate directly to `/signup`.
**Expected:** `useEffect` in signup page detects `status === "authenticated"` and redirects to `/app/dashboard`.
**Why human:** Client-side redirect logic requires a browser session.

#### 4. Visual Layout

**Test:** Compare `/signup` and `/create-org` pages visually against the login page.
**Expected:** Centered card, logo row (Zap icon + "Nucleus Ops"), correct heading copy, tab layout on signup, slug status icons (CheckCircle2/XCircle) on create-org.
**Why human:** Visual correctness requires browser rendering.

### Gaps Summary

No gaps. All 5 success criteria have full code evidence across all four verification levels (exists, substantive, wired, data-flowing). The 4 human verification items are runtime/visual checks that cannot be confirmed programmatically — they do not indicate missing code.

ADMIN-01–07 and SUSP-01–04 are intentionally deferred per the documented scope decision in CONTEXT.md and ROADMAP.md. They are not missing from this phase.

---

_Verified: 2026-04-01T16:00:00Z_
_Verifier: Claude (gsd-verifier)_
