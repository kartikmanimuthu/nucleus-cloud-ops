---
phase: 15-super-admin-onboarding-suspension
plan: 02
subsystem: ui
tags: [nextjs, react, middleware, signup, onboarding, multitenancy]

requires:
  - phase: 15-super-admin-onboarding-suspension
    plan: 01
    provides: POST /api/auth/signup, GET /api/tenants/check-slug, POST /api/tenants

provides:
  - Signup page with tabbed Credentials + SSO at /signup
  - Create-org page with slug availability check at /create-org
  - Middleware no-tenant redirect to /create-org
  - Login page footer link to /signup

affects: [16-invitations]

tech-stack:
  added: []
  patterns:
    - "Signup mirrors login page layout exactly — same card, logo, tabs pattern"
    - "Slug availability check uses debounced onBlur (300ms) with visual status icons"
    - "Middleware no-tenant redirect skips /create-org, /api, /login, /signup, /, /docs"

key-files:
  created:
    - web-ui/app/signup/page.tsx
    - web-ui/app/create-org/page.tsx
  modified:
    - web-ui/middleware.ts
    - web-ui/app/login/page.tsx

key-decisions:
  - "/signup excluded from middleware matcher (like /login) — fully public, no auth check needed"
  - "/create-org NOT excluded from matcher — requires auth but not tenantId"
  - "Auto-sign-in after registration via signIn('credentials') — middleware then redirects to /create-org"
  - "Session update() called after org creation to refresh tenantId in JWT before redirect"

patterns-established:
  - "Public auth pages (/login, /signup) excluded from middleware matcher"
  - "Post-auth redirect chain: signup -> auto-login -> middleware redirect -> create-org -> dashboard"

requirements-completed: [ONBD-01]

duration: 4min
completed: 2026-04-01
---

# Phase 15 Plan 02: Middleware + UI Pages for Self-Service Signup Summary

**Middleware no-tenant redirect + signup page (tabbed credentials/SSO) + create-org page (slug availability check) + login footer link**

## Performance

- **Duration:** 4 min
- **Started:** 2026-04-01T15:27:36Z
- **Completed:** 2026-04-01T15:31:45Z
- **Tasks:** 3 (2 auto + 1 human-verify checkpoint)
- **Files modified:** 4

## Accomplishments
- Middleware redirects authenticated users without tenantId to /create-org; /signup added as public route
- Signup page mirrors login layout with email/password/confirm-password + SSO tabs, auto-signs-in after registration
- Create-org page has real-time slug availability check (debounced 300ms onBlur) with CheckCircle2/XCircle status icons
- Login page footer updated from placeholder "Contact Support" to "Don't have an account? Sign up"

## Task Commits

1. **Task 1: Middleware no-tenant redirect + signup/create-org public routes** - `6a83cdb` (feat)
2. **Task 2: Signup page + create-org page + login footer link** - `e14a4fd` (feat)
3. **Task 3: Human verification** - checkpoint verified (no commit)

## Files Created/Modified
- `web-ui/middleware.ts` - No-tenant redirect, /signup public route, matcher updated
- `web-ui/app/signup/page.tsx` - New signup page with tabbed credentials + SSO
- `web-ui/app/create-org/page.tsx` - New org creation page with slug availability check
- `web-ui/app/login/page.tsx` - Footer updated with signup link

## Decisions Made
- /signup excluded from middleware matcher (same as /login) so it's fully public
- /create-org stays in matcher — needs auth check (user must be logged in to create org)
- Auto-sign-in after registration uses signIn("credentials") then router.push — middleware handles the redirect to /create-org
- Session update() called after org creation to refresh JWT with new tenantId

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## Known Stubs
None - all data sources are wired to Plan 01 API endpoints.

## User Setup Required
None.

## Next Phase Readiness
- Phase 15 is complete — all success criteria met
- Self-service signup + org creation flow verified end-to-end
- Phase 16 (User Invitations) can proceed

---
*Phase: 15-super-admin-onboarding-suspension*
*Completed: 2026-04-01*
