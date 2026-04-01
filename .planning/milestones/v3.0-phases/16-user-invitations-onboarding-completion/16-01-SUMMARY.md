---
phase: 16-user-invitations-onboarding-completion
plan: "01"
subsystem: invitations
tags: [invitations, cognito, prisma, api-routes, auth]
dependency_graph:
  requires: [phase-13-custom-rbac, phase-14-tenant-context-enforcement, phase-15-signup]
  provides: [invitation-backend, cognito-client, invitation-service, invitation-api-routes, members-api]
  affects: [auth-options, pg-config, prisma-schema]
tech_stack:
  added: ["@aws-sdk/client-cognito-identity-provider (already in package.json)"]
  patterns: [cognito-admin-create-user, invitation-lifecycle, auto-join-existing-users, first-login-acceptance]
key_files:
  created:
    - prisma/migrations/20260401_add_invitation/migration.sql
    - web-ui/lib/cognito-client.ts
    - web-ui/lib/invitation-service.ts
    - web-ui/app/api/invitations/route.ts
    - web-ui/app/api/invitations/[id]/resend/route.ts
    - web-ui/app/api/invitations/[id]/revoke/route.ts
    - web-ui/app/api/settings/members/route.ts
  modified:
    - prisma/schema.prisma
    - web-ui/lib/db/pg-config.ts
    - web-ui/lib/auth-options.ts
decisions:
  - "Dynamic import() for InvitationService in session callback avoids circular dependency"
  - "acceptPendingInvitation wrapped in try/catch so invitation failures never break login"
  - "getTenantClient for invitation queries; getPrismaClient for AuthUser/UserTenantRole (platform-level)"
metrics:
  duration_minutes: 4
  completed_date: "2026-04-01"
  tasks_completed: 2
  files_changed: 10
---

# Phase 16 Plan 01: Invitation Backend Summary

**One-liner:** Cognito AdminCreateUser invitation flow with Prisma Invitation model, InvitationService (create/list/resend/revoke/accept), 4 API routes, and first-login auto-acceptance in the session callback.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Prisma Invitation model + Cognito client + InvitationService | 9a39944 | prisma/schema.prisma, migration.sql, cognito-client.ts, invitation-service.ts, pg-config.ts |
| 2 | API routes + auth callback hook | 6051613 | invitations/route.ts, [id]/resend/route.ts, [id]/revoke/route.ts, settings/members/route.ts, auth-options.ts |

## What Was Built

**Prisma Invitation model** (`prisma/schema.prisma`): fields id, tenantId, email, role, invitedBy, status (pending|accepted|revoked|expired), createdAt, expiresAt. Unique constraint on (tenantId, email, status) prevents duplicate pending invites. Added to TENANT_SCOPED_MODELS so getTenantClient middleware auto-scopes all queries.

**Cognito client singleton** (`web-ui/lib/cognito-client.ts`): `getCognitoClient()` follows the same lazy-init pattern as `getDynamoDBDocumentClient()`. Exports `COGNITO_USER_POOL_ID` from env.

**InvitationService** (`web-ui/lib/invitation-service.ts`): static class with 5 methods:
- `createInvitation`: checks for duplicate pending invite and existing membership, then either auto-joins existing AuthUser (D-08) or calls AdminCreateUser for new users (D-04)
- `listInvitations`: fetches all invitations, marks expired ones on read
- `resendInvitation`: calls AdminCreateUser with `MessageAction: RESEND`, resets expiresAt
- `revokeInvitation`: calls AdminDisableUser (with catch for missing users), marks revoked
- `acceptPendingInvitation`: finds all pending invitations by email, creates UserTenantRole if missing, marks accepted — called from session callback

**API routes**: POST/GET `/api/invitations`, POST `/api/invitations/[id]/resend`, POST `/api/invitations/[id]/revoke`, GET `/api/settings/members`. All follow the authorize → getSessionTenantId → service call → NextResponse.json pattern.

**Auth callback hook** (`web-ui/lib/auth-options.ts`): session callback now checks for pending invitations when `utr` is null, calls `acceptPendingInvitation` via dynamic import (avoids circular dependency), re-queries UserTenantRole after acceptance. Wrapped in try/catch so failures never break login.

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — all methods are fully implemented. Cognito calls will fail in local dev without a real user pool configured, but that is expected behavior (not a stub).

## Self-Check: PASSED

- `prisma/schema.prisma` contains `model Invitation` — FOUND
- `prisma/migrations/20260401_add_invitation/migration.sql` — FOUND
- `web-ui/lib/cognito-client.ts` — FOUND
- `web-ui/lib/invitation-service.ts` — FOUND
- `web-ui/app/api/invitations/route.ts` — FOUND
- `web-ui/app/api/invitations/[id]/resend/route.ts` — FOUND
- `web-ui/app/api/invitations/[id]/revoke/route.ts` — FOUND
- `web-ui/app/api/settings/members/route.ts` — FOUND
- Commit 9a39944 — FOUND
- Commit 6051613 — FOUND
- `npx prisma generate` exits 0 — PASSED
- `npx tsc --noEmit` — 4 pre-existing errors in chat/route.ts, no new errors introduced
