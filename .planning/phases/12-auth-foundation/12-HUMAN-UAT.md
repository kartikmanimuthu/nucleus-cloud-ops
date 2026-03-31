---
status: partial
phase: 12-auth-foundation
source: [12-VERIFICATION.md]
started: "2026-03-31"
updated: "2026-03-31"
---

## Current Test

[awaiting human testing]

## Tests

### 1. Credentials login flow
expected: Start dev server, navigate to `/login`, submit email + password on "Email & Password" tab — session created with `{ id, email, tenantId, role, isSuperAdmin }`
result: [pending]

### 2. Cognito SSO flow
expected: Click "Sign in with SSO" tab — redirect to Cognito, session normalized on callback with identical shape
result: [pending]

### 3. Login page UI
expected: Two tabs render correctly, inline validation errors appear on empty/invalid submit, loading states work
result: [pending]

### 4. Lockout behavior
expected: Submit 5 wrong passwords — account locks for 15 minutes with appropriate error message
result: [pending]

### 5. Admin route guard
expected: As non-super-admin, navigate to `/admin` — 403 response returned
result: [pending]

## Summary

total: 5
passed: 0
issues: 0
pending: 5
skipped: 0
blocked: 0

## Gaps
