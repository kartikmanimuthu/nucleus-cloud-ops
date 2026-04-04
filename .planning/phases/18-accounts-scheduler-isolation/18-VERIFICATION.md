---
phase: 18-accounts-scheduler-isolation
verified: 2026-04-03T18:35:00Z
status: passed
score: 5/5 must-haves verified
human_verification:
  - test: "Cross-tenant 403 in browser"
    expected: "Authenticated user from Tenant A cannot update or delete an account/schedule belonging to Tenant B — receives 403 in the UI"
    why_human: "Pre-flight check logic is correct in code but end-to-end session/tenant resolution requires a live auth session to confirm getSessionTenantId() returns the right value"
---

# Phase 18: Accounts & Scheduler Isolation Verification Report

**Phase Goal:** Harden tenant scoping in AWS Accounts and Cost Scheduler CRUD — every list, create, update, delete, search, execution history, and targeted resource query scoped to the active tenant.
**Verified:** 2026-04-03
**Status:** PASSED
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | User sees only their tenant's AWS accounts | VERIFIED | `AccountPostgresRepository.getAccounts` uses `getTenantClient(tenantId)` with `where: { tenantId }` on both `count` and `findMany` |
| 2 | Creating an AWS account stores the active tenantId on insert | VERIFIED | `createAccount` calls `getTenantClient(tenantId).account.create({ data: { tenantId, ... } })` — tenantId is explicit in the data payload |
| 3 | Updating or deleting an account belonging to a different tenant returns 403 | VERIFIED | Both `PUT` and `DELETE` in `/api/accounts/[accountId]/route.ts` call `AccountService.getAccount(accountId, tenantId)` before mutating; return `{ success: false, error: 'Forbidden' }` with status 403 if not found |
| 4 | Schedule list, execution history, and targeted resources return only the active tenant's data | VERIFIED | `SchedulePostgresRepository.getSchedules` scopes by `where: { tenantId }`; history routes pass `tenantId` from `getSessionTenantId()` to both schedule lookup and `ScheduleExecutionService`; resources route derives from tenant-scoped schedule query |
| 5 | Creating a schedule stores the active tenantId on insert; search/filter queries include tenant scope | VERIFIED | `createSchedule` passes `tenantId` in `data`; `getSchedules` builds `where: { tenantId }` before all filters |

**Score:** 5/5 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `web-ui/lib/db/repositories/account/postgres.ts` | All methods use getTenantClient | VERIFIED | Zero `getPrismaClient` calls; all 5 methods (`getAccounts`, `getAccount`, `createAccount`, `updateAccount`, `deleteAccount`) use `getTenantClient(tenantId)` |
| `web-ui/lib/db/repositories/schedule/postgres.ts` | All methods use getTenantClient | VERIFIED | All 4 methods use `getTenantClient(tenantId)`; `getSchedules` builds `where: { tenantId }` before any optional filters |
| `web-ui/lib/db/repositories/schedule-execution/postgres.ts` | Exists, uses getTenantClient | VERIFIED | All 3 methods (`logExecution`, `getExecutionHistory`, `getRecentExecutions`) use `getTenantClient(tenantId)` with explicit `where: { tenantId }` |
| `web-ui/app/api/accounts/[accountId]/route.ts` | 403 pre-flight on PUT/DELETE | VERIFIED | Both handlers call `AccountService.getAccount(accountId, tenantId)` and return 403 before any mutation |
| `web-ui/app/api/schedules/[scheduleId]/route.ts` | 403 pre-flight on PUT/DELETE | VERIFIED | Both handlers call `ScheduleService.getSchedule(scheduleId, undefined, tenantId)` and return 403 before any mutation |
| `web-ui/app/api/schedules/[scheduleId]/toggle/route.ts` | 403 pre-flight | VERIFIED | Pre-flight check present; returns 403 if schedule not found in tenant scope |
| `web-ui/app/api/schedules/[scheduleId]/history/route.ts` | tenantId passed to service | VERIFIED | `getSessionTenantId()` called at top; passed to both `ScheduleService.getSchedule` and `ScheduleExecutionService.getExecutionsForSchedule` |
| `web-ui/app/api/schedules/[scheduleId]/history/[executionId]/route.ts` | tenantId passed to service | VERIFIED | `getSessionTenantId()` called; passed to `ScheduleService.getSchedule` and `ScheduleExecutionService.getExecutionById` |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `accounts/[accountId]/route.ts` PUT/DELETE | `AccountService.getAccount` | pre-flight before mutation | WIRED | Returns 403 if `getAccount` returns null for the session's tenantId |
| `schedules/[scheduleId]/route.ts` PUT/DELETE | `ScheduleService.getSchedule(id, undefined, tenantId)` | pre-flight before mutation | WIRED | Returns 403 if schedule not in tenant scope |
| `schedules/[scheduleId]/history/route.ts` | `ScheduleExecutionService.getExecutionsForSchedule(..., tenantId)` | `getSessionTenantId()` | WIRED | tenantId flows from session → service → repo `where: { tenantId, scheduleId }` |
| `accounts/[accountId]/resources/route.ts` | `ScheduleService.getSchedules({ accountId, tenantId })` | `getSessionTenantId()` | WIRED | Resources derived from tenant-scoped schedule query — no separate resource table needed |
| `ScheduleExecutionPostgresRepository.getExecutionHistory` | `getTenantClient(tenantId).scheduleExecution.findMany` | `where: { tenantId, scheduleId }` | WIRED | Double-scoped by both tenantId and scheduleId |

---

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `AccountPostgresRepository.getAccounts` | `rows` | `getTenantClient(tenantId).account.findMany({ where: { tenantId } })` | Yes — Prisma DB query | FLOWING |
| `SchedulePostgresRepository.getSchedules` | `rows` | `getTenantClient(tenantId).schedule.findMany({ where: { tenantId } })` | Yes — Prisma DB query | FLOWING |
| `ScheduleExecutionPostgresRepository.getExecutionHistory` | `rows` | `getTenantClient(tenantId).scheduleExecution.findMany({ where: { tenantId, scheduleId } })` | Yes — Prisma DB query | FLOWING |

---

### Behavioral Spot-Checks

Step 7b: SKIPPED — requires live auth session and running DB to exercise `getSessionTenantId()` + Prisma queries. Routed to human verification.

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| ACCT-01 | 18-01 | List only tenant's AWS accounts | SATISFIED | `getAccounts` scopes by `where: { tenantId }` |
| ACCT-02 | 18-01 | Create account scoped to tenant | SATISFIED | `createAccount` inserts with `tenantId` in data |
| ACCT-03 | 18-01 | Update account only within tenant | SATISFIED | PUT pre-flight 403 + `updateAccount` uses `tenantId_accountId` composite key |
| ACCT-04 | 18-01 | Delete account only within tenant | SATISFIED | DELETE pre-flight 403 + `deleteAccount` uses `where: { tenantId, accountId }` |
| ACCT-05 | 18-01 | Search/filter accounts within tenant | SATISFIED | All filters applied after `where: { tenantId }` base clause |
| SCHED-01 | 18-02 | List only tenant's schedules | SATISFIED | `getSchedules` base `where: { tenantId }` |
| SCHED-02 | 18-02 | Create schedule scoped to tenant | SATISFIED | `createSchedule` inserts with `tenantId` in data |
| SCHED-03 | 18-02 | Update schedule only within tenant | SATISFIED | PUT pre-flight 403 + `updateSchedule` uses `tenantId_scheduleId` composite key |
| SCHED-04 | 18-02 | Delete schedule only within tenant | SATISFIED | DELETE pre-flight 403 + `deleteSchedule` uses `where: { tenantId, scheduleId }` |
| SCHED-05 | 18-02 | Execution history scoped to tenant | SATISFIED | History routes pass tenantId; repo scopes by `where: { tenantId, scheduleId }` |
| SCHED-06 | 18-02 | Targeted resources scoped to tenant | SATISFIED | Resources stored as JSON on schedule record; resources route derives from tenant-scoped `getSchedules` call |

**Documentation note:** REQUIREMENTS.md still shows SCHED-01–06 as `[ ]` (pending) in the checklist and "Pending" in the tracking table. The code satisfies all 6 requirements. The markdown file needs a manual update to mark them complete — this is a docs-only gap, not a code gap.

---

### Anti-Patterns Found

| File | Pattern | Severity | Impact |
|------|---------|----------|--------|
| `schedule/postgres.ts` line 100 | `const effectiveTenantId = tenantId \|\| 'org-default'` | Info | Defensive fallback in `getSchedule` when tenantId is undefined. Not a stub — callers that matter (API routes) always pass tenantId from session. Pre-flight checks rely on this returning null for cross-tenant IDs, which works correctly when tenantId is provided. |

No blockers. No stubs.

---

### Human Verification Required

#### 1. Cross-tenant 403 end-to-end

**Test:** Log in as User A (Tenant A). Obtain the accountId or scheduleId of a record belonging to Tenant B. Issue a PUT or DELETE to `/api/accounts/{id}` or `/api/schedules/{id}` via the UI or curl with User A's session cookie.
**Expected:** HTTP 403 with `{ "success": false, "error": "Forbidden" }`
**Why human:** `getSessionTenantId()` resolution requires a live NextAuth session. Can't verify the session correctly returns Tenant A's ID without running the app.

---

### Gaps Summary

No gaps. All 5 success criteria are satisfied by the code. The only item requiring attention is updating REQUIREMENTS.md to mark SCHED-01–06 as `[x]` complete.

---

_Verified: 2026-04-03T18:35:00Z_
_Verifier: Claude (gsd-verifier)_
