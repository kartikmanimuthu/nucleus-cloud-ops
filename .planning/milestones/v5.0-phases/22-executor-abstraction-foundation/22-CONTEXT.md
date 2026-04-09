# Phase 22: Executor Abstraction Foundation - Context

**Gathered:** 2026-04-09
**Status:** Ready for planning

<domain>
## Phase Boundary

The worker process gets a pluggable execution strategy selected at startup via WORKER_ARCH env variable. VerticalExecutor preserves current in-process behavior exactly. HorizontalExecutor is a stub that doesn't crash but doesn't dispatch yet (Phase 24 wires it to ECS RunTask).

This phase does NOT change any job behavior — it introduces the abstraction layer only. All 4 existing jobs (scheduler, discovery, kb-sync, agent-ops-scheduler) continue running in-process identically.

</domain>

<decisions>
## Implementation Decisions

### Interface Contract
- **D-01:** JobExecutor interface has a single method: `execute(jobName: string, jobData: unknown): Promise<void>`
- **D-02:** Job-specific context (tenantId, kbId, etc.) lives inside jobData — the executor interface stays generic
- **D-03:** The executor does not manage pg-boss queue creation or scheduling — that stays in each job's `register()` function

### Strategy Wiring
- **D-04:** WORKER_ARCH env variable is read once at startup in `workers/src/index.ts`
- **D-05:** A factory function (`createExecutor(arch: string)`) returns the appropriate executor instance
- **D-06:** The executor instance is passed to each `register(boss, executor)` function — register functions gain a second parameter
- **D-07:** Default value for WORKER_ARCH is `"vertical"` — omitting the env var preserves current behavior

### Handler Extraction
- **D-08:** Each job's handler logic is extracted into a named async function (e.g., `handleSchedulerScan(jobData)`) that the executor can invoke
- **D-09:** `register()` functions still own queue creation, cron scheduling, and pg-boss `boss.work()` wiring
- **D-10:** Inside `boss.work()` callbacks, the handler calls `executor.execute(jobName, jobData)` instead of directly calling service functions
- **D-11:** VerticalExecutor.execute() looks up the handler by jobName from a registry and calls it in-process

### Error Propagation
- **D-12:** Executor.execute() throws on failure — pg-boss retry mechanism (retryLimit: 3, retryDelay: 30, retryBackoff: true) handles retries
- **D-13:** No additional error wrapping or retry logic inside the executor — keep it transparent

### Claude's Discretion
- File organization within `workers/src/` (e.g., whether executor lives in `workers/src/lib/` or `workers/src/executor/`)
- Handler registry implementation (Map, switch statement, or convention-based)
- Whether to use a class or plain functions for the executor implementations

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Worker Architecture
- `workers/src/index.ts` — Current worker entrypoint; where WORKER_ARCH reading and executor creation will go
- `workers/src/boss.ts` — pg-boss instance creation with retry/expiry config
- `workers/src/lib/logger.ts` — Structured logger pattern all workers use

### Existing Job Registrations
- `workers/src/jobs/scheduler/index.ts` — Per-tenant cron scheduling with `boss.schedule()` + `boss.work()`
- `workers/src/jobs/discovery/index.ts` — Fan-out + per-tenant scan with stately queue policy
- `workers/src/jobs/kb-sync/index.ts` — 4 sync types (file-upload, s3-sync, confluence-sync, bitbucket-sync)
- `workers/src/jobs/agent-ops-scheduler/index.ts` — Agent ops task tick via HTTP trigger to web-ui API

### Requirements
- `.planning/REQUIREMENTS.md` — EXEC-01, EXEC-02, EXEC-03 are Phase 22 requirements

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `createBoss()` in `workers/src/boss.ts` — pg-boss factory with retry config; unchanged by this phase
- `createLogger('name')` in `workers/src/lib/logger.ts` — structured logging; executor should use this

### Established Patterns
- Each job has a `register(boss: PgBoss)` function that creates queues and registers handlers
- Handlers are defined inline within `boss.work()` callbacks
- Per-tenant queues use `queueName:tenantId` naming convention (scheduler, discovery, agent-ops)
- kb-sync uses a single shared queue with job type routing via switch statement

### Integration Points
- `workers/src/index.ts` main() — calls register functions sequentially; executor instance injected here
- Each `register()` function signature changes from `(boss)` to `(boss, executor)`
- `boss.work()` callbacks become thin wrappers that delegate to `executor.execute()`

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches. The key constraint is zero regression: all 4 jobs must behave identically in vertical mode.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 22-executor-abstraction-foundation*
*Context gathered: 2026-04-09*
