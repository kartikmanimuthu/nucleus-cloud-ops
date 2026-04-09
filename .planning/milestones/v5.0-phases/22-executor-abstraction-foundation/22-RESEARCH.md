# Phase 22: Executor Abstraction Foundation - Research

**Researched:** 2026-04-09
**Domain:** TypeScript strategy pattern, pg-boss worker architecture
**Confidence:** HIGH

## Summary

Phase 22 introduces a pluggable execution strategy layer on top of the existing pg-boss worker. The change is purely structural — no job behavior changes, no new dependencies, no infrastructure changes. All decisions are locked in CONTEXT.md; this research focuses on the exact code shape needed to implement them correctly given the current codebase.

The four existing job registrations (`scheduler`, `discovery`, `kb-sync`, `agent-ops-scheduler`) each have inline handler logic inside `boss.work()` callbacks. The work is: extract that logic into named handler functions, register them with a `VerticalExecutor` handler registry, and make `boss.work()` callbacks thin wrappers that call `executor.execute(jobName, jobData)`. The `HorizontalExecutor` is a no-op stub.

Two non-obvious structural constraints emerge from reading the actual job files: (1) `kb-sync` processes `batchSize: 3` so `executor.execute()` must be called per-job inside the existing loop, not once per batch; (2) `scheduler` and `agent-ops-scheduler` use dynamic per-tenant/per-task queue names, so the canonical handler name passed to `executor.execute()` must be a stable string (e.g. `'scheduler-scan'`), not the dynamic queue name.

**Primary recommendation:** Place executor code in `workers/src/executor/` (not `lib/`) — it is a distinct architectural concern, not a utility. Use a `Map<string, HandlerFn>` registry with a `registerHandler()` method on `VerticalExecutor`.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** JobExecutor interface has a single method: `execute(jobName: string, jobData: unknown): Promise<void>`
- **D-02:** Job-specific context (tenantId, kbId, etc.) lives inside jobData — the executor interface stays generic
- **D-03:** The executor does not manage pg-boss queue creation or scheduling — that stays in each job's `register()` function
- **D-04:** WORKER_ARCH env variable is read once at startup in `workers/src/index.ts`
- **D-05:** A factory function (`createExecutor(arch: string)`) returns the appropriate executor instance
- **D-06:** The executor instance is passed to each `register(boss, executor)` function — register functions gain a second parameter
- **D-07:** Default value for WORKER_ARCH is `"vertical"` — omitting the env var preserves current behavior
- **D-08:** Each job's handler logic is extracted into a named async function (e.g., `handleSchedulerScan(jobData)`) that the executor can invoke
- **D-09:** `register()` functions still own queue creation, cron scheduling, and pg-boss `boss.work()` wiring
- **D-10:** Inside `boss.work()` callbacks, the handler calls `executor.execute(jobName, jobData)` instead of directly calling service functions
- **D-11:** VerticalExecutor.execute() looks up the handler by jobName from a registry and calls it in-process
- **D-12:** Executor.execute() throws on failure — pg-boss retry mechanism (retryLimit: 3, retryDelay: 30, retryBackoff: true) handles retries
- **D-13:** No additional error wrapping or retry logic inside the executor — keep it transparent

### Claude's Discretion

- File organization within `workers/src/` (e.g., whether executor lives in `workers/src/lib/` or `workers/src/executor/`)
- Handler registry implementation (Map, switch statement, or convention-based)
- Whether to use a class or plain functions for the executor implementations

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| EXEC-01 | Worker process selects execution strategy via WORKER_ARCH env variable (vertical \| horizontal) | `workers/src/index.ts` main() reads env once; `createExecutor(arch)` factory returns strategy |
| EXEC-02 | Generic JobExecutor interface defines execute(jobName, jobData) contract that all strategies implement | TypeScript interface in `workers/src/executor/types.ts`; both VerticalExecutor and HorizontalExecutor implement it |
| EXEC-03 | VerticalExecutor runs job handler in-process within the pg-boss worker (current behavior, zero regression) | Handler registry Map; `boss.work()` callbacks become thin wrappers; all 4 jobs verified in-scope |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript | ^5.7.2 | Type-safe interface + class definitions | Already in workers/package.json |
| pg-boss | ^10.1.5 | Job queue — unchanged by this phase | Already in workers/package.json |
| vitest | ^2.1.8 | Unit tests for executor | Already in workers/package.json |

No new dependencies required. This phase is pure TypeScript restructuring.

## Architecture Patterns

### Recommended File Structure

```
workers/src/
├── executor/
│   ├── types.ts          # JobExecutor interface + HandlerFn type alias
│   ├── vertical.ts       # VerticalExecutor — Map registry + in-process dispatch
│   ├── horizontal.ts     # HorizontalExecutor — stub (logs warning, no-ops)
│   ├── factory.ts        # createExecutor(arch) factory function
│   └── index.ts          # barrel: re-exports all public symbols
├── index.ts              # reads WORKER_ARCH, calls createExecutor, passes to register()
├── boss.ts               # unchanged
├── lib/
│   └── logger.ts         # unchanged
└── jobs/
    ├── scheduler/index.ts    # register(boss, executor) — handler extracted
    ├── discovery/index.ts    # register(boss, executor) — two handlers extracted
    ├── kb-sync/index.ts      # register(boss, executor) — handler extracted
    └── agent-ops-scheduler/index.ts  # register(boss, executor) — handler extracted
```

### Pattern 1: JobExecutor Interface

```typescript
// workers/src/executor/types.ts
export type HandlerFn = (jobData: unknown) => Promise<void>;

export interface JobExecutor {
  execute(jobName: string, jobData: unknown): Promise<void>;
}
```

### Pattern 2: VerticalExecutor with Map Registry

```typescript
// workers/src/executor/vertical.ts
import { createLogger } from '../lib/logger.js';
import type { HandlerFn, JobExecutor } from './types.js';

const log = createLogger('vertical-executor');

export class VerticalExecutor implements JobExecutor {
  private readonly registry = new Map<string, HandlerFn>();

  registerHandler(jobName: string, handler: HandlerFn): void {
    this.registry.set(jobName, handler);
  }

  async execute(jobName: string, jobData: unknown): Promise<void> {
    const handler = this.registry.get(jobName);
    if (!handler) {
      throw new Error(`No handler registered for job: ${jobName}`);
    }
    log.debug('Executing job in-process', { jobName });
    await handler(jobData);
  }
}
```

### Pattern 3: HorizontalExecutor Stub

```typescript
// workers/src/executor/horizontal.ts
import { createLogger } from '../lib/logger.js';
import type { JobExecutor } from './types.js';

const log = createLogger('horizontal-executor');

export class HorizontalExecutor implements JobExecutor {
  async execute(jobName: string, _jobData: unknown): Promise<void> {
    log.warn('HorizontalExecutor is a stub — ECS dispatch not yet implemented', { jobName });
    // Phase 24 will implement ECS RunTask dispatch here
  }
}
```

### Pattern 4: Factory Function

```typescript
// workers/src/executor/factory.ts
import { VerticalExecutor } from './vertical.js';
import { HorizontalExecutor } from './horizontal.js';
import type { JobExecutor } from './types.js';

export function createExecutor(arch: string): JobExecutor {
  switch (arch) {
    case 'vertical':
      return new VerticalExecutor();
    case 'horizontal':
      return new HorizontalExecutor();
    default:
      throw new Error(`Unknown WORKER_ARCH: "${arch}". Valid values: vertical, horizontal`);
  }
}
```

### Pattern 5: Updated index.ts

```typescript
// workers/src/index.ts
import { createBoss } from './boss.js';
import { createExecutor } from './executor/index.js';
import { register as registerSchedulerJobs } from './jobs/scheduler/index.js';
import { register as registerKbSyncJobs } from './jobs/kb-sync/index.js';
import { register as registerDiscoveryJobs } from './jobs/discovery/index.js';
import { register as registerAgentOpsSchedulerJobs } from './jobs/agent-ops-scheduler/index.js';

const WORKER_ARCH = process.env.WORKER_ARCH ?? 'vertical';
const boss = createBoss();
const executor = createExecutor(WORKER_ARCH);

async function main() {
  console.log(`[workers] Starting pg-boss (WORKER_ARCH=${WORKER_ARCH})...`);
  // ... rest unchanged, but register calls gain executor arg
  await registerSchedulerJobs(boss, executor);
  await registerKbSyncJobs(boss, executor);
  await registerDiscoveryJobs(boss, executor);
  await registerAgentOpsSchedulerJobs(boss, executor);
}
```

### Pattern 6: Updated register() — scheduler example

The scheduler uses dynamic per-tenant queue names (`scheduler-scan:${tenantId}`). The canonical handler name passed to `executor.execute()` must be a stable string, not the dynamic queue name.

```typescript
// workers/src/jobs/scheduler/index.ts (excerpt)
import type { JobExecutor } from '../../executor/index.js';

// Extracted handler — receives full jobData, tenantId is inside it
async function handleSchedulerScan(jobData: unknown): Promise<void> {
  const event = jobData as SchedulerEvent & { tenantId: string };
  const { tenantId } = event;
  const triggeredBy = event?.triggeredBy || 'system';
  const isPartialScan = event?.scheduleId || event?.scheduleName;
  if (isPartialScan) {
    await runPartialScan(event, triggeredBy);
  } else {
    await runFullScan(triggeredBy);
  }
}

async function registerTenantSchedule(boss: PgBoss, executor: JobExecutor, tenantId: string): Promise<void> {
  const queueName = `scheduler-scan:${tenantId}`;
  // ... queue creation + schedule unchanged ...

  // Register handler with executor (VerticalExecutor only — no-op for HorizontalExecutor)
  if ('registerHandler' in executor) {
    (executor as VerticalExecutor).registerHandler('scheduler-scan', handleSchedulerScan);
  }

  await boss.work<SchedulerEvent>(queueName, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await executor.execute('scheduler-scan', { ...job.data, tenantId });
    }
  });
}

export async function register(boss: PgBoss, executor: JobExecutor): Promise<void> {
  // ... rest unchanged
}
```

**Note on registerHandler call site:** Calling `registerHandler` inside `registerTenantSchedule` (which loops per tenant) would re-register the same handler N times. The handler registration should happen once, outside the loop. See Pitfall 2 below.

### Pattern 7: kb-sync — per-job execution inside batch loop

kb-sync uses `batchSize: 3`. The executor call must remain inside the per-job loop:

```typescript
export async function register(boss: PgBoss, executor: JobExecutor): Promise<void> {
  await boss.createQueue('kb-sync');

  // Register handler once
  if ('registerHandler' in executor) {
    (executor as VerticalExecutor).registerHandler('kb-sync', handleKbSync);
  }

  await boss.work<KBSyncJob>('kb-sync', { batchSize: 3 }, async (jobs) => {
    for (const job of jobs) {
      await executor.execute('kb-sync', job.data);  // per-job, not per-batch
    }
  });
}
```

### Anti-Patterns to Avoid

- **Passing the dynamic queue name as jobName to executor.execute():** `executor.execute('scheduler-scan:tenant-123', data)` — the registry key would need to match exactly. Use canonical names like `'scheduler-scan'` instead.
- **Registering handlers inside per-tenant loops:** `registerHandler` called N times for the same handler name is harmless (Map.set overwrites) but wasteful and confusing. Register once before the loop.
- **Wrapping executor.execute() in try/catch inside boss.work():** D-13 says no additional error wrapping. Let the throw propagate to pg-boss for retry handling.
- **Importing VerticalExecutor directly in job files:** Job files should only depend on the `JobExecutor` interface. The `registerHandler` call requires a type narrowing check (`'registerHandler' in executor`) or an alternative registration approach — see Open Questions.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Retry logic | Custom retry loop in executor | pg-boss retryLimit/retryDelay/retryBackoff | Already configured in boss.ts; double-retry causes confusion |
| Job queue management | Executor managing queues | Keep in register() per D-03 | Separation of concerns; executor is dispatch-only |
| Dynamic handler loading | Convention-based import by name | Explicit Map registry | ESM dynamic imports add complexity; Map is transparent and testable |

## Common Pitfalls

### Pitfall 1: Dynamic Queue Names vs. Handler Registry Keys

**What goes wrong:** `scheduler` and `agent-ops-scheduler` use per-tenant/per-task queue names (`scheduler-scan:${tenantId}`, `agent-ops-task:${taskId}`). If the dynamic queue name is passed as `jobName` to `executor.execute()`, the registry lookup fails because no handler was registered under that key.

**Why it happens:** The queue name is dynamic but the handler is shared across all tenants/tasks.

**How to avoid:** Use a canonical job name (e.g. `'scheduler-scan'`, `'agent-ops-task'`) as the registry key. The tenantId/taskId is already in `job.data` — pass it through as part of `jobData`.

**Warning signs:** `Error: No handler registered for job: scheduler-scan:tenant-abc123` at runtime.

### Pitfall 2: registerHandler Called Inside Per-Tenant Loop

**What goes wrong:** `registerTenantSchedule()` is called in a loop over all tenants. If `registerHandler('scheduler-scan', fn)` is inside that function, it's called N times. While Map.set is idempotent, it signals a misunderstanding of the architecture.

**Why it happens:** Handler registration is co-located with queue registration for convenience.

**How to avoid:** Call `registerHandler` once in the top-level `register(boss, executor)` function, before the per-tenant loop.

### Pitfall 3: Coupling Job Files to VerticalExecutor Concrete Type

**What goes wrong:** Job files import `VerticalExecutor` directly to call `registerHandler()`, creating a concrete dependency that breaks when `HorizontalExecutor` is used.

**Why it happens:** `registerHandler` is not on the `JobExecutor` interface (it shouldn't be — it's an implementation detail of VerticalExecutor).

**How to avoid:** Two clean options — (a) use `'registerHandler' in executor` type narrowing, or (b) have `createExecutor` return a richer type that includes an optional `registerHandler`. See Open Questions #1.

### Pitfall 4: ESM Import Extensions

**What goes wrong:** TypeScript files in `workers/` use `"type": "module"` and `moduleResolution: "bundler"`. Imports between executor files must use `.js` extensions (e.g. `import { VerticalExecutor } from './vertical.js'`), not `.ts`.

**Why it happens:** Node.js ESM requires explicit extensions; TypeScript with bundler resolution maps `.js` → `.ts` at compile time.

**Warning signs:** `ERR_MODULE_NOT_FOUND` at runtime when running `node dist/index.js`.

### Pitfall 5: HorizontalExecutor Stub Must Not Throw

**What goes wrong:** If `HorizontalExecutor.execute()` throws, starting the worker with `WORKER_ARCH=horizontal` causes every job to fail immediately, violating EXEC-02's "without crashing" requirement.

**How to avoid:** Stub logs a warning and returns (no-op). Phase 24 replaces the no-op with ECS RunTask dispatch.

## Code Examples

### Barrel export

```typescript
// workers/src/executor/index.ts
export type { JobExecutor, HandlerFn } from './types.js';
export { VerticalExecutor } from './vertical.js';
export { HorizontalExecutor } from './horizontal.js';
export { createExecutor } from './factory.js';
```

### discovery/index.ts — two handlers, two registrations

Discovery has two queues: `discovery-fan-out` (fan-out logic) and `discovery-scan` (per-tenant scan). Both need separate handler registrations:

```typescript
export async function register(boss: PgBoss, executor: JobExecutor): Promise<void> {
  // Register both handlers once at the top
  if ('registerHandler' in executor) {
    const ve = executor as VerticalExecutor;
    ve.registerHandler('discovery-fan-out', handleDiscoveryFanOut);
    ve.registerHandler('discovery-scan', handleDiscoveryScan);
  }

  // Queue setup unchanged...
  await boss.work<DiscoveryFanOutJob>('discovery-fan-out', { batchSize: 1 }, async ([job]) => {
    await executor.execute('discovery-fan-out', job.data);
  });

  await boss.work<DiscoveryScanJob>('discovery-scan', { batchSize: 1 }, async ([job]) => {
    await executor.execute('discovery-scan', job.data);
  });
}
```

### Vitest test pattern for VerticalExecutor

```typescript
// workers/src/executor/vertical.test.ts
import { describe, it, expect, vi } from 'vitest';
import { VerticalExecutor } from './vertical.js';

describe('VerticalExecutor', () => {
  it('calls registered handler with jobData', async () => {
    const executor = new VerticalExecutor();
    const handler = vi.fn().mockResolvedValue(undefined);
    executor.registerHandler('test-job', handler);
    await executor.execute('test-job', { foo: 'bar' });
    expect(handler).toHaveBeenCalledWith({ foo: 'bar' });
  });

  it('throws when no handler registered', async () => {
    const executor = new VerticalExecutor();
    await expect(executor.execute('unknown-job', {})).rejects.toThrow('No handler registered for job: unknown-job');
  });

  it('propagates handler errors without wrapping', async () => {
    const executor = new VerticalExecutor();
    executor.registerHandler('failing-job', async () => { throw new Error('handler error'); });
    await expect(executor.execute('failing-job', {})).rejects.toThrow('handler error');
  });
});
```

## Open Questions

1. **How should job files call `registerHandler` without importing `VerticalExecutor` directly?**
   - What we know: `registerHandler` is an implementation detail of `VerticalExecutor`, not on the `JobExecutor` interface. Job files should only depend on the interface.
   - What's unclear: The cleanest way to bridge this — type narrowing (`'registerHandler' in executor`) works but is slightly awkward.
   - Recommendation: Define an optional `registerHandler?` on the `JobExecutor` interface itself, or use a separate `HandlerRegistry` interface that `VerticalExecutor` implements. The planner should pick one approach and apply it consistently across all 4 job files.

2. **scheduler/index.ts uses `console.log` instead of `createLogger`**
   - What we know: All other job files use `createLogger`. scheduler/index.ts uses raw `console.log`.
   - What's unclear: Whether to fix this inconsistency in Phase 22 or leave it.
   - Recommendation: Fix it in Phase 22 as part of the handler extraction refactor — the handler function should use `createLogger('scheduler')`. Low risk, keeps the codebase consistent.

## Environment Availability

Step 2.6: SKIPPED — this phase is purely code/config changes with no external dependencies beyond what is already running.

## Sources

### Primary (HIGH confidence)
- Direct code inspection: `workers/src/index.ts`, `workers/src/boss.ts`, `workers/src/lib/logger.ts`
- Direct code inspection: all 4 job registration files
- Direct code inspection: `workers/package.json`, `workers/tsconfig.json`
- `.planning/phases/22-executor-abstraction-foundation/22-CONTEXT.md` — locked decisions

### Secondary (MEDIUM confidence)
- TypeScript strategy pattern — standard GoF pattern, well-established in TypeScript ecosystem
- pg-boss v10 retry behavior — verified from `boss.ts` configuration (retryLimit: 3, retryDelay: 30, retryBackoff: true)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies; all libraries already in package.json
- Architecture: HIGH — derived directly from locked decisions + actual code inspection
- Pitfalls: HIGH — identified from reading actual job file implementations

**Research date:** 2026-04-09
**Valid until:** 2026-05-09 (stable — no external dependencies)
