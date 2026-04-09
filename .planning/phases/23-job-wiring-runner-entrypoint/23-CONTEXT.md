# Phase 23: Job Wiring + Runner Entrypoint - Context

**Gathered:** 2026-04-09
**Status:** Ready for planning

<domain>
## Phase Boundary

All 3 pg-boss jobs (scheduler, discovery, kb-sync) plus agent-ops-scheduler delegate execution through the JobExecutor abstraction. A standalone `job-runner.ts` entrypoint can execute any job by name and exit cleanly. Phase 22 already wired scheduler and kb-sync — this phase completes discovery and agent-ops-scheduler, and adds the runner entrypoint.

</domain>

<decisions>
## Implementation Decisions

### Discovery Wiring
- **D-01:** Discovery's dual-queue pattern (fan-out + scan) gets two separate handlers: `handleFanOut(jobData)` and `handleDiscoveryScan(jobData)` — both registered with executor via `registerHandler`
- **D-02:** Fan-out handler stays as direct `boss.send()` calls — it's an orchestrator that enqueues scan jobs, not a standalone job handler. In horizontal mode, fan-out always runs in-process (vertical) since it needs the boss instance to enqueue scan jobs
- **D-03:** Only `discovery-scan` handler is meaningful for horizontal dispatch — it does the actual AWS scanning work
- **D-04:** Discovery `register()` signature changes from `(boss)` to `(boss, executor)` matching the Phase 22 pattern
- **D-05:** Discovery must be imported and registered in `workers/src/index.ts` (currently missing from entrypoint)

### Agent-Ops-Scheduler Wiring
- **D-06:** Agent-ops-scheduler `register()` gains executor parameter: `register(boss, executor)`
- **D-07:** `handleTick` extracted as a standalone handler function registered with executor — but it currently takes `boss` as a parameter for the HTTP trigger pattern. Since it only does an HTTP POST (no boss interaction), extract to `handleAgentOpsTick(jobData)` that receives taskId/tenantId from jobData
- **D-08:** Agent-ops-scheduler must be imported and registered in `workers/src/index.ts` (currently missing from entrypoint)

### Job Runner Entrypoint
- **D-09:** `workers/src/job-runner.ts` — standalone entrypoint that receives `--job <name> --data '<json>'` via CLI args
- **D-10:** Job runner does NOT need pg-boss — it imports handler functions directly, calls the handler, and exits with code 0 on success, non-zero on failure
- **D-11:** Job runner registers all handlers into a VerticalExecutor (or a simple Map), looks up by job name, calls execute, then exits
- **D-12:** Job runner must handle process cleanup (Prisma disconnect, etc.) before exit

### Fan-Out in Horizontal Mode
- **D-13:** Fan-out jobs always run in-process regardless of WORKER_ARCH — they need the boss instance to enqueue child jobs via `boss.send()`
- **D-14:** The `boss.work()` callback for fan-out calls the handler directly (not through executor) since fan-out is orchestration, not execution

### Claude's Discretion
- CLI arg parsing approach (minimist, yargs, or manual process.argv parsing)
- Whether job-runner.ts compiles to a separate dist entry or shares the existing build
- Exact error message formatting for unknown job names in job-runner

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Executor Abstraction (Phase 22 output)
- `workers/src/executor/types.ts` — JobExecutor interface and HandlerFn type
- `workers/src/executor/vertical.ts` — VerticalExecutor with handler registry
- `workers/src/executor/factory.ts` — createExecutor factory function
- `workers/src/executor/index.ts` — Barrel exports

### Worker Entrypoint
- `workers/src/index.ts` — Current entrypoint; only registers scheduler + kb-sync; discovery and agent-ops-scheduler missing

### Jobs to Wire
- `workers/src/jobs/discovery/index.ts` — NOT wired to executor; dual-queue (fan-out + scan) with heavy inline logic
- `workers/src/jobs/agent-ops-scheduler/index.ts` — NOT wired to executor; HTTP trigger pattern via handleTick
- `workers/src/jobs/scheduler/index.ts` — Already wired (Phase 22 reference pattern)
- `workers/src/jobs/kb-sync/index.ts` — Already wired (Phase 22 reference pattern)

### Requirements
- `.planning/REQUIREMENTS.md` — WIRE-01 through WIRE-04 are Phase 23 requirements

### Phase 22 Context
- `.planning/phases/22-executor-abstraction-foundation/22-CONTEXT.md` — Decisions D-06 through D-13 define the wiring pattern

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `VerticalExecutor` with `registerHandler()` + `execute()` — proven pattern from scheduler and kb-sync
- `createLogger('name')` — structured logging for new job-runner entrypoint
- `createBoss()` in `workers/src/boss.ts` — only needed by main entrypoint, NOT by job-runner

### Established Patterns
- Scheduler wiring pattern: extract handler → registerHandler → boss.work delegates to executor.execute (see `workers/src/jobs/scheduler/index.ts`)
- KB-sync wiring pattern: same as scheduler but with error handling in boss.work callback that updates data source status before re-throwing (see `workers/src/jobs/kb-sync/index.ts`)
- Per-tenant queue naming: `queueName:tenantId` (scheduler, discovery, agent-ops)

### Integration Points
- `workers/src/index.ts` — needs `import { register as registerDiscoveryJobs }` and `import { register as registerAgentOpsJobs }`
- `workers/package.json` — may need new build entry for job-runner.ts
- Discovery's `loadScanConfigs()` and service imports — must remain accessible to extracted handler
- Agent-ops-scheduler's `loadActiveTasks()` — stays in register(), not in handler

</code_context>

<specifics>
## Specific Ideas

No specific requirements — follow the Phase 22 wiring pattern exactly. The key complexity is discovery's dual-queue pattern where fan-out is orchestration (needs boss) and scan is execution (goes through executor).

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 23-job-wiring-runner-entrypoint*
*Context gathered: 2026-04-09*
