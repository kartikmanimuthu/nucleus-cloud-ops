# Phase 18: Accounts & Scheduler Isolation - Context

**Gathered:** 2026-04-03
**Status:** Ready for planning

<domain>
## Phase Boundary

Fix tenant scoping gaps in AWS Accounts and Cost Scheduler CRUD operations. Every list, create, update, delete, search, execution history, and targeted resource query must be correctly scoped to the active tenant. No new capabilities — this phase audits and hardens existing routes and repositories.

**In scope:**
- AWS Accounts: GET list, GET single, POST create, PUT update, DELETE delete, GET resources (ACCT-01–05)
- Cost Scheduler: GET list, POST create, PUT update, DELETE delete, GET execution history, GET/PUT targeted resources (SCHED-01–06)
- Schedule execution history: add Postgres repository + schema table

**Out of scope:**
- Inventory, Agent Ops, Knowledge Base, Channels (Phases 19–20)
- Audit log full sweep (Phase 21 — but audit calls touched in Phase 18 get fixed here)
- Lambda scheduler tenant scoping (separate concern)

</domain>

<decisions>
## Implementation Decisions

### Tenant Client Pattern
- **D-01:** Migrate `AccountPostgresRepository` and `SchedulePostgresRepository` from `getPrismaClient()` to `getTenantClient(tenantId)`. The scoped factory (introduced in v3.0 via Prisma `$extends`) auto-injects `tenant_id` on every query — eliminates the risk of a future query missing the WHERE clause. This is the canonical pattern for all v4.0 repository work.
- **D-02:** All new repositories added in this phase (e.g., `ScheduleExecutionPostgresRepository`) must use `getTenantClient(tenantId)` from the start — never `getPrismaClient()`.

### Cross-Tenant Mutation Protection
- **D-03:** Before any update or delete mutation, perform a pre-flight `findFirst({ where: { id, tenantId } })`. If the record is not found → return HTTP 403 (not 404, not 500). This applies to both account and schedule mutations.
- **D-04:** The 403 response body should follow the existing error shape: `{ success: false, error: 'Forbidden' }`.
- **D-05:** The pre-flight check must happen in the API route layer (not the repository), so the HTTP response code is explicit and auditable.

### Schedule Execution History
- **D-06:** Add a `ScheduleExecutionPostgresRepository` implementing the existing `IScheduleExecutionRepository` interface. Add a `schedule_executions` table to the Prisma schema with `tenantId` as a required field and a composite index on `(tenantId, scheduleId)`.
- **D-07:** Wire the new Postgres repo via the existing feature flag / repository factory pattern (consistent with how account and schedule repos were migrated in v1.0). DynamoDB path remains as fallback until flag is flipped.
- **D-08:** The execution history API routes (`/api/schedules/[scheduleId]/history`, `/api/schedules/[scheduleId]/history/[executionId]`) must pass `tenantId` from `getSessionTenantId()` to the repository.

### Audit Log Calls (Partial Fix)
- **D-09:** Any `AuditService.logUserAction(...)` call in files touched by Phase 18 must be updated to include `tenantId`. This is a forward-pull of part of AUDT-02 (Phase 21) — Phase 21 will handle modules not touched here.
- **D-10:** `tenantId` should be sourced from `getSessionTenantId()` at the route level and passed into the audit call, consistent with how it's passed to service methods.

### Uncommitted Changes (Quick Task 260403-t3i)
- **D-11:** The working tree has uncommitted changes in `web-ui/app/api/accounts/[accountId]/resources/route.ts`, `web-ui/app/api/accounts/[accountId]/route.ts`, `web-ui/app/api/accounts/[accountId]/schedules/route.ts`, `web-ui/app/api/accounts/route.ts`, `web-ui/app/api/chat/route.ts`, `web-ui/app/api/schedules/**`, and `web-ui/lib/db/repositories/schedule-execution/dynamo.ts` from quick task `260403-t3i`. The planner must read the current state of these files (not assume clean state) before writing plans.

### Claude's Discretion
- Exact Prisma schema field names and index names for `schedule_executions` table
- Whether to add a `schedule_executions` migration file or rely on `prisma db push` for dev
- Order of plans within the phase (accounts first vs schedules first)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Requirements
- `.planning/REQUIREMENTS.md` — ACCT-01–05, SCHED-01–06 acceptance criteria

### Tenant Isolation Pattern
- `web-ui/lib/db/pg-config.ts` — `getTenantClient(tenantId)` factory implementation
- `web-ui/lib/db/repositories/account/postgres.ts` — current account repo (uses getPrismaClient — to be migrated)
- `web-ui/lib/db/repositories/schedule/postgres.ts` — current schedule repo (uses getPrismaClient — to be migrated)
- `web-ui/lib/db/repositories/schedule-execution/dynamo.ts` — existing DynamoDB execution repo (interface to implement in Postgres)
- `web-ui/lib/db/repositories/schedule-execution/interface.ts` — IScheduleExecutionRepository interface

### API Routes (all modified in working tree — read current state)
- `web-ui/app/api/accounts/route.ts`
- `web-ui/app/api/accounts/[accountId]/route.ts`
- `web-ui/app/api/accounts/[accountId]/resources/route.ts`
- `web-ui/app/api/accounts/[accountId]/schedules/route.ts`
- `web-ui/app/api/schedules/route.ts`
- `web-ui/app/api/schedules/[scheduleId]/route.ts`
- `web-ui/app/api/schedules/[scheduleId]/history/route.ts`
- `web-ui/app/api/schedules/[scheduleId]/history/[executionId]/route.ts`
- `web-ui/app/api/schedules/[scheduleId]/execute/route.ts`
- `web-ui/app/api/schedules/[scheduleId]/toggle/route.ts`

### Auth / Session
- `web-ui/lib/auth-session.ts` — `getSessionTenantId()` helper

### Audit
- `web-ui/lib/audit-service.ts` — `AuditService.logUserAction()` signature

### Prisma Schema
- `web-ui/prisma/schema.prisma` — existing table definitions; add `schedule_executions` here

</canonical_refs>
