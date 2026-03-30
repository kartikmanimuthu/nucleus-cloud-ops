---
phase: quick
plan: 260330-qkm
type: execute
wave: 1
depends_on: []
files_modified:
  - web-ui/lib/schedule-service.test.ts
  - web-ui/lib/schedule-execution-service.test.ts
  - web-ui/app/api/schedules/schedules-api.test.ts
autonomous: true
requirements: [schedule-unit-tests, schedule-api-tests]

must_haves:
  truths:
    - "ScheduleService all 7 methods have unit test coverage"
    - "ScheduleExecutionService all 4 methods have unit test coverage"
    - "All 8 API route handlers (GET/POST list, GET/PUT/DELETE single, toggle, history, execute) have unit test coverage"
    - "All new tests pass via vitest run"
  artifacts:
    - path: "web-ui/lib/schedule-service.test.ts"
      provides: "ScheduleService unit tests"
      min_lines: 150
    - path: "web-ui/lib/schedule-execution-service.test.ts"
      provides: "ScheduleExecutionService unit tests"
      min_lines: 80
    - path: "web-ui/app/api/schedules/schedules-api.test.ts"
      provides: "API route unit tests for all schedule endpoints"
      min_lines: 200
  key_links:
    - from: "schedule-service.test.ts"
      to: "@/lib/db/repository-factory"
      via: "vi.mock of getScheduleRepository"
      pattern: "vi\\.mock.*repository-factory"
    - from: "schedules-api.test.ts"
      to: "@/lib/schedule-service"
      via: "vi.mock of ScheduleService static methods"
      pattern: "vi\\.mock.*schedule-service"
---

<objective>
Write full unit test coverage for the schedule module: ScheduleService (7 methods), ScheduleExecutionService (4 methods), and all 8 API route handlers across 6 route files.

Purpose: Match the account module test coverage pattern established in quick task 260330-nds. No unit tests currently exist for schedules.
Output: 3 test files with ~50+ tests covering all service methods and API routes.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@web-ui/lib/schedule-service.ts
@web-ui/lib/schedule-execution-service.ts
@web-ui/lib/client-schedule-service.ts
@web-ui/app/api/schedules/route.ts
@web-ui/app/api/schedules/[scheduleId]/route.ts
@web-ui/app/api/schedules/[scheduleId]/toggle/route.ts
@web-ui/app/api/schedules/[scheduleId]/history/route.ts
@web-ui/app/api/schedules/[scheduleId]/history/[executionId]/route.ts
@web-ui/app/api/schedules/[scheduleId]/execute/route.ts
@web-ui/vitest.config.ts

<interfaces>
<!-- Mocking targets — these are the modules to vi.mock() -->

From @/lib/db/repository-factory:
```typescript
export function getScheduleRepository(): IScheduleRepository;
export function getScheduleExecutionRepository(): IScheduleExecutionRepository;
```

From IScheduleRepository:
```typescript
getSchedules(filters: ScheduleFilters): Promise<{ schedules: UISchedule[], total: number }>
getSchedule(idOrName: string, accountId?: string, tenantId?: string): Promise<UISchedule | null>
createSchedule(schedule: Omit<UISchedule, 'id'>, tenantId: string): Promise<UISchedule>
updateSchedule(scheduleId: string, updates: Partial<UISchedule>, tenantId: string, accountId?: string): Promise<UISchedule>
deleteSchedule(scheduleId: string, tenantId: string, accountId?: string): Promise<void>
```

From IScheduleExecutionRepository:
```typescript
logExecution(execution): Promise<ScheduleExecution>
getExecutionHistory(scheduleId: string, tenantId: string, limit?: number): Promise<UIScheduleExecution[]>
getRecentExecutions(tenantId: string, limit?: number): Promise<UIScheduleExecution[]>
```

From @/lib/audit-service:
```typescript
class AuditService {
  static logUserAction(params): Promise<void>
  static logResourceAction(params): Promise<void>
}
```

From @/lib/rbac/authorize:
```typescript
function authorize(action: string, subject: string): Promise<NextResponse | null>
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: ScheduleService + ScheduleExecutionService unit tests</name>
  <files>web-ui/lib/schedule-service.test.ts, web-ui/lib/schedule-execution-service.test.ts</files>
  <action>
Create unit tests following the vi.hoisted() + vi.mock() pattern from the account module tests.

**schedule-service.test.ts** — Mock `getScheduleRepository` from `@/lib/db/repository-factory`, `AuditService` from `@/lib/audit-service`, and `DEFAULT_TENANT_ID` from `@/lib/aws-config`. Test all 7 static methods:

1. `getSchedules` (4 tests):
   - delegates filters to repo.getSchedules with DEFAULT_TENANT_ID
   - passes custom tenantId when provided
   - returns `{ schedules: [], total: 0 }` on error (swallows exception)
   - passes pagination (page, limit) through to repo

2. `getSchedulesWithFilters` (3 tests):
   - maps `active=true` to `statusFilter: 'active'`
   - maps `active=false` to `statusFilter: 'inactive'`
   - maps `active=undefined` to `statusFilter: undefined`

3. `getSchedule` (3 tests):
   - returns schedule when found
   - returns null when not found
   - returns null on error (swallows exception)

4. `createSchedule` (4 tests):
   - calls repo.createSchedule and returns result (USE_PG_SCHEDULES=false path)
   - calls AuditService.logUserAction on success with correct metadata
   - calls AuditService.logUserAction with status 'error' on failure
   - re-throws error on failure

5. `updateSchedule` (3 tests):
   - calls repo.updateSchedule and returns result
   - calls AuditService.logUserAction on success
   - re-throws error on failure

6. `deleteSchedule` (3 tests):
   - fetches schedule first, then calls repo.deleteSchedule
   - calls AuditService.logUserAction on success
   - returns silently when schedule not found (nothing to delete)

7. `toggleScheduleStatus` (3 tests):
   - throws 'Schedule not found' when getSchedule returns null
   - flips active true→false via updateSchedule
   - flips active false→true via updateSchedule

**schedule-execution-service.test.ts** — Mock `getScheduleExecutionRepository` and `DEFAULT_TENANT_ID`. Test all 4 static methods:

1. `logExecution` (2 tests):
   - delegates to repo.logExecution
   - re-throws on error

2. `getExecutionsForSchedule` (2 tests):
   - delegates to repo.getExecutionHistory with limit
   - returns [] on error

3. `getExecutionById` (3 tests):
   - returns matching execution from history
   - returns null when executionId not found
   - returns null on error

4. `getRecentExecutions` (3 tests):
   - delegates to repo.getRecentExecutions
   - filters by status in-memory when options.status provided
   - returns [] on error
  </action>
  <verify>
    <automated>cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/database-migration/web-ui && npx vitest run lib/schedule-service.test.ts lib/schedule-execution-service.test.ts --reporter=verbose 2>&1 | tail -40</automated>
  </verify>
  <done>All ~28 ScheduleService tests and ~10 ScheduleExecutionService tests pass</done>
</task>

<task type="auto">
  <name>Task 2: Schedule API route unit tests</name>
  <files>web-ui/app/api/schedules/schedules-api.test.ts</files>
  <action>
Create a single test file covering all 8 route handlers across 6 route files. Mock `ScheduleService`, `ScheduleExecutionService`, `AuditService`, `authorize`, `getServerSession`, and `LambdaClient`. Use `vi.hoisted()` for mock functions.

For Next.js route handler testing: create a `NextRequest` with `new NextRequest(new URL('http://localhost/api/schedules'))` and call the exported handler directly. Mock `authorize` to return `null` (authorized) by default.

**GET /api/schedules** (4 tests):
- returns 200 with `{ success, data, count, meta }` shape
- returns 403 when authorize returns a response
- parses query params (status, resource, search, page, limit) into filters
- returns 500 on service error

**POST /api/schedules** (6 tests):
- returns 201 with created schedule on success
- returns 403 when authorize returns a response
- returns 400 when required fields missing (name, starttime, endtime, timezone, days)
- returns 400 when accountId missing
- returns 400 when days is empty array
- returns 400 when timezone is invalid
- returns 409 when schedule name already exists
- returns 500 on unexpected error

**GET /api/schedules/[scheduleId]** (3 tests):
- returns 200 with schedule object directly
- returns 404 when schedule not found
- returns 500 on error

**PUT /api/schedules/[scheduleId]** (2 tests):
- returns 200 with updated schedule, passes updatedBy from session
- returns 500 on error

**DELETE /api/schedules/[scheduleId]** (2 tests):
- returns 200 with `{ success: true }`
- returns 500 on error

**POST /api/schedules/[scheduleId]/toggle** (3 tests):
- returns 200 with `{ success, data, message }` on success
- returns 404 when schedule not found
- returns 500 on unexpected error

**GET /api/schedules/[scheduleId]/history** (3 tests):
- returns 200 with `{ success, scheduleId, scheduleName, executions, total }`
- returns 404 when schedule not found
- returns 500 on error

**POST /api/schedules/[scheduleId]/execute** (4 tests):
- returns 403 when authorize returns a response
- returns 404 when schedule not found
- returns 200 on successful Lambda invocation
- returns 200 with failed status when Lambda invocation throws

**GET /api/schedules/[scheduleId]/history/[executionId]** (3 tests):
- returns 200 with `{ success, execution, schedule }` when found
- returns 404 when schedule not found
- returns 404 when execution not found

For the `params` argument in dynamic routes, pass `{ params: Promise.resolve({ scheduleId: 'sched-1' }) }` to match Next.js 15 async params pattern.
  </action>
  <verify>
    <automated>cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/database-migration/web-ui && npx vitest run app/api/schedules/schedules-api.test.ts --reporter=verbose 2>&1 | tail -50</automated>
  </verify>
  <done>All ~30 API route tests pass covering GET/POST list, GET/PUT/DELETE single, toggle, history, history/executionId, and execute endpoints</done>
</task>

</tasks>

<verification>
Run all new schedule test files together:
```bash
cd web-ui && npx vitest run lib/schedule-service.test.ts lib/schedule-execution-service.test.ts app/api/schedules/schedules-api.test.ts --reporter=verbose
```
All tests pass. No pre-existing tests broken.
</verification>

<success_criteria>
- ~60+ new unit tests across 3 test files
- ScheduleService: all 7 methods covered (getSchedules, getSchedulesWithFilters, getSchedule, createSchedule, updateSchedule, deleteSchedule, toggleScheduleStatus)
- ScheduleExecutionService: all 4 methods covered (logExecution, getExecutionsForSchedule, getExecutionById, getRecentExecutions)
- API routes: all 8 handlers covered (GET/POST /schedules, GET/PUT/DELETE /schedules/:id, POST toggle, GET history, POST execute, GET history/:executionId)
- All tests pass via `npx vitest run`
</success_criteria>

<output>
After completion, create `.planning/quick/260330-qkm-schedule-module-full-test-coverage-unit-/260330-qkm-SUMMARY.md`
</output>
