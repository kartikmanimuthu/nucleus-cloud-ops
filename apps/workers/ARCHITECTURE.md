# Workers Architecture — Horizontal & Vertical Execution

> **See also:** [`docs/pgboss-worker-architecture.md`](docs/pgboss-worker-architecture.md)
> — the current, diagram-heavy deep dive on the pg-boss queue model, the fan-out +
> atomic-claim multi-tenant design, dead-letter/health/monitoring, and (in detail)
> **how a horizontally-dispatched ephemeral task's success/error is propagated back
> to the worker and how the worker tracks that task**. This file below covers the
> directory layout, IAM, and mode-switching.

## Overview

The workers service processes background jobs (resource scheduling, inventory discovery, knowledge base sync) using [pg-boss](https://github.com/timgit/pg-boss) as the job queue backed by PostgreSQL.

Jobs can run in two modes controlled by the `WORKER_ARCH` environment variable:

| Mode | Value | Description |
|------|-------|-------------|
| Vertical | `WORKER_ARCH=vertical` | Job handler runs in-process inside the long-lived workers container (default) |
| Horizontal | `WORKER_ARCH=horizontal` | Each job dispatches to an ephemeral ECS Fargate task that exits on completion |

---

## High Level Design

### System Flow

```
┌──────────────────────────────────────────────────────────────────┐
│                  ECS Fargate — Workers Service                    │
│                  (long-lived, always running)                     │
│                                                                  │
│   PostgreSQL (pg-boss queue)                                     │
│         │                                                        │
│         ▼  job enqueued                                          │
│   boss.work() callback fires                                     │
│         │                                                        │
│         ▼                                                        │
│   executor.execute(jobName, jobData)                             │
│         │                                                        │
│         ├─── WORKER_ARCH=vertical ──────► run handler here       │
│         │                                 (in-process, blocking) │
│         │                                                        │
│         └─── WORKER_ARCH=horizontal ───► ECS RunTask API ──────► │
│                                          Ephemeral Fargate Task  │
│                                          (exits when job done)   │
└──────────────────────────────────────────────────────────────────┘
```

### Mode Comparison

| Concern | Vertical | Horizontal |
|---------|----------|------------|
| Where job runs | Inside workers process | Separate ECS Fargate container |
| Memory isolation | Shared with worker process | Fully isolated (256 CPU / 512 MiB) |
| Concurrency | Limited by worker process | One container per job, unlimited |
| Cold start | None | ~10–30s ECS task startup |
| Cost | Included in workers service | Per-task Fargate billing |
| Best for | Development, low-traffic | Production, heavy/long-running jobs |
| Failure isolation | Job failure can affect worker | Container exits, worker unaffected |

### Infrastructure (Pulumi-provisioned)

```
Workers ECS Service  ──── WORKER_ARCH=horizontal ────►  ECS RunTask
(long-lived)                                                  │
                                                              ▼
                                              Ephemeral Worker Task Definition
                                              ├── Family: nucleus-cloud-ops-ephemeral-worker-task
                                              ├── CPU: 256 / Memory: 512 MiB
                                              ├── Same Docker image as workers service
                                              ├── ARM64 Fargate
                                              └── CloudWatch: /ecs/nucleus-cloud-ops-ephemeral-workers
```

---

## Low Level Design

### Directory Structure

```
workers/
├── src/
│   ├── index.ts                    # Long-lived entrypoint — starts pg-boss, registers jobs
│   ├── job-runner.ts               # One-shot entrypoint — used by ephemeral ECS tasks
│   ├── boss.ts                     # pg-boss client factory
│   ├── executor/
│   │   ├── types.ts                # JobExecutor interface + HandlerFn type
│   │   ├── factory.ts              # createExecutor(WORKER_ARCH) → JobExecutor
│   │   ├── vertical.ts             # VerticalExecutor — in-process Map-based dispatch
│   │   ├── horizontal.ts           # HorizontalExecutor — ECS RunTask dispatch + polling
│   │   ├── index.ts                # Barrel export
│   │   ├── vertical.test.ts
│   │   ├── horizontal.test.ts
│   │   └── factory.test.ts
│   └── jobs/
│       ├── scheduler/              # Resource start/stop scheduling
│       ├── discovery/              # Multi-account AWS inventory scan
│       ├── kb-sync/                # Knowledge base sync (S3, Confluence, Bitbucket)
│       └── agent-ops-scheduler/    # Agent ops tick
└── ARCHITECTURE.md                 # This file
```

### Core Interface

```typescript
// src/executor/types.ts

export type HandlerFn = (jobData: unknown) => Promise<void>;

export interface JobExecutor {
    execute(jobName: string, jobData: unknown): Promise<void>;
    registerHandler?(jobName: string, handler: HandlerFn): void;
}
```

`registerHandler` is optional — `HorizontalExecutor` dispatches to ECS and never runs handlers locally, so it doesn't implement it.

### Factory

```typescript
// src/executor/factory.ts

export function createExecutor(arch: string): JobExecutor {
    switch (arch) {
        case 'vertical':   return new VerticalExecutor();
        case 'horizontal': return new HorizontalExecutor();
        default: throw new Error(`Unknown WORKER_ARCH: "${arch}"`);
    }
}
```

Called once at startup in `index.ts`:

```typescript
const executor = createExecutor(process.env.WORKER_ARCH ?? 'vertical');
```

The executor instance is passed to every job's `register()` function.

---

### VerticalExecutor

Runs job handlers in-process using a `Map<string, HandlerFn>` registry.

```
registerHandler(name, fn) → stores in Map
execute(name, data)       → Map.get(name)(data)  ← runs synchronously in worker process
```

**Sequence:**

```
pg-boss fires job
  └─► boss.work callback
        └─► executor.execute("scheduler-scan", data)
              └─► VerticalExecutor
                    └─► registry.get("scheduler-scan")(data)   ← handler runs here
                          └─► pg-boss marks job complete
```

**Source:** `src/executor/vertical.ts` (21 lines)

---

### HorizontalExecutor

Dispatches each job to an ephemeral ECS Fargate task and polls until it exits.

**Sequence:**

```
pg-boss fires job
  └─► boss.work callback
        └─► executor.execute("scheduler-scan", data)
              └─► HorizontalExecutor
                    ├─► Read env vars (HORIZONTAL_CLUSTER_ARN, TASK_DEF_ARN, SUBNETS, SG)
                    ├─► ECS RunTask
                    │     cluster: HORIZONTAL_CLUSTER_ARN
                    │     taskDefinition: HORIZONTAL_TASK_DEF_ARN
                    │     launchType: FARGATE
                    │     containerOverrides.command:
                    │       ["node", "dist/job-runner.js",
                    │        "--job", "scheduler-scan",
                    │        "--data", '{"tenantId":"..."}']
                    │
                    ├─► Fail fast if RunTask returns failures[] or empty tasks[]
                    ├─► Extract taskArn
                    │
                    └─► Poll DescribeTasks (exponential backoff)
                          initial: 2s → doubles → cap: 30s
                          timeout: 15 min (HORIZONTAL_TASK_TIMEOUT_MS)
                          │
                          ├─► task.lastStatus !== "STOPPED" → sleep, retry
                          ├─► exitCode === 0 → return  (pg-boss marks complete)
                          └─► exitCode !== 0 → throw   (pg-boss retries per retryLimit)
```

**Required environment variables:**

| Variable | Description | Set by |
|----------|-------------|--------|
| `HORIZONTAL_CLUSTER_ARN` | ECS cluster to run tasks on | Pulumi (auto-wired) |
| `HORIZONTAL_TASK_DEF_ARN` | Ephemeral task definition ARN | Pulumi (auto-wired) |
| `HORIZONTAL_SUBNETS` | Comma-separated private subnet IDs | Pulumi (auto-wired) |
| `HORIZONTAL_SECURITY_GROUP` | Security group ID (egress-only) | Pulumi (auto-wired) |
| `HORIZONTAL_TASK_TIMEOUT_MS` | Max wait time in ms (default: 900000) | Optional |
| `HORIZONTAL_POLL_INTERVAL_MS` | Initial poll interval in ms (default: 2000) | Optional |

All 4 required vars are injected automatically into the workers task definition by Pulumi — no manual configuration needed after `pulumi up`.

**Source:** `src/executor/horizontal.ts` (123 lines)

---

### Job Wiring Pattern

Every job module exports a `register(boss, executor)` function. The pattern is identical for all jobs:

```typescript
// Example: src/jobs/scheduler/index.ts

export async function register(boss: PgBoss, executor: JobExecutor): Promise<void> {
    // 1. Register handler with executor (used by VerticalExecutor)
    executor.registerHandler?.('scheduler-scan', handleSchedulerJob);

    // 2. Create queue (required in pg-boss v10 before schedule/work)
    await boss.createQueue('scheduler-scan');

    // 3. Schedule cron (optional — discovery uses manual send instead)
    await boss.schedule('scheduler-scan', '*/30 * * * *', {}, { tz: 'UTC' });

    // 4. Register worker — boss.work is the same regardless of executor mode
    await boss.work('scheduler-scan', { batchSize: 1 }, async (jobs) => {
        for (const job of jobs) {
            await executor.execute('scheduler-scan', job.data);
            //     ↑ vertical:    calls handleSchedulerJob(job.data) directly
            //     ↑ horizontal:  fires ECS RunTask, waits for container exit
        }
    });
}
```

The `boss.work` callback is **identical in both modes** — the executor abstracts the difference completely.

---

### job-runner.ts — Ephemeral Container Entrypoint

Used **only in horizontal mode**. The ECS task overrides the container command to run this instead of the long-lived `index.ts`.

```
node dist/job-runner.js --job scheduler-scan --data '{"tenantId":"t1","triggeredBy":"cron"}'
```

**Flow:**

```
parseArgs()
  └─► { job: "scheduler-scan", data: { tenantId: "t1", ... } }

new VerticalExecutor()
  └─► registerHandler("scheduler-scan", handleSchedulerJob)
  └─► registerHandler("discovery-scan", handleDiscoveryScan)
  └─► registerHandler("kb-sync", handleKbSyncJob)
  └─► registerHandler("agent-ops-task:<id>", handleAgentOpsTick)  ← dynamic prefix

executor.execute("scheduler-scan", data)
  └─► handleSchedulerJob(data)   ← runs the actual job logic

process.exit(0)   ← HorizontalExecutor sees exitCode=0, resolves promise
                     pg-boss marks the original job complete
```

Key points:
- No pg-boss connection — it's a one-shot runner, not a queue consumer
- Uses `VerticalExecutor` internally (handler runs in-process within the ephemeral container)
- `agent-ops-task:*` uses a dynamic queue name prefix — registered on-demand from the `--job` arg
- Exit code propagates back: `0` = success, non-zero = failure (pg-boss retries)

**Source:** `src/job-runner.ts`

---

### End-to-End Data Flow

#### Vertical mode

```
Cron trigger / API call
  → pg-boss enqueues job in PostgreSQL
  → Workers service: boss.work() fires
  → executor.execute(jobName, data)
  → VerticalExecutor: handler(data) runs in-process
  → handler completes
  → pg-boss marks job complete in PostgreSQL
```

#### Horizontal mode

```
Cron trigger / API call
  → pg-boss enqueues job in PostgreSQL
  → Workers service: boss.work() fires
  → executor.execute(jobName, data)
  → HorizontalExecutor: ECS RunTask API call
  → AWS launches ephemeral Fargate task (same Docker image)
  → Ephemeral task: node dist/job-runner.js --job <name> --data '<json>'
  → job-runner: handler(data) runs in isolated container
  → handler completes → process.exit(0)
  → HorizontalExecutor: DescribeTasks polls → STOPPED + exitCode=0
  → HorizontalExecutor resolves
  → pg-boss marks job complete in PostgreSQL
  → Ephemeral container is destroyed by ECS
```

---

### IAM Permissions (Horizontal mode)

The workers task role (`nucleus-cloud-ops-workers-task-role`) has an additional policy for ECS dispatch:

```json
{
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["ecs:RunTask"],
      "Resource": ["<ephemeral-task-def-arn>"]
    },
    {
      "Effect": "Allow",
      "Action": ["ecs:DescribeTasks"],
      "Resource": ["*"],
      "Condition": { "ArnEquals": { "ecs:cluster": "<cluster-arn>" } }
    },
    {
      "Effect": "Allow",
      "Action": ["iam:PassRole"],
      "Resource": ["<workers-task-role-arn>", "<ecs-execution-role-arn>"]
    }
  ]
}
```

`iam:PassRole` is required because `RunTask` needs to pass both the task role and execution role to the new container.

---

### Switching Modes

**Development (default):**
```bash
# No env var needed — defaults to vertical
npm run dev
```

**Horizontal (production):**
```bash
# Set in ECS task definition environment (managed by Pulumi)
WORKER_ARCH=horizontal

# Required companion vars (auto-wired by Pulumi):
HORIZONTAL_CLUSTER_ARN=arn:aws:ecs:us-east-1:...
HORIZONTAL_TASK_DEF_ARN=arn:aws:ecs:us-east-1:...
HORIZONTAL_SUBNETS=subnet-xxx,subnet-yyy
HORIZONTAL_SECURITY_GROUP=sg-xxx
```

To switch production to horizontal: update the `WORKER_ARCH` env var in the Pulumi compute stack config and run `pulumi up`.

---

### Testing

```bash
# Run all executor unit tests
cd workers && npx vitest run src/executor/

# Run a specific executor test
cd workers && npx vitest run src/executor/horizontal.test.ts

# Type check
cd workers && npx tsc --noEmit
```

The `HorizontalExecutor` tests mock `@aws-sdk/client-ecs` with `vi.mock()` and use `vi.useFakeTimers()` for timeout/backoff tests — no real AWS calls needed.
