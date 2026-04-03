# pg-boss Worker Migration Design

**Date:** 2026-04-04
**Status:** Approved
**Scope:** Replace Scheduler Lambda + KB Sync Processor Lambda with a dedicated pg-boss worker service running in ECS Fargate alongside the existing web-ui container.

---

## Problem

The current background job architecture uses AWS Lambda + SQS for two TypeScript workers:

- **Scheduler Lambda** — EventBridge cron every 30min → starts/stops EC2/RDS/ECS/ASG/DocDB across accounts
- **KB Sync Processor Lambda** — SQS → embeds KB content (file-upload, S3, Confluence, Bitbucket) into S3 Vectors

This requires maintaining Lambda deployment packages, SQS queues + DLQs, EventBridge rules, and separate IAM roles — significant infrastructure overhead for two workers that are already TypeScript and already talk to PostgreSQL.

**Out of scope:** Vector Processor Lambda (Python) and Discovery ECS task (Python) — to be migrated in a future sprint.

---

## Solution

Replace Lambda + SQS with a standalone `/workers` Node.js service using [pg-boss](https://github.com/timgit/pg-boss). pg-boss uses PostgreSQL as its job queue backend — no new infrastructure, no new AWS services. The workers container runs in the same ECS cluster as web-ui, sharing the existing PostgreSQL database.

---

## Architecture

```
nucleus-cloud-ops/
├── prisma/              ← shared schema (unchanged, root-level)
├── web-ui/              ← Next.js (producer: boss.send())
├── workers/             ← NEW: standalone Node.js pg-boss process
│   ├── src/
│   │   ├── index.ts              # entry: start boss, register all jobs + crons
│   │   ├── boss.ts               # pg-boss singleton
│   │   └── jobs/
│   │       ├── scheduler/        # mirrors lambda/scheduler/src/
│   │       │   ├── index.ts      # registers job + cron with boss
│   │       │   ├── services/
│   │       │   │   ├── scheduler-service.ts
│   │       │   │   ├── pg-service.ts
│   │       │   │   ├── sts-service.ts
│   │       │   │   └── execution-history-service.ts
│   │       │   ├── resource-schedulers/
│   │       │   │   ├── ec2-scheduler.ts
│   │       │   │   ├── rds-scheduler.ts
│   │       │   │   ├── ecs-scheduler.ts
│   │       │   │   ├── asg-scheduler.ts
│   │       │   │   ├── docdb-scheduler.ts
│   │       │   │   └── index.ts
│   │       │   ├── types/
│   │       │   └── utils/
│   │       └── kb-sync/          # mirrors lambda/kb_sync_processor/src/
│   │           ├── index.ts      # registers job with boss
│   │           ├── handlers/
│   │           │   ├── file-upload.ts
│   │           │   ├── s3-sync.ts
│   │           │   ├── confluence-sync.ts
│   │           │   └── bitbucket-sync.ts
│   │           ├── lib/
│   │           │   ├── chunking.ts
│   │           │   ├── embedding.ts
│   │           │   ├── parsing.ts
│   │           │   └── vector-store.ts
│   │           └── types.ts
│   ├── Dockerfile
│   ├── package.json
│   └── tsconfig.json
├── infra/               ← remove Lambda + SQS, add workers ECS service
└── lambda/
    ├── scheduler/       ← DELETE after migration verified
    ├── kb_sync_processor/ ← DELETE after migration verified
    ├── discovery/       ← keep (out of scope)
    └── vector_processor/ ← keep (out of scope)
```

Each `jobs/<name>/index.ts` exports a `register(boss: PgBoss)` function. `src/index.ts` calls all `register()` functions at startup.

---

## Data Flow

```
┌─────────────────────────────────────────────────────────┐
│  web-ui (ECS)                                           │
│                                                         │
│  KB Sync API route                                      │
│    → boss.send('kb-sync', { type, kbId, dsId, ... })   │
│                                                         │
│  Manual schedule trigger API route                      │
│    → boss.send('scheduler-scan', { scheduleId, ... })  │
└────────────────────────┬────────────────────────────────┘
                         │ PostgreSQL (pgboss schema)
                         ▼
┌─────────────────────────────────────────────────────────┐
│  workers (ECS)                                          │
│                                                         │
│  pg-boss cron: '*/30 * * * *'                          │
│    → enqueues scheduler-scan (full scan, no payload)   │
│                                                         │
│  boss.work('scheduler-scan', { teamSize: 1 })          │
│    → jobs/scheduler/index.ts                           │
│    → runs full or partial scan via scheduler-service   │
│                                                         │
│  boss.work('kb-sync', { teamSize: 3 })                 │
│    → jobs/kb-sync/index.ts                             │
│    → dispatches to file-upload / s3-sync / confluence  │
│       / bitbucket handler                              │
└─────────────────────────────────────────────────────────┘
```

- `teamSize: 1` on scheduler-scan — runs serially, prevents concurrent full scans
- `teamSize: 3` on kb-sync — max 3 concurrent KB jobs, prevents Bedrock rate limiting
- Failed jobs retry with pg-boss exponential backoff; after max retries they land in `pgboss.archive` (queryable, no DLQ needed)
- `boss.send()` in web-ui is fire-and-forget; API routes return immediately

---

## Web-UI Producer Changes

### New file: `web-ui/lib/boss-client.ts`
Singleton pg-boss client in producer-only mode. Connects via `DATABASE_URL`. Initialized lazily on first use. No workers registered here.

### Updated API routes
| Route | Before | After |
|---|---|---|
| `app/api/knowledge-base/[kbId]/datasources/[dsId]/sync/route.ts` | `SQSClient.send(SendMessageCommand)` | `boss.send('kb-sync', payload)` |
| `app/api/schedules/[id]/trigger/route.ts` | `LambdaClient.send(InvokeCommand)` | `boss.send('scheduler-scan', payload)` |

### Env vars removed from web-ui container
- `KB_SYNC_QUEUE_URL`
- `SCHEDULER_LAMBDA_ARN`

---

## Infrastructure Changes (Pulumi — `infra/compute/index.ts`)

### Removed
- `vectorProcessingQueue`, `vectorProcessingDlq`, `vectorProcessingQueuePolicy`
- `kbSyncQueue`, `kbSyncDlq`
- `schedulerLambda`, `schedulerLambdaRole`, all scheduler Lambda IAM policies
- `kbSyncProcessorLambda`, `kbSyncProcessorRole`, all KB sync Lambda IAM policies
- `schedulerRule`, `schedulerTriggerTarget`, `schedulerEventBridgePermission`
- All SQS exports

### Added
- `workers` ECS task definition + service (same cluster as web-ui)
  - CPU: 512, Memory: 1024
  - Env vars: `DATABASE_URL`, `AWS_REGION`, cross-account role vars
- `workersTaskRole` IAM role with:
  - STS AssumeRole (cross-account scheduling)
  - DynamoDB read/write (audit logs, execution history)
  - SNS publish (scheduler notifications)
  - Bedrock InvokeModel (KB sync embeddings)
  - S3 Vectors PutVectors, DeleteVectors (KB sync)
  - S3 GetObject (KB staging bucket)
- `workers` ECR repository
- `build-images.sh` — add workers build step

### Unchanged
- `dailyDiscoverySchedule` (EventBridge Scheduler → ECS discovery task)
- `vectorProcessorLambda` (out of scope)
- All networking, ALB, CloudFront, DynamoDB tables

---

## workers Package Setup

```json
// workers/package.json (key fields)
{
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "pg-boss": "^10.x",
    "pg": "^8.x",
    "@aws-sdk/client-sts": "^3.x",
    "@aws-sdk/client-ec2": "^3.x",
    "@aws-sdk/client-rds": "^3.x",
    "@aws-sdk/client-ecs": "^3.x",
    "@aws-sdk/client-auto-scaling": "^3.x",
    "@aws-sdk/client-docdb": "^3.x",
    "@aws-sdk/client-bedrock-runtime": "^3.x",
    "@aws-sdk/client-s3": "^3.x",
    "@aws-sdk/client-s3vectors": "^3.x",
    "@prisma/client": "^6.x"
  }
}
```

Prisma schema referenced from root: `prisma generate --schema=../prisma/schema.prisma`

---

## Testing

- **Unit tests** — Vitest, colocated in `workers/src/jobs/<name>/`. AWS SDK clients mocked. Mirrors existing `lambda/scheduler/src/services/dynamodb-service.test.ts` pattern.
- **Existing test from lambda/scheduler** — `dynamodb-service.test.ts` moves to `workers/src/jobs/scheduler/services/` and runs as-is.
- **Integration smoke test** — `docker compose up` starts postgres + workers. Script enqueues a `scheduler-scan` job and polls `pgboss.job` until `completed` or `failed`.
- **Web-ui tests unchanged** — `boss.send()` calls mocked the same way SQS was mocked.

---

## Migration Sequence

1. Scaffold `/workers` with pg-boss, tsconfig, Dockerfile
2. Migrate `jobs/scheduler/` — copy services + resource-schedulers from `lambda/scheduler/src/`, wire into pg-boss cron + worker
3. Migrate `jobs/kb-sync/` — split monolithic `lambda/kb_sync_processor/src/index.ts` into handler files, wire into pg-boss worker
4. Add `web-ui/lib/boss-client.ts` + update two API routes
5. Update Pulumi infra — add workers ECS service, remove Lambda + SQS
6. Smoke test locally with docker compose
7. Deploy workers ECS service, verify jobs run
8. Delete `lambda/scheduler/` and `lambda/kb_sync_processor/`
