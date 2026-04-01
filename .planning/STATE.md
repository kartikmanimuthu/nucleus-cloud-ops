---
gsd_state_version: 1.0
milestone: v3.0
milestone_name: Multi-Tenancy
status: executing
stopped_at: Completed 16-01-PLAN.md
last_updated: "2026-04-01T17:06:43.269Z"
last_activity: 2026-04-01
progress:
  total_phases: 6
  completed_phases: 4
  total_plans: 15
  completed_plans: 14
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-31)

**Core value:** Standard SaaS multi-tenancy with custom per-module RBAC, tenant lifecycle management, and dual auth
**Current focus:** Phase 16 — user-invitations-onboarding-completion

## Current Position

Phase: 16 (user-invitations-onboarding-completion) — EXECUTING
Plan: 2 of 2
Status: Ready to execute
Last activity: 2026-04-01

Progress: [░░░░░░░░░░] 0%

## Performance Metrics

**Velocity:**

- Total plans completed: 0
- Average duration: -
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

**Recent Trend:**

- Last 5 plans: none yet
- Trend: -

*Updated after each plan completion*
| Phase 12-auth-foundation P01 | 15 | 2 tasks | 5 files |
| Phase 13-custom-rbac P01 | 7 | 2 tasks | 4 files |
| Phase 13-custom-rbac P03 | 12 | 2 tasks | 7 files |
| Phase 13 P03 | 486 | 2 tasks | 7 files |
| Phase 13-custom-rbac P02 | 12 | 2 tasks | 12 files |
| Phase 13 P04 | 8 | 3 tasks | 5 files |
| Phase 14-tenant-context-enforcement P01 | 2449 | 2 tasks | 21 files |
| Phase 14 P02 | 1199 | 2 tasks | 6 files |
| Phase 14 P03 | 18 | 2 tasks | 7 files |
| Phase 14-tenant-context-enforcement P04 | 902 | 1 tasks | 1 files |
| Phase 15 P01 | 21 | 2 tasks | 5 files |
| Phase 15 P02 | 4 | 3 tasks | 4 files |
| Phase 16 P01 | 4 | 2 tasks | 10 files |

## Accumulated Context

### Decisions

- Phases 12–14 are security infrastructure — must complete before any user-facing feature ships
- CASL removal: parallel-run feature flag per route; never delete @casl/ability until every route migrated
- Resend domain verification (SPF/DKIM) must be initiated on Day 1 — DNS propagation takes 24–48h
- Prisma adapter uses AuthUser/AuthAccount/AuthSession (@@map to auth_* tables) to avoid collision with existing Account model
- Database sessions (not JWT) required for suspension enforcement — adds DB lookup per request, acceptable at current scale
- LangGraph thread ID migration script needed before launch (bare UUIDs → tenantId:userId:uuid)
- [Phase 12-auth-foundation]: PrismaAdapter proxy pattern: map AuthUser/AuthAccount/AuthSession to adapter model keys to avoid collision with existing Account model
- [Phase 12-auth-foundation]: Database session strategy (not JWT) confirmed for Phase 12 — required for suspension enforcement in Phase 15
- [Phase 13-custom-rbac]: USE_NEW_RBAC env var (not per-route flags) — all routes migrate together in Plan 02
- [Phase 13-custom-rbac]: [Phase 13-01]: getCustomRolePermissions() stub returns null (deny) — Plan 03 wires real DB lookup
- [Phase 13-custom-rbac]: getCustomRolePermissions already imported from custom-role-service in authorize.ts (Plan 01 pre-wired it) — no stub to replace
- [Phase 13-custom-rbac]: POST /api/settings/roles returns 409 for business rule violations (duplicate name, max limit, predefined name)
- [Phase 13]: getCustomRolePermissions re-exported from authorize.ts for backward-compatible callers
- [Phase 13-custom-rbac]: CASL fully removed — authorize() is now the sole permission path with no feature flag
- [Phase 13-custom-rbac]: TenantRole/UserTenantRole kept in types.ts as persistence types for repository layer
- [Phase 13]: Roles tab navigates to /app/settings/roles sub-page rather than inline TabsContent
- [Phase 14-tenant-context-enforcement]: getTenantClient uses $extends wrapping getPrismaClient() singleton — created per-request, not cached (D-01/D-03)
- [Phase 14-tenant-context-enforcement]: Raw SQL ($executeRaw, $queryRawUnsafe) NOT intercepted by tenant hook — callers must manually scope (D-02)
- [Phase 14-tenant-context-enforcement]: Tenant.status uses plain String with CHECK constraint in migration SQL — consistent with existing pattern
- [Phase 14]: Thread ID format tenantId:userId:timestamp embeds tenant for O(1) validation without DB lookup
- [Phase 14]: Legacy bare threads (no colon) allowed for owning user only — backward compatible with existing DynamoDB data
- [Phase 14]: tenantId guard in processSchedule skips schedules without tenantId (returns 0/0/0) rather than throwing
- [Phase 14]: Discovery Lambda skips entire account if tenant_id unresolvable (fail loudly, no silent default)
- [Phase 14]: DynamoDB fallback path in runFullScan preserved for USE_PG_SCHEDULES=false (backward compat)
- [Phase 14-tenant-context-enforcement]: Integration tests run against real PostgreSQL — structural proof of tenant isolation, not mocked unit logic
- [Phase 15]: slug is String? (nullable) — existing tenants from Phase 14 don't have slugs; new tenants always will
- [Phase 15]: Signup and tenant creation use getPrismaClient() (unscoped) — user has no tenant yet at registration time
- [Phase 15]: Slug uniqueness re-checked inside $transaction — prevents TOCTOU race condition between check-slug and create
- [Phase 15]: /signup excluded from middleware matcher (like /login) — fully public
- [Phase 15]: Auto-sign-in after registration via signIn('credentials') — middleware redirects to /create-org
- [Phase 15]: Session update() after org creation refreshes JWT tenantId before dashboard redirect
- [Phase 16]: Dynamic import() for InvitationService in session callback avoids circular dependency
- [Phase 16]: acceptPendingInvitation wrapped in try/catch so invitation failures never break login

### Pending Todos

- Initiate Resend domain verification (SPF/DKIM) immediately — blocks Phase 16 email delivery

### Blockers/Concerns

None at roadmap creation.

## Session Continuity

Last session: 2026-04-01T17:06:43.265Z
Stopped at: Completed 16-01-PLAN.md
Resume file: None
