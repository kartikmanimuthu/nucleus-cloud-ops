---
phase: 16-user-invitations-onboarding-completion
verified: 2026-04-01T00:00:00Z
status: gaps_found
score: 1/5 success criteria verified
re_verification: false
gaps:
  - truth: "Tenant admin can send an invitation email with a pre-assigned role; email arrives via Resend with a valid accept link"
    status: failed
    reason: "Implementation uses Cognito AdminCreateUser (which sends a Cognito temp-password email) instead of Resend. No Resend package in package.json, no email sending code in invitation-service.ts, no cryptographic token field in the Invitation model, and no /auth/accept-invite page."
    artifacts:
      - path: "web-ui/lib/invitation-service.ts"
        issue: "Calls Cognito AdminCreateUser only — no Resend API call, no token generation"
      - path: "prisma/schema.prisma"
        issue: "Invitation model has no token field; migration SQL has no token column"
    missing:
      - "resend package in web-ui/package.json"
      - "token field (cuid/crypto) in Invitation model + migration SQL"
      - "Resend email send call in InvitationService.createInvitation with accept link URL"

  - truth: "New user accepting an invitation can set a password and land in the correct tenant with the correct role"
    status: failed
    reason: "No /auth/accept-invite page exists anywhere in the codebase. Without this page, a new user has no way to accept an invitation via a link, set a password, and be placed in the correct tenant."
    artifacts:
      - path: "web-ui/app/auth/accept-invite/page.tsx"
        issue: "MISSING — file does not exist"
    missing:
      - "web-ui/app/auth/accept-invite/page.tsx — token validation, password set form, tenant join on submit"
      - "web-ui/app/api/invitations/accept/route.ts (or similar) — validate token, create UserTenantRole, mark accepted"

  - truth: "Invitation link expires after 48 hours; expired or revoked links show an appropriate error"
    status: failed
    reason: "Invitation expiry is set to 7 days (7 * 24 * 60 * 60 * 1000) in invitation-service.ts, not 48 hours as required by INVT-02 and ONBD-02. Additionally, without an accept-invite page, there is no UI to show an expired/revoked error to the user."
    artifacts:
      - path: "web-ui/lib/invitation-service.ts"
        issue: "expiresAt = now + 7 days (line 55, 165) — should be 48 hours per INVT-02"
    missing:
      - "Change expiry to 48h: Date.now() + 48 * 60 * 60 * 1000"
      - "Accept-invite page to surface expired/revoked error states"

  - truth: "Existing user accepting an invitation is added to the new tenant without losing access to their existing tenants"
    status: partial
    reason: "Auto-join for existing AuthUsers works correctly (UserTenantRole created immediately, existing roles untouched). However, the flow bypasses any user consent — the user is silently added to the tenant without clicking an accept link. INVT-05 implies an explicit accept action."
    artifacts:
      - path: "web-ui/lib/invitation-service.ts"
        issue: "Auto-join is silent — no accept-invite flow for existing users either"
    missing:
      - "Accept-invite page should handle existing users too (token validates, user clicks Accept, UserTenantRole created)"
human_verification:
  - test: "Role dropdown in Invite Member dialog"
    expected: "Dropdown only shows roles at or below the current user's role level (e.g., Admin cannot invite Owner)"
    why_human: "Role filtering logic requires a live session to verify the level comparison works correctly"
  - test: "Cognito AdminCreateUser email delivery"
    expected: "Invited user receives a Cognito temporary password email"
    why_human: "Requires a real Cognito user pool configured in the environment"
---

# Phase 16: User Invitations + Onboarding Completion — Verification Report

**Phase Goal:** Tenant admins can invite users via email; invited users can join the tenant and set up their accounts
**Verified:** 2026-04-01
**Status:** gaps_found
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (from ROADMAP.md Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Tenant admin can send an invitation email with a pre-assigned role; email arrives via Resend with a valid accept link | ✗ FAILED | No Resend package, no token field, Cognito email only |
| 2 | New user accepting an invitation can set a password and land in the correct tenant with the correct role | ✗ FAILED | No /auth/accept-invite page exists |
| 3 | Existing user accepting an invitation is added to the new tenant without losing access to their existing tenants | ⚠️ PARTIAL | Auto-join works but is silent — no explicit accept flow |
| 4 | Invitation link expires after 48 hours; expired or revoked links show an appropriate error | ✗ FAILED | 7-day expiry (not 48h); no accept-invite page to show errors |
| 5 | Tenant admin can view pending invitations and revoke or resend them from the members page | ✓ VERIFIED | Members page, InvitationsTable, resend cooldown, revoke AlertDialog all present and wired |

**Score:** 1/5 success criteria verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `prisma/schema.prisma` | Invitation model | ✓ VERIFIED | model Invitation with all fields, @@map("invitations") |
| `prisma/migrations/20260401_add_invitation/migration.sql` | CREATE TABLE invitations | ✓ VERIFIED | Table + indexes + CHECK constraint present |
| `web-ui/lib/cognito-client.ts` | CognitoIdentityProviderClient singleton | ✓ VERIFIED | getCognitoClient() + COGNITO_USER_POOL_ID exported |
| `web-ui/lib/invitation-service.ts` | InvitationService static class | ✓ VERIFIED | 256 lines, all 5 methods implemented |
| `web-ui/app/api/invitations/route.ts` | POST + GET endpoints | ✓ VERIFIED | Both handlers, authorize + service calls |
| `web-ui/app/api/invitations/[id]/resend/route.ts` | POST resend | ✓ VERIFIED | authorize("update","User") + resendInvitation |
| `web-ui/app/api/invitations/[id]/revoke/route.ts` | POST revoke | ✓ VERIFIED | authorize("delete","User") + revokeInvitation |
| `web-ui/app/api/settings/members/route.ts` | GET members list | ✓ VERIFIED | userTenantRole.findMany with tenant scoping |
| `web-ui/app/app/settings/members/page.tsx` | Members management page | ✓ VERIFIED | 179 lines, fetches both APIs on mount |
| `web-ui/components/settings/invite-member-dialog.tsx` | Invite dialog | ✓ VERIFIED | zod validation, correct copy, POSTs to /api/invitations |
| `web-ui/components/settings/members-table.tsx` | Members table | ✓ VERIFIED | Empty state copy matches UI-SPEC |
| `web-ui/components/settings/invitations-table.tsx` | Invitations table with actions | ✓ VERIFIED | 248 lines, cooldown, AlertDialog, correct copy |
| `web-ui/app/auth/accept-invite/page.tsx` | Accept invite page | ✗ MISSING | Does not exist anywhere in codebase |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `app/api/invitations/route.ts` | `lib/invitation-service.ts` | InvitationService.createInvitation() | ✓ WIRED | Direct import + call confirmed |
| `lib/invitation-service.ts` | `lib/cognito-client.ts` | getCognitoClient() | ✓ WIRED | Import + call on lines 10, 84, 157, 190 |
| `lib/auth-options.ts` | `lib/invitation-service.ts` | acceptPendingInvitation (dynamic import) | ✓ WIRED | Lines 133–134, wrapped in try/catch |
| `app/app/settings/members/page.tsx` | `/api/settings/members` | fetch in useEffect | ✓ WIRED | Line 56 |
| `app/app/settings/members/page.tsx` | `/api/invitations` | fetch in useEffect | ✓ WIRED | Line 74 |
| `components/settings/invite-member-dialog.tsx` | `/api/invitations` | fetch POST on submit | ✓ WIRED | handleSubmit calls onSubmit prop; page.tsx POSTs on line 94 |
| `lib/invitation-service.ts` | Resend email service | sendEmail with accept link | ✗ NOT_WIRED | No Resend import, no email send call |
| `lib/invitation-service.ts` | `/auth/accept-invite` | token in invitation record | ✗ NOT_WIRED | No token field, no URL construction |

---

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `members/page.tsx` | `members` | GET /api/settings/members → userTenantRole.findMany | Yes — real DB query | ✓ FLOWING |
| `members/page.tsx` | `invitations` | GET /api/invitations → invitation.findMany | Yes — real DB query | ✓ FLOWING |
| `invite-member-dialog.tsx` | form submit | POST /api/invitations → InvitationService.createInvitation | Yes — DB write + Cognito call | ✓ FLOWING |

---

### Behavioral Spot-Checks

| Behavior | Check | Result | Status |
|----------|-------|--------|--------|
| Invitation model in schema | `grep "model Invitation" prisma/schema.prisma` | Found, 14 fields | ✓ PASS |
| Migration SQL creates table | `cat migration.sql` | CREATE TABLE + indexes + CHECK | ✓ PASS |
| InvitationService methods | grep for all 5 static methods | All present | ✓ PASS |
| Auth callback wired | `grep acceptPendingInvitation lib/auth-options.ts` | Lines 133–134 | ✓ PASS |
| Members tab in settings | `grep "members" app/app/settings/page.tsx` | TabsTrigger value="members" line 48 | ✓ PASS |
| Accept-invite page | `find app -path "*accept*"` | No results | ✗ FAIL |
| Resend package | `grep resend web-ui/package.json` | No results | ✗ FAIL |
| Token field in Invitation | `grep token prisma/schema.prisma` (Invitation block) | No results | ✗ FAIL |
| Expiry is 48h | `grep "48 \*" invitation-service.ts` | Uses 7 * 24 (7 days) | ✗ FAIL |
| TypeScript errors | `npx tsc --noEmit` | 4 pre-existing errors in chat/route.ts only | ✓ PASS (no new errors) |

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| INVT-01 | 16-01, 16-02 | Admin can invite users by email with pre-assigned role from settings/members page | ✓ SATISFIED | Members page + invite dialog + POST /api/invitations all present |
| INVT-02 | 16-01 | Cryptographically secure token with 48h expiry stored in Invitation table | ✗ BLOCKED | No token field in model; expiry is 7 days not 48h |
| INVT-03 | 16-01 | Email sent via Resend with accept link to /auth/accept-invite?token= | ✗ BLOCKED | No Resend package; no token; no accept-invite page |
| INVT-04 | 16-01 | New user accepting invite sets password; account created and joined to tenant | ✗ BLOCKED | No accept-invite page; no password-set flow |
| INVT-05 | 16-01 | Existing user accepting invite added to tenant without losing existing tenants | ⚠️ PARTIAL | Auto-join works silently; no explicit accept flow |
| INVT-06 | 16-01, 16-02 | Admin can view pending invitations, resend, revoke from settings | ✓ SATISFIED | InvitationsTable with resend cooldown + revoke AlertDialog |
| ONBD-02 | 16-01 | Root user receives invitation email with signed token (48h expiry) | ✗ BLOCKED | Same as INVT-02/03 — no token, no Resend, wrong expiry |
| ONBD-03 | 16-01 | Root user can accept invite via Credentials or Cognito; assigned Owner role | ✗ BLOCKED | No accept-invite page |

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `web-ui/lib/invitation-service.ts` | 55, 165 | `7 * 24 * 60 * 60 * 1000` (7-day expiry) | 🛑 Blocker | Contradicts INVT-02 and ONBD-02 which require 48h |

No TODO/FIXME/placeholder comments found in phase 16 files. No empty return stubs. TypeScript compiles with only 4 pre-existing errors in an unrelated file (chat/route.ts).

---

### Human Verification Required

#### 1. Role dropdown level enforcement

**Test:** Log in as an Admin user, open Settings → Members → Invite Member. Check the Role dropdown options.
**Expected:** Only "Admin", "Member", "Viewer" appear — "Owner" is absent because Admin cannot assign a role above their own level.
**Why human:** Role filtering is client-side based on session role level; requires a live session with a known role to verify.

#### 2. Cognito email delivery

**Test:** With a real Cognito user pool configured (`COGNITO_USER_POOL_ID` set), invite a new email address.
**Expected:** The invitee receives a Cognito temporary password email.
**Why human:** Requires real AWS Cognito credentials; cannot verify email delivery programmatically.

---

### Gaps Summary

The implementation diverged from the requirements at a design level. The requirements (INVT-02, INVT-03, INVT-04, ONBD-02, ONBD-03) and all 5 ROADMAP success criteria specify a **Resend + cryptographic token + /auth/accept-invite page** flow. The implementation instead uses **Cognito AdminCreateUser** which sends Cognito's own temporary password email — a valid alternative design, but one that does not satisfy the specified requirements.

Three concrete things are missing:

1. **Token field + Resend email** — Invitation model needs a `token` column (cuid or crypto.randomBytes), invitation-service needs to call Resend with an accept link URL, and expiry must be 48h not 7 days.

2. **Accept-invite page** (`web-ui/app/auth/accept-invite/page.tsx`) — Validates the token, shows a set-password form for new users (or a join-org confirmation for existing users), calls an accept API route, then redirects to the app.

3. **Accept API route** — Validates token, checks expiry/revoked status, creates UserTenantRole with the invitation's role, marks invitation accepted.

SC-5 (members page with resend/revoke) is fully verified. The backend infrastructure (Prisma model, Cognito client, InvitationService CRUD, API routes, auth callback) is solid and can be reused — it just needs the token/Resend layer added on top.

---

_Verified: 2026-04-01_
_Verifier: Kiro (gsd-verifier)_
