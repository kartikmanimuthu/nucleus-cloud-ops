---
status: partial
phase: 15-super-admin-onboarding-suspension
source: [15-VERIFICATION.md]
started: 2026-04-01T15:45:00.000Z
updated: 2026-04-01T15:45:00.000Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. End-to-end signup flow
expected: Register with email/password -> auto-login -> middleware redirect to /create-org -> create org with name+slug -> land in /app/dashboard
result: [pending]

### 2. Cognito SSO signup
expected: SSO tab on /signup triggers Cognito OAuth; after auth, user without tenant lands on /create-org
result: [pending]

### 3. Authenticated redirect from /signup
expected: Logged-in user visiting /signup gets redirected to /app/dashboard by client-side useEffect
result: [pending]

### 4. Visual layout verification
expected: /signup and /create-org match login page card layout; slug availability icons render correctly
result: [pending]

## Summary

total: 4
passed: 0
issues: 0
pending: 4
skipped: 0
blocked: 0

## Gaps
