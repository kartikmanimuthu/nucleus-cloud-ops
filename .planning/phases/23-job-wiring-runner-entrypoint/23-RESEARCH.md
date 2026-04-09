# Phase 23: Job Wiring + Runner Entrypoint - Research

**Researched:** 2026-04-09
**Domain:** pg-boss job wiring, executor abstraction, standalone CLI entrypoint
**Confidence:** HIGH

## Summary

Phase 22 established the executor abstraction and wired scheduler + kb-sync. Phase 23 completes the wiring for the two remaining jobs (discovery, agent-ops-scheduler) and adds a standalone `job-runner.ts` entrypoint. All patterns are already proven in the codebase — this phase is mechanical application of the established pattern with one non-trivial refactor (discovery's dual-queue and agent-ops-scheduler's boss-coupled handleTick).

The discovery job requires special handling: fan-out is orchestration (needs `boss` to enqueue child jobs) and must NOT go through the executor. Only `discovery-scan` is a real execution handler and gets registered with the executor. Agent-ops-scheduler's `handleTick` currently takes `(boss, job)` — it must be refactored to `handleAgentOpsTick(jobData)` since it only does an HTTP POST and doesn't actually need `boss`.

The job-runner entrypoint is a simple CLI script: parse `--job` and `--data` args, create a `VerticalExecutor`, register all handlers, call `execute`, then `process.exit`. No pg-boss needed.

**Primary recommendation:** Follow the scheduler wiring pattern exactly. The only complexity is discovery's fan-out bypass and agent-ops-scheduler's handler signature refactor.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Discovery Wiring**
- D-01: Discovery's dual-queue pattern (fan-out + scan) gets two separate handlers: `handleFanOut(jobData)` and `handleDiscoveryScan(jobData)` — both registered with executor via `registerHandler`
- D-02: Fan-out handler stays as direct `boss.send()` calls — it's an orchestrator that enqueues scan jobs, not a standalone job handler. In horizontal mode, fan-out always runs in-process (vertical) since it needs the boss instance to enqueue scan jobs
- D-03: Only `discovery-scan` handler is meaningful for horizontal dispatch — it does the actual AWS scanning work
- D-04: Discovery `register()` signature changes from `(boss)` to `(boss, executor)` matching the Phase 22 pattern
- D-05: Discovery must be imported and registered in `workers/src/index.ts` (currently missing from entrypoint)

**Agent-Ops-Scheduler Wiring**
- D-06: Agent-ops-scheduler `register()` gains executor parameter: `register(boss, executor)`
- D-07: `handleTick` extracted as a standalone handler function registered with executor — but it currently takes `boss` as a parameter for the HTTP trigger pattern. Since it only does an HTTP POST (no boss interaction), extract to `handleAgentOpsTick(jobData)` that receives taskId/tenantId from jobData
- D-08: Agent-ops-scheduler must be imported and registered in `workers/src/index.ts` (currently missing from entrypoint)

**Job Runner Entrypoint**
- D-09: `workers/src/job-runner.ts` — standalone entrypoint that receives `--job <name> --data '<json>'` via CLI args
- D-10: Job runner does NOT need pg-boss — it imports handler functions directly, calls the handler, and exits with code 0 on success, non-zero on failure
- D-11: Job runner registers all handlers into a VerticalExecutor (or a simple Map), looks up by job name, calls execute, then exits
- D-12: Job runner must handle process cleanup (Prisma disconnect, etc.) before exit

**Fan-Out in Horizontal Mode**
- D-13: Fan-out jobs always run in-process regardless of WORKER_ARCH — they need the boss instance to enqueue child jobs via `boss.send()`
- D-14: The `boss.work()` callback for fan-out calls the handler directly (not through executor) since fan-out is orchestration, not execution

### Claude's Discretion
- CLI arg parsing approach (minimist, yargs, or manual process.argv parsing)
- Whether job-runner.ts compiles to a separate dist entry or shares the existing build
- Exact error message formatting for unknown job names in job-runner

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| WIRE-01 | Scheduler job (per-tenant cron scan) delegates execution through the executor abstraction | Already done in Phase 22 — verify no regression |
| WIRE-02 | Discovery job (fan-out + per-tenant scan) delegates execution through the executor abstraction | Fan-out bypasses executor (D-14); only discovery-scan goes through executor (D-03) |
| WIRE-03 | KB sync job (file-upload, s3-sync, confluence-sync, bitbucket-sync) delegates execution through the executor abstraction | Already done in Phase 22 — verify no regression |
| WIRE-04 | Job runner entrypoint receives job name + data args, runs the handler directly, and exits the container | job-runner.ts with VerticalExecutor, no pg-boss, process.exit(0/1) |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| pg-boss | ^10.1.5 | Job queue (workers entrypoint only) | Already in use; job-runner does NOT use it |
| @prisma/client | ^6.0.0 | DB access in handlers | Already in use; job-runner must disconnect before exit |
| TypeScript | ^5.7.2 | Language | Project standard |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| process.argv (built-in) | Node 20 | CLI arg parsing for job-runner | Sufficient for `--job` + `--data`; no extra dep needed |
| createLogger | internal | Structured logging | All new code uses `createLogger('service-name')` |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Manual process.argv parsing | minimist / yargs | minimist adds a dep for 2 args; manual is 10 lines and zero deps — prefer manual |

**Installation:** No new packages needed.

## Architecture Patterns

### Established Wiring Pattern (from scheduler/index.ts — Phase 22)

```typescript
// 1. Extract handler as standalone function
async function handleSchedulerJob(jobData: unknown): Promise<void> { ... }

// 2. register() accepts (boss, executor)
export async function register(boss: PgBoss, executor: JobExecutor): Promise<void> {
  // 3. Register with executor first
  executor.registerHandler?.(JOB_NAME, handleSchedulerJob);

  // 4. Create queue + schedule
  await boss.createQueue(JOB_NAME);
  await boss.schedule(JOB_NAME, '*/30 * * * *', {}, { tz: 'UTC' });

  // 5. boss.work delegates to executor.execute
  await boss.work<SchedulerEvent>(JOB_NAME, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await executor.execute(JOB_NAME, job.data);
    }
  });
}
```

### Discovery Dual-Queue Pattern

Fan-out is orchestration — it calls `boss.send()` to enqueue child jobs. It cannot be dispatched to a remote ECS task because it needs the boss instance. The `boss.work()` callback calls the fan-out logic directly (not through executor). Only `discovery-scan` goes through the executor.

```typescript
const FAN_OUT_JOB = 'discovery-fan-out';
const SCAN_JOB = 'discovery-scan';

async function handleDiscoveryScan(jobData: unknown): Promise<void> {
  // All the existing scan logic, extracted from the inline boss.work callback
  const { tenantId, accountId, triggeredBy, correlationId } = jobData as DiscoveryScanJob;
  // ... existing scan body unchanged
}

export async function register(boss: PgBoss, executor: JobExecutor): Promise<void> {
  executor.registerHandler?.(SCAN_JOB, handleDiscoveryScan);
  // NOTE: fan-out is NOT registered with executor (D-14)

  // ... queue setup unchanged ...

  // Fan-out: calls boss.send() directly — NOT through executor
  await boss.work<DiscoveryFanOutJob>(FAN_OUT_JOB, { batchSize: 1 }, async ([job]) => {
    // fan-out logic inline (needs boss reference)
    const tenants = await getAllTenants();
    for (const tenant of tenants) {
      await boss.send(SCAN_JOB, { ... }, { singletonKey: `tenant:${tenant.id}`, ... });
    }
  });

  // Scan: delegates to executor
  await boss.work<DiscoveryScanJob>(SCAN_JOB, { batchSize: 1 }, async ([job]) => {
    await executor.execute(SCAN_JOB, job.data);
  });
}
```

### Agent-Ops-Scheduler Refactor

Current `handleTick(boss, job)` takes `boss` but never uses it — it only does an HTTP POST. Refactor to `handleAgentOpsTick(jobData)`:

```typescript
async function handleAgentOpsTick(jobData: unknown): Promise<void> {
  const { taskId, tenantId } = jobData as TaskTickData;
  // ... existing HTTP POST logic, unchanged except signature
}

export async function register(boss: PgBoss, executor: JobExecutor): Promise<void> {
  executor.registerHandler?.(`${QUEUE_PREFIX}:*`, handleAgentOpsTick);
  // NOTE: per-task queues use dynamic names — register handler per task
  const tasks = await loadActiveTasks();
  for (const task of tasks) {
    const queue = queueName(task.taskId);
    executor.registerHandler?.(queue, handleAgentOpsTick);
    await boss.createQueue(queue);
    await boss.schedule(queue, task.cronExpression, { taskId: task.taskId, tenantId: task.tenantId } satisfies TaskTickData, { tz: task.timezone });
    await boss.work(queue, { batchSize: 1 }, async (jobs: PgBoss.Job<TaskTickData>[]) => {
      for (const job of jobs) {
        await executor.execute(queue, job.data);
      }
    });
  }
}
```

### Job Runner Entrypoint Pattern

```typescript
// workers/src/job-runner.ts
import { VerticalExecutor } from './executor/vertical.js';
import { createLogger } from './lib/logger.js';
// Import all handler registration functions
import { register as registerScheduler } from './jobs/scheduler/index.js';
import { register as registerDiscovery } from './jobs/discovery/index.js';
import { register as registerKbSync } from './jobs/kb-sync/index.js';
import { register as registerAgentOps } from './jobs/agent-ops-scheduler/index.js';

const log = createLogger('job-runner');

// Parse --job <name> --data '<json>' from process.argv
function parseArgs(): { job: string; data: unknown } {
  const args = process.argv.slice(2);
  const jobIdx = args.indexOf('--job');
  const dataIdx = args.indexOf('--data');
  if (jobIdx === -1) throw new Error('Missing --job argument');
  const job = args[jobIdx + 1];
  const data = dataIdx !== -1 ? JSON.parse(args[dataIdx + 1]) : {};
  return { job, data };
}

async function main() {
  const { job, data } = parseArgs();
  log.info('job-runner starting', { job });

  const executor = new VerticalExecutor();

  // Register all handlers — pass a null boss since job-runner doesn't use pg-boss
  // Only registerHandler calls matter; boss.work/schedule calls are skipped
  // NOTE: This requires register() functions to be safe to call with a stub boss
  // Alternative: export handler registration separately from boss.work setup

  await executor.execute(job, data);
  log.info('job-runner complete', { job });
  process.exit(0);
}

main().catch((err) => {
  log.error('job-runner failed', { error: String(err) });
  process.exit(1);
});
```

### Anti-Patterns to Avoid

- **Registering fan-out with executor:** Fan-out needs `boss` to enqueue child jobs — it cannot run as a standalone handler in job-runner. Only `discovery-scan` is registered.
- **Calling boss.work/schedule in job-runner:** job-runner only needs handler registration, not queue setup. The register() functions do both — see the "handler export" pattern below.
- **Forgetting Prisma disconnect:** Handlers that use Prisma (discovery, agent-ops-scheduler) create PrismaClient instances. job-runner must ensure these are disconnected before exit, or use `process.exit` which forces cleanup.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Handler registry | Custom Map wrapper | VerticalExecutor.registerHandler | Already exists, tested |
| CLI arg parsing | Argument parser library | Manual process.argv.slice(2) | 2 args, zero deps needed |
| Process cleanup | Custom shutdown hook | process.exit(0/1) after await | Prisma connections close on process exit |

## Common Pitfalls

### Pitfall 1: register() calls boss.work — job-runner can't pass a real boss
**What goes wrong:** job-runner imports `register()` from each job module, but `register()` calls `boss.createQueue`, `boss.schedule`, `boss.work` — all of which fail without a real pg-boss instance.
**Why it happens:** The register() pattern bundles handler registration + queue setup in one function.
**How to avoid:** Two options:
1. Export handler functions directly from each job module and call `executor.registerHandler` in job-runner without calling `register()` at all.
2. Create a thin `registerHandlers(executor)` export in each job module that only calls `executor.registerHandler?.(...)` — no boss interaction.
Option 1 is simpler and avoids touching register() signatures. The CONTEXT.md D-11 says "registers all handlers into a VerticalExecutor" — import handler functions directly.
**Warning signs:** TypeScript errors about missing boss argument, or runtime errors about `boss.createQueue is not a function`.

### Pitfall 2: Agent-ops-scheduler uses dynamic per-task queue names
**What goes wrong:** Each task gets its own queue `agent-ops-task:<taskId>`. The executor registry uses exact job name lookup. If job-runner passes `--job agent-ops-task:abc123`, the handler must be registered under that exact key.
**Why it happens:** Per-tenant/per-task queue naming means the job name is dynamic.
**How to avoid:** In job-runner, register `handleAgentOpsTick` under the exact job name passed via `--job`. Since job-runner receives the full queue name as `--job`, it can register the handler under that name before calling execute.
**Warning signs:** `No handler registered for job: agent-ops-task:abc123` error at runtime.

### Pitfall 3: ESM .js extensions required
**What goes wrong:** TypeScript source uses `.ts` but compiled output is `.js`. All imports in `workers/` must use `.js` extensions (e.g., `import { X } from './executor/vertical.js'`).
**Why it happens:** `"type": "module"` in package.json + `"module": "ESNext"` in tsconfig.
**How to avoid:** Always use `.js` extension in import paths, even when importing `.ts` source files.
**Warning signs:** `ERR_MODULE_NOT_FOUND` at runtime.

### Pitfall 4: Discovery scan error handling — throw propagates to pg-boss
**What goes wrong:** The existing scan handler throws when all accounts fail (`throw new Error('All accounts failed: ...')`). This is intentional — pg-boss retries on throw. When extracting to `handleDiscoveryScan`, preserve this throw behavior.
**Why it happens:** VerticalExecutor propagates errors without wrapping (Phase 22 decision).
**How to avoid:** Keep the `if (errors.length > 0 && accountsSynced === 0) throw new Error(...)` at the end of the extracted handler.

## Code Examples

### Verified: How scheduler wiring looks (Phase 22 reference)
```typescript
// Source: workers/src/jobs/scheduler/index.ts
export async function register(boss: PgBoss, executor: JobExecutor): Promise<void> {
  executor.registerHandler?.(JOB_NAME, handleSchedulerJob);
  await boss.createQueue(JOB_NAME);
  await boss.schedule(JOB_NAME, '*/30 * * * *', {}, { tz: 'UTC' });
  await boss.work<SchedulerEvent>(JOB_NAME, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await executor.execute(JOB_NAME, job.data);
    }
  });
}
```

### Verified: VerticalExecutor handler lookup
```typescript
// Source: workers/src/executor/vertical.ts
async execute(jobName: string, jobData: unknown): Promise<void> {
  const handler = this.registry.get(jobName);
  if (!handler) {
    throw new Error(`No handler registered for job: ${jobName}`);
  }
  await handler(jobData);
}
```

### Verified: workers/src/index.ts — current state (missing discovery + agent-ops)
```typescript
// Source: workers/src/index.ts
await registerSchedulerJobs(boss, executor);
await registerKbSyncJobs(boss, executor);
// MISSING: registerDiscoveryJobs(boss, executor)
// MISSING: registerAgentOpsJobs(boss, executor)
```

### Recommended: job-runner.ts handler registration without calling register()
```typescript
// Import handler functions directly — avoids needing a real boss instance
import { handleDiscoveryScan } from './jobs/discovery/index.js';
import { handleSchedulerJob } from './jobs/scheduler/index.js';
import { handleKbSyncJob } from './jobs/kb-sync/index.js';
import { handleAgentOpsTick } from './jobs/agent-ops-scheduler/index.js';

const executor = new VerticalExecutor();
executor.registerHandler('scheduler-scan', handleSchedulerJob);
executor.registerHandler('kb-sync', handleKbSyncJob);
executor.registerHandler('discovery-scan', handleDiscoveryScan);
// For agent-ops: register under the exact job name from --job arg
executor.registerHandler(jobName, handleAgentOpsTick);

await executor.execute(jobName, data);
```

This requires the handler functions to be exported from each job module (currently `handleSchedulerJob` and `handleKbSyncJob` are not exported — they need to be).

## Build Considerations

The `workers/tsconfig.json` has `"rootDir": "./src"` and `"outDir": "./dist"`. Adding `workers/src/job-runner.ts` automatically compiles to `workers/dist/job-runner.js` — no tsconfig changes needed.

The `package.json` `scripts.start` runs `node --env-file=.env dist/index.js`. A separate start script for job-runner would be:
```json
"start:job-runner": "node --env-file=.env dist/job-runner.js"
```

For ECS container override (Phase 24), the command override would be:
```
["node", "dist/job-runner.js", "--job", "discovery-scan", "--data", "{...}"]
```

## Environment Availability

Step 2.6: SKIPPED (no external dependencies — this is a code-only wiring phase; all runtime dependencies already present in workers/)

## Open Questions

1. **Handler export visibility**
   - What we know: `handleSchedulerJob` and `handleKbSyncJob` are currently unexported (module-private)
   - What's unclear: Should job-runner call `register()` with a stub boss, or should handlers be exported?
   - Recommendation: Export handler functions from each job module. This is cleaner than a stub boss and aligns with D-10 ("imports handler functions directly"). Add `export` keyword to `handleSchedulerJob`, `handleKbSyncJob`, `handleDiscoveryScan`, `handleAgentOpsTick`.

2. **Agent-ops-scheduler dynamic queue names in job-runner**
   - What we know: Queue names are `agent-ops-task:<taskId>` — dynamic per task
   - What's unclear: job-runner receives the full queue name as `--job agent-ops-task:abc123`; it needs to register the handler under that exact name
   - Recommendation: In job-runner, detect if `--job` starts with `agent-ops-task:` and register `handleAgentOpsTick` under that name. This is a one-liner check.

## Sources

### Primary (HIGH confidence)
- `workers/src/jobs/scheduler/index.ts` — Phase 22 reference wiring pattern (verified by reading source)
- `workers/src/jobs/kb-sync/index.ts` — Phase 22 reference wiring pattern with error handling (verified by reading source)
- `workers/src/executor/vertical.ts` — VerticalExecutor implementation (verified by reading source)
- `workers/src/executor/types.ts` — JobExecutor interface (verified by reading source)
- `workers/src/index.ts` — Current entrypoint, missing discovery + agent-ops imports (verified by reading source)
- `workers/src/jobs/discovery/index.ts` — Current discovery implementation, unwired (verified by reading source)
- `workers/src/jobs/agent-ops-scheduler/index.ts` — Current agent-ops implementation, unwired (verified by reading source)
- `workers/tsconfig.json` — Build config confirming single outDir (verified by reading source)
- `workers/package.json` — ESM module type, no minimist/yargs present (verified by reading source)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all code read directly from source
- Architecture: HIGH — patterns verified from Phase 22 output files
- Pitfalls: HIGH — identified from direct code inspection (boss coupling, dynamic queue names, ESM extensions)

**Research date:** 2026-04-09
**Valid until:** 2026-05-09 (stable internal codebase)
