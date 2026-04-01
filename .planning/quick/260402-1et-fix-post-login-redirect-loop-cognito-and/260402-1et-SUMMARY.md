---
id: 260402-1et
title: Fix post-login redirect loop — Cognito and credentials login not navigating to app
date: 2026-04-02
status: complete
phase: quick
plan: 260402-1et
subsystem: auth
tags: [nextauth, jwt, session, cognito, credentials]
key-files:
  modified:
    - web-ui/lib/auth-options.ts
decisions:
  - Switch session.strategy to "jwt" so withAuth middleware getToken() decodes cookie correctly
  - Move invitation acceptance from session callback to jwt callback (guarded by `if (user)`)
  - Distinguish SSO-only users in authorize with descriptive thrown error
metrics:
  duration: 137s
  completed: 2026-04-02
  tasks: 2
  files: 1
---

# Quick Task 260402-1et: Fix post-login redirect loop Summary

**One-liner:** Switched NextAuth session strategy from `"database"` to `"jwt"` so `withAuth` middleware decodes the session cookie correctly, eliminating the infinite redirect loop on protected routes.

## Tasks Completed

| Task | Description | Commit |
|------|-------------|--------|
| 1 | Switch session strategy to JWT, fix callbacks | e7656e1 |
| 2 | Improve credentials error for SSO-only users | e7656e1 |

## What Changed

`web-ui/lib/auth-options.ts`:

- `session.strategy` changed from `"database"` to `"jwt"` — the session cookie is now a signed JWT that `getToken()` in `withAuth` middleware can decode
- `jwt` callback: moved invitation acceptance logic here (was in `session` callback), guarded by `if (user)` so DB queries only run on initial sign-in; added `token.email = user.email`
- `session` callback: now reads from `token` instead of `user` (correct for JWT strategy)
- `authorize`: split the `!user || !user.passwordHash` guard — SSO-only users now get a thrown error with message "This account uses SSO. Please sign in with the SSO tab." instead of a silent `null` return; the login page's existing error handler surfaces this message automatically

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Deferred Issues

Pre-existing syntax error in `web-ui/app/api/chat/route.ts` (unmatched braces) causes `npm run build` to fail. This is out of scope for this fix — it predates these changes and is unrelated to auth.

## Self-Check: PASSED

- `web-ui/lib/auth-options.ts` modified: confirmed
- Commit e7656e1 exists: confirmed
- `npx tsc --noEmit` reports no errors in auth-options.ts: confirmed
