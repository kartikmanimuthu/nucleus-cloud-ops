# pg-boss Worker Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Scheduler Lambda + KB Sync Processor Lambda with a standalone pg-boss worker service running in ECS Fargate, eliminating Lambda/SQS/EventBridge infrastructure overhead.

**Architecture:** A new `/workers` Node.js service uses pg-boss (PostgreSQL-backed job queue) to run scheduler cron jobs and KB sync jobs. The web-ui produces jobs via `boss.send()`, the workers container consumes them. Both share the existing PostgreSQL database.

**Tech Stack:** pg-boss ^10.x, Node.js 20, TypeScript, Vitest, Docker, Pulumi, AWS ECS Fargate

---

## File Structure

```
workers/
├── src/
│   ├── index.ts                          # CREATE — entry: start boss, register all jobs + crons
│   ├── boss.ts                           # CREATE — pg-boss singleton factory
│   ├── jobs/
│   │   ├── scheduler/
│   │   │   ├── index.ts                  # CREATE — registers scheduler-scan job + cron with boss
│   │   │   ├── services/
│   │   │   │   ├── scheduler-service.ts  # COPY from lambda/scheduler/src/services/scheduler-service.ts (remove Lambda-specific imports)
│   │   │   │   ├── pg-service.ts         # COPY from lambda/scheduler/src/services/pg-service.ts (unchanged)
│   │   │   │   ├── sts-service.ts        # COPY from lambda/scheduler/src/services/sts-service.ts (unchanged)
│   │   │   │   ├── dynamodb-service.ts   # COPY from lambda/scheduler/src/services/dynamodb-service.ts (unchanged)
│   │   │   │   └── execution-history-service.ts  # COPY from lambda/scheduler/src/services/execution-history-service.ts (unchanged)
│   │   │   ├── resource-schedulers/
│   │   │   │   ├── ec2-scheduler.ts      # COPY from lambda/scheduler/src/resource-schedulers/ (unchanged)
│   │   │   │   ├── rds-scheduler.ts      # COPY unchanged
│   │   │   │   ├── ecs-scheduler.ts      # COPY unchanged
│   │   │   │   ├── asg-scheduler.ts      # COPY unchanged
│   │   │   │   ├── docdb-scheduler.ts    # COPY unchanged
│   │   │   │   └── index.ts             # COPY unchanged
│   │   │   ├── types/
│   │   │   │   └── index.ts             # COPY from lambda/scheduler/src/types/index.ts (remove aws-lambda import)
│   │   │   └── utils/
│   │   │       ├── logger.ts            # COPY from lambda/scheduler/src/utils/logger.ts (unchanged)
│   │   │       └── time-utils.ts        # COPY from lambda/scheduler/src/utils/time-utils.ts (unchanged)
│   │   └── kb-sync/
│   │       ├── index.ts                 # CREATE — registers kb-sync job with boss
│   │       ├── handlers/
│   │       │   ├── file-upload.ts       # CREATE — extracted from lambda/kb_sync_processor/src/index.ts
│   │       │   ├── s3-sync.ts           # CREATE — extracted from lambda/kb_sync_processor/src/index.ts
│   │       │   ├── confluence-sync.ts   # CREATE — extracted from lambda/kb_sync_processor/src/index.ts
│   │       │   └── bitbucket-sync.ts    # CREATE — extracted from lambda/kb_sync_processor/src/index.ts
│   │       ├── lib/
│   │       │   ├── chunking.ts          # CREATE — extracted from lambda/kb_sync_processor/src/index.ts
│   │       │   ├── embedding.ts         # CREATE — extracted from lambda/kb_sync_processor/src/index.ts
│   │       │   ├── parsing.ts           # CREATE — extracted from lambda/kb_sync_processor/src/index.ts
│   │       │   └── vector-store.ts      # CREATE — extracted from lambda/kb_sync_processor/src/index.ts
│   │       └── types.ts                 # CREATE — extracted from lambda/kb_sync_processor/src/index.ts
├── Dockerfile                           # CREATE — ARM64 Node.js 20 slim
├── package.json                         # CREATE
├── tsconfig.json                        # CREATE
└── vitest.config.ts                     # CREATE

web-ui/
├── lib/
│   └── boss-client.ts                   # CREATE — singleton pg-boss producer client
├── app/api/
│   ├── knowledge-base/[kbId]/sources/[dsId]/sync/route.ts  # MODIFY — SQS → boss.send()
│   ├── scheduler/execute/route.ts       # MODIFY — Lambda invoke → boss.send()
│   └── schedules/[scheduleId]/execute/route.ts  # MODIFY — Lambda invoke → boss.send()

infra/
├── compute/index.ts                     # MODIFY — add workers ECS service, remove scheduler Lambda + KB sync Lambda + SQS
├── build-images.sh                      # MODIFY — add workers image build
└── build-lambdas.sh                     # MODIFY — remove scheduler + kb_sync_processor builds
```

---

### Task 1: Scaffold workers package

**Files:**
- Create: `workers/package.json`
- Create: `workers/tsconfig.json`
- Create: `workers/vitest.config.ts`

- [ ] **Step 1: Create workers/package.json**

```json
{
  "name": "nucleus-workers",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "engines": {
    "node": ">=20.0.0"
  },
  "dependencies": {
    "pg-boss": "^10.1.5",
    "pg": "^8.20.0",
    "@aws-sdk/client-sts": "^3.700.0",
    "@aws-sdk/client-ec2": "^3.700.0",
    "@aws-sdk/client-rds": "^3.700.0",
    "@aws-sdk/client-ecs": "^3.700.0",
    "@aws-sdk/client-auto-scaling": "^3.700.0",
    "@aws-sdk/client-sns": "^3.700.0",
    "@aws-sdk/client-dynamodb": "^3.700.0",
    "@aws-sdk/client-bedrock-runtime": "^3.0.0",
    "@aws-sdk/client-s3": "^3.0.0",
    "@aws-sdk/client-s3vectors": "^3.0.0",
    "@aws-sdk/credential-provider-node": "^3.958.0",
    "@aws-sdk/lib-dynamodb": "^3.700.0",
    "@prisma/client": "^6.0.0",
    "dayjs": "^1.11.13",
    "uuid": "^11.0.3",
    "pdf-parse": "^1.1.1"
  },
  "devDependencies": {
    "@types/node": "^22.10.2",
    "@types/pg": "^8.20.0",
    "@types/uuid": "^10.0.0",
    "@types/pdf-parse": "^1.1.4",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: Create workers/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true,
    "noImplicitAny": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "allowSyntheticDefaultImports": true,
    "types": ["node"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

- [ ] **Step 3: Create workers/vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
});
```

- [ ] **Step 4: Install dependencies**

Run: `cd workers && npm install`
Expected: `node_modules/` created, `package-lock.json` generated

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd workers && npx tsc --noEmit`
Expected: No errors (empty project compiles clean)

- [ ] **Step 6: Commit**

```bash
git add workers/package.json workers/tsconfig.json workers/vitest.config.ts workers/package-lock.json
git commit -m "feat(workers): scaffold pg-boss workers package"
```

---

### Task 2: Create pg-boss singleton and entry point

**Files:**
- Create: `workers/src/boss.ts`
- Create: `workers/src/index.ts`

- [ ] **Step 1: Write the failing test for boss singleton**

Create `workers/src/boss.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('pg-boss', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
    })),
  };
});

import { createBoss } from './boss.js';

describe('createBoss', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create a pg-boss instance with DATABASE_URL', () => {
    process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
    const boss = createBoss();
    expect(boss).toBeDefined();
    expect(boss.start).toBeDefined();
    expect(boss.stop).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workers && npx vitest run src/boss.test.ts`
Expected: FAIL — `Cannot find module './boss.js'`

- [ ] **Step 3: Create workers/src/boss.ts**

```typescript
import PgBoss from 'pg-boss';

const DATABASE_URL = process.env.DATABASE_URL;

export function createBoss(): PgBoss {
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  return new PgBoss({
    connectionString: DATABASE_URL,
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    expireInHours: 4,
    archiveCompletedAfterSeconds: 86400, // 24h
    deleteAfterDays: 7,
    monitorStateIntervalSeconds: 30,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd workers && npx vitest run src/boss.test.ts`
Expected: PASS

- [ ] **Step 5: Create workers/src/index.ts**

```typescript
import { createBoss } from './boss.js';

const boss = createBoss();

async function main() {
  console.log('[workers] Starting pg-boss...');

  boss.on('error', (error) => {
    console.error('[workers] pg-boss error:', error);
  });

  await boss.start();
  console.log('[workers] pg-boss started');

  // Job registrations will be added in subsequent tasks
  // await registerSchedulerJobs(boss);
  // await registerKbSyncJobs(boss);

  console.log('[workers] All jobs registered. Waiting for work...');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`[workers] Received ${signal}, shutting down...`);
    await boss.stop({ graceful: true, timeout: 30000 });
    console.log('[workers] pg-boss stopped');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[workers] Fatal error:', err);
  process.exit(1);
});
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `cd workers && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add workers/src/boss.ts workers/src/boss.test.ts workers/src/index.ts
git commit -m "feat(workers): add pg-boss singleton and entry point"
```

---

### Task 3: Copy scheduler types, utils, and services into workers

**Files:**
- Create: `workers/src/jobs/scheduler/types/index.ts`
- Create: `workers/src/jobs/scheduler/utils/logger.ts`
- Create: `workers/src/jobs/scheduler/utils/time-utils.ts`
- Create: `workers/src/jobs/scheduler/services/dynamodb-service.ts`
- Create: `workers/src/jobs/scheduler/services/pg-service.ts`
- Create: `workers/src/jobs/scheduler/services/sts-service.ts`
- Create: `workers/src/jobs/scheduler/services/execution-history-service.ts`

- [ ] **Step 1: Copy types with Lambda import removed**

Copy `lambda/scheduler/src/types/index.ts` to `workers/src/jobs/scheduler/types/index.ts`.

Remove the `import type { Handler } from 'aws-lambda';` line and the `SchedulerHandler` type alias at the bottom. Everything else stays identical.

The file should start with:
```typescript
// Type definitions for the scheduler worker

// Lambda Event Types — reused as pg-boss job payload
export interface SchedulerEvent {
```

And remove these lines from the end:
```typescript
// Handler type
export type SchedulerHandler = Handler<SchedulerEvent, SchedulerResult>;
```

- [ ] **Step 2: Copy utils unchanged**

Copy `lambda/scheduler/src/utils/logger.ts` to `workers/src/jobs/scheduler/utils/logger.ts` — no changes needed.

Copy `lambda/scheduler/src/utils/time-utils.ts` to `workers/src/jobs/scheduler/utils/time-utils.ts` — no changes needed.

- [ ] **Step 3: Copy services unchanged**

Copy these files verbatim (no changes needed — all internal imports use relative paths with `.js` extensions which resolve correctly):

- `lambda/scheduler/src/services/dynamodb-service.ts` → `workers/src/jobs/scheduler/services/dynamodb-service.ts`
- `lambda/scheduler/src/services/pg-service.ts` → `workers/src/jobs/scheduler/services/pg-service.ts`
- `lambda/scheduler/src/services/sts-service.ts` → `workers/src/jobs/scheduler/services/sts-service.ts`
- `lambda/scheduler/src/services/execution-history-service.ts` → `workers/src/jobs/scheduler/services/execution-history-service.ts`

- [ ] **Step 4: Copy the existing test**

Copy `lambda/scheduler/src/services/dynamodb-service.test.ts` → `workers/src/jobs/scheduler/services/dynamodb-service.test.ts` — no changes needed.

- [ ] **Step 5: Verify test passes**

Run: `cd workers && npx vitest run src/jobs/scheduler/services/dynamodb-service.test.ts`
Expected: PASS — all existing assertions pass in the new location

- [ ] **Step 6: Verify TypeScript compiles**

Run: `cd workers && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add workers/src/jobs/scheduler/types/ workers/src/jobs/scheduler/utils/ workers/src/jobs/scheduler/services/
git commit -m "feat(workers): copy scheduler types, utils, and services from lambda"
```

---

### Task 4: Copy resource schedulers into workers

**Files:**
- Create: `workers/src/jobs/scheduler/resource-schedulers/ec2-scheduler.ts`
- Create: `workers/src/jobs/scheduler/resource-schedulers/rds-scheduler.ts`
- Create: `workers/src/jobs/scheduler/resource-schedulers/ecs-scheduler.ts`
- Create: `workers/src/jobs/scheduler/resource-schedulers/asg-scheduler.ts`
- Create: `workers/src/jobs/scheduler/resource-schedulers/docdb-scheduler.ts`
- Create: `workers/src/jobs/scheduler/resource-schedulers/index.ts`

- [ ] **Step 1: Copy all resource schedulers unchanged**

Copy these files verbatim from `lambda/scheduler/src/resource-schedulers/` to `workers/src/jobs/scheduler/resource-schedulers/`:

- `ec2-scheduler.ts`
- `rds-scheduler.ts`
- `ecs-scheduler.ts`
- `asg-scheduler.ts`
- `docdb-scheduler.ts`
- `index.ts` (barrel export)

No changes needed — all imports use relative paths (`../utils/logger.js`, `../services/dynamodb-service.js`, `../types/index.js`) which resolve correctly in the new directory structure.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd workers && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add workers/src/jobs/scheduler/resource-schedulers/
git commit -m "feat(workers): copy resource schedulers from lambda"
```

---

### Task 5: Create scheduler job registration and handler

**Files:**
- Create: `workers/src/jobs/scheduler/index.ts`
- Modify: `workers/src/jobs/scheduler/services/scheduler-service.ts`

- [ ] **Step 1: Copy and adapt scheduler-service.ts**

Copy `lambda/scheduler/src/services/scheduler-service.ts` to `workers/src/jobs/scheduler/services/scheduler-service.ts`.

This file is copied verbatim — no changes needed. All imports use relative paths that resolve correctly in the new structure.

- [ ] **Step 2: Write the failing test for scheduler job registration**

Create `workers/src/jobs/scheduler/index.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockWork = vi.fn();
const mockSchedule = vi.fn();

const mockBoss = {
  work: mockWork,
  schedule: mockSchedule,
  send: vi.fn(),
} as any;

// Mock the scheduler service
vi.mock('./services/scheduler-service.js', () => ({
  runFullScan: vi.fn().mockResolvedValue({
    success: true,
    executionId: 'test-exec',
    mode: 'full',
    schedulesProcessed: 0,
    resourcesStarted: 0,
    resourcesStopped: 0,
    resourcesFailed: 0,
    duration: 100,
  }),
  runPartialScan: vi.fn().mockResolvedValue({
    success: true,
    executionId: 'test-exec',
    mode: 'partial',
    schedulesProcessed: 1,
    resourcesStarted: 0,
    resourcesStopped: 0,
    resourcesFailed: 0,
    duration: 50,
  }),
}));

import { register } from './index.js';

describe('scheduler job registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should register cron schedule and worker', async () => {
    await register(mockBoss);

    // Should schedule a cron
    expect(mockSchedule).toHaveBeenCalledWith(
      'scheduler-scan',
      '*/30 * * * *',
      expect.any(Object),
    );

    // Should register a worker
    expect(mockWork).toHaveBeenCalledWith(
      'scheduler-scan',
      expect.objectContaining({ teamSize: 1 }),
      expect.any(Function),
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd workers && npx vitest run src/jobs/scheduler/index.test.ts`
Expected: FAIL — `Cannot find module './index.js'`

- [ ] **Step 4: Create workers/src/jobs/scheduler/index.ts**

```typescript
import type PgBoss from 'pg-boss';
import { runFullScan, runPartialScan } from './services/scheduler-service.js';
import type { SchedulerEvent } from './types/index.js';

export async function register(boss: PgBoss): Promise<void> {
  // Register cron — every 30 minutes, enqueue a full scan job
  await boss.schedule('scheduler-scan', '*/30 * * * *', {}, {
    tz: 'UTC',
  });

  // Register worker — teamSize: 1 prevents concurrent full scans
  await boss.work<SchedulerEvent>(
    'scheduler-scan',
    { teamSize: 1, teamConcurrency: 1 },
    async (job) => {
      const event = job.data;
      const isPartialScan = event?.scheduleId || event?.scheduleName;
      const triggeredBy = event?.triggeredBy || 'system';

      console.log(`[scheduler] Processing job ${job.id}`, {
        mode: isPartialScan ? 'partial' : 'full',
        triggeredBy,
      });

      if (isPartialScan) {
        const result = await runPartialScan(event, triggeredBy);
        console.log(`[scheduler] Partial scan complete`, result);
      } else {
        const result = await runFullScan(triggeredBy);
        console.log(`[scheduler] Full scan complete`, result);
      }
    },
  );

  console.log('[scheduler] Registered scheduler-scan job + cron');
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd workers && npx vitest run src/jobs/scheduler/index.test.ts`
Expected: PASS

- [ ] **Step 6: Verify TypeScript compiles**

Run: `cd workers && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add workers/src/jobs/scheduler/index.ts workers/src/jobs/scheduler/index.test.ts workers/src/jobs/scheduler/services/scheduler-service.ts
git commit -m "feat(workers): add scheduler job registration with pg-boss cron"
```

---

### Task 6: Extract KB sync types and shared libs from monolithic Lambda

**Files:**
- Create: `workers/src/jobs/kb-sync/types.ts`
- Create: `workers/src/jobs/kb-sync/lib/chunking.ts`
- Create: `workers/src/jobs/kb-sync/lib/embedding.ts`
- Create: `workers/src/jobs/kb-sync/lib/parsing.ts`
- Create: `workers/src/jobs/kb-sync/lib/vector-store.ts`

- [ ] **Step 1: Create workers/src/jobs/kb-sync/types.ts**

Extract the type definitions from `lambda/kb_sync_processor/src/index.ts` lines 49–95:

```typescript
export type JobType = 'file-upload' | 's3-sync' | 'confluence-sync' | 'bitbucket-sync';

export interface BaseJob {
  type: JobType;
  kbId: string;
  dsId: string;
  oldVectorKeys?: string[];
}

export interface FileUploadJob extends BaseJob {
  type: 'file-upload';
  stagingKey: string;
  fileName: string;
  mimeType: string;
}

export interface S3SyncJob extends BaseJob {
  type: 's3-sync';
  config: { bucketName: string; prefix?: string; filePatterns?: string[]; region?: string };
}

export interface ConfluenceSyncJob extends BaseJob {
  type: 'confluence-sync';
  config: {
    spaceKey: string;
    pageIds?: string[];
    baseUrl: string;
    email?: string;
    apiToken?: string;
  };
}

export interface BitbucketSyncJob extends BaseJob {
  type: 'bitbucket-sync';
  config: {
    workspace: string;
    project?: string;
    repoSlug?: string;
    branch?: string;
    paths?: string[];
    apiToken: string;
    email: string;
    baseUrl?: string;
  };
}

export type KBSyncJob = FileUploadJob | S3SyncJob | ConfluenceSyncJob | BitbucketSyncJob;
```

- [ ] **Step 2: Create workers/src/jobs/kb-sync/lib/chunking.ts**

Extract the chunking functions from `lambda/kb_sync_processor/src/index.ts` lines 101–145:

```typescript
import { createHash } from 'crypto';

const CHUNK_SIZE = 1500;
const CHUNK_OVERLAP = 200;

export interface Chunk {
  text: string;
  index: number;
  total: number;
  contentHash: string;
}

export function chunkText(text: string, docName: string): Chunk[] {
  const seps = ['\n\n', '\n', '. ', ' '];
  const raw = recursiveSplit(text, CHUNK_SIZE, seps);
  const total = raw.length;
  return raw.map((t, i) => ({
    text: `Document: ${docName} | Chunk ${i + 1}/${total}\n\n${t}`,
    index: i,
    total,
    contentHash: createHash('sha256').update(t).digest('hex').slice(0, 16),
  }));
}

function recursiveSplit(text: string, max: number, seps: string[]): string[] {
  if (text.length <= max) return text.trim() ? [text] : [];
  const sep = seps.find((s) => text.includes(s));
  if (!sep) return forceChunk(text, max);
  const parts: string[] = [];
  let buf = '';
  for (const part of text.split(sep)) {
    const candidate = buf ? buf + sep + part : part;
    if (candidate.length <= max) {
      buf = candidate;
    } else {
      if (buf) parts.push(buf);
      buf = part.length > max ? '' : part;
      if (part.length > max) parts.push(...recursiveSplit(part, max, seps.slice(1)));
    }
  }
  if (buf) parts.push(buf);
  const result: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const prev = i > 0 ? parts[i - 1].slice(-CHUNK_OVERLAP) : '';
    result.push((prev + parts[i]).slice(0, max));
  }
  return result.filter((s) => s.trim());
}

function forceChunk(text: string, max: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += max - CHUNK_OVERLAP) {
    chunks.push(text.slice(i, i + max));
  }
  return chunks;
}
```

- [ ] **Step 3: Create workers/src/jobs/kb-sync/lib/embedding.ts**

Extract embedding + vector store logic from `lambda/kb_sync_processor/src/index.ts` lines 164–214:

```typescript
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { S3VectorsClient, PutVectorsCommand, DeleteVectorsCommand } from '@aws-sdk/client-s3vectors';
import type { Chunk } from './chunking.js';

const region = process.env.AWS_REGION || 'ap-south-1';
const bedrock = new BedrockRuntimeClient({ region });
const s3vectors = new S3VectorsClient({ region });

const KB_VECTOR_BUCKET = process.env.KB_VECTOR_BUCKET_NAME!;
const KB_VECTOR_INDEX = process.env.KB_VECTOR_INDEX_NAME!;
const BEDROCK_MODEL = process.env.BEDROCK_MODEL_ID || 'amazon.titan-embed-text-v2:0';

const EMBEDDING_CONCURRENCY = 5;
const VECTOR_BATCH_SIZE = 20;

export async function getEmbedding(text: string): Promise<number[]> {
  const res = await bedrock.send(new InvokeModelCommand({
    modelId: BEDROCK_MODEL,
    body: JSON.stringify({ inputText: text.slice(0, 8000) }),
    contentType: 'application/json',
    accept: 'application/json',
  }));
  return JSON.parse(new TextDecoder().decode(res.body)).embedding;
}

export async function embedAndStore(params: {
  chunks: Chunk[];
  kbId: string;
  dsId: string;
  sourceType: string;
  docName: string;
  docId?: string;
  extra?: Record<string, string>;
}): Promise<string[]> {
  const { chunks, kbId, dsId, sourceType, docName, docId = '', extra = {} } = params;
  const keys: string[] = [];

  for (let i = 0; i < chunks.length; i += EMBEDDING_CONCURRENCY) {
    const batch = chunks.slice(i, i + EMBEDDING_CONCURRENCY);
    const embeddings = await Promise.all(batch.map((c) => getEmbedding(c.text)));

    const vectors = batch.map((chunk, j) => ({
      key: `kb_${kbId}_${dsId}_${docId}_${chunk.index}_${chunk.contentHash}`,
      data: { float32: embeddings[j] },
      metadata: {
        knowledgeBaseId: kbId,
        dataSourceId: dsId,
        sourceType,
        documentName: docName,
        chunkIndex: String(chunk.index),
        totalChunks: String(chunk.total),
        contentHash: chunk.contentHash,
        text_content: chunk.text.slice(0, 500),
        ...extra,
      },
    }));

    for (let b = 0; b < vectors.length; b += VECTOR_BATCH_SIZE) {
      await s3vectors.send(new PutVectorsCommand({
        vectorBucketName: KB_VECTOR_BUCKET,
        indexName: KB_VECTOR_INDEX,
        vectors: vectors.slice(b, b + VECTOR_BATCH_SIZE) as any,
      }));
    }
    keys.push(...vectors.map((v) => v.key));
  }
  return keys;
}

export async function deleteOldVectors(keys: string[]): Promise<void> {
  if (!keys?.length) return;
  for (let i = 0; i < keys.length; i += 500) {
    await s3vectors.send(new DeleteVectorsCommand({
      vectorBucketName: KB_VECTOR_BUCKET,
      indexName: KB_VECTOR_INDEX,
      keys: keys.slice(i, i + 500),
    }));
  }
}
```

- [ ] **Step 4: Create workers/src/jobs/kb-sync/lib/parsing.ts**

Extract from `lambda/kb_sync_processor/src/index.ts` lines 151–159:

```typescript
export async function parseContent(buffer: Buffer, mimeType: string, fileName: string): Promise<string> {
  if (mimeType === 'application/pdf' || fileName.endsWith('.pdf')) {
    const pdfParse = (await import('pdf-parse')).default;
    const data = await pdfParse(buffer);
    return data.text;
  }
  return buffer.toString('utf-8');
}

const SUPPORTED_EXT = new Set(['pdf', 'md', 'txt', 'json', 'csv', 'yaml', 'yml']);

export function isSupportedKey(key: string): boolean {
  return SUPPORTED_EXT.has(key.split('.').pop()?.toLowerCase() ?? '');
}

export function getMime(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  return ext === 'pdf' ? 'application/pdf' : ext === 'json' ? 'application/json' : 'text/plain';
}
```

- [ ] **Step 5: Create workers/src/jobs/kb-sync/lib/vector-store.ts**

Extract DynamoDB + PostgreSQL helpers from `lambda/kb_sync_processor/src/index.ts` lines 220–318:

```typescript
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { PrismaClient } from '@prisma/client';

const region = process.env.AWS_REGION || 'ap-south-1';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

const APP_TABLE = process.env.APP_TABLE_NAME!;
const USE_PG_KB = process.env.USE_PG_KB === 'true';
const DEFAULT_TENANT = process.env.DEFAULT_TENANT_ID || 'org-default';

let _prisma: PrismaClient | null = null;
function getPrisma(): PrismaClient {
  if (!_prisma) {
    _prisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
      log: ['warn', 'error'],
    });
  }
  return _prisma;
}

function kbPK(kbId: string) { return `KB#${kbId}`; }
function dsSK(dsId: string) { return `DATASOURCE#${dsId}`; }
function tenantPK(tenantId: string) { return `TENANT#${tenantId}`; }
function kbSK(kbId: string) { return `KB#${kbId}`; }

export async function getDataSource(kbId: string, dsId: string) {
  if (USE_PG_KB) return getDataSourcePg(kbId, dsId);
  const res = await ddb.send(new GetCommand({ TableName: APP_TABLE, Key: { pk: kbPK(kbId), sk: dsSK(dsId) } }));
  return res.Item;
}

export async function updateDS(kbId: string, dsId: string, updates: Record<string, unknown>) {
  if (USE_PG_KB) await updateDSPg(kbId, dsId, updates);
  // DynamoDB dual-write
  const parts = ['#updatedAt = :updatedAt'];
  const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
  const vals: Record<string, unknown> = { ':updatedAt': new Date().toISOString() };
  for (const [k, v] of Object.entries(updates)) {
    parts.push(`#${k} = :${k}`);
    names[`#${k}`] = k;
    vals[`:${k}`] = v;
  }
  await ddb.send(new UpdateCommand({
    TableName: APP_TABLE,
    Key: { pk: kbPK(kbId), sk: dsSK(dsId) },
    UpdateExpression: `SET ${parts.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: vals,
  }));
}

export async function updateKBVectorCount(kbId: string, delta: number) {
  if (delta === 0) return;
  if (USE_PG_KB) await updateKBVectorCountPg(kbId, delta);
  // DynamoDB dual-write
  await ddb.send(new UpdateCommand({
    TableName: APP_TABLE,
    Key: { pk: tenantPK(DEFAULT_TENANT), sk: kbSK(kbId) },
    UpdateExpression: 'SET vectorCount = if_not_exists(vectorCount, :zero) + :delta, updatedAt = :now',
    ExpressionAttributeValues: { ':delta': delta, ':zero': 0, ':now': new Date().toISOString() },
  }));
}

// --- PostgreSQL helpers ---

async function getDataSourcePg(kbId: string, dsId: string) {
  const ds = await getPrisma().dataSource.findFirst({
    where: { id: dsId, knowledgeBaseId: kbId },
  });
  return ds ? { vectorCount: ds.vectorCount, vectorKeys: ds.vectorKeys, status: ds.status } : null;
}

async function updateDSPg(kbId: string, dsId: string, updates: Record<string, unknown>) {
  await getPrisma().dataSource.updateMany({
    where: { id: dsId, knowledgeBaseId: kbId },
    data: {
      ...(updates.status !== undefined ? { status: updates.status as string } : {}),
      ...(updates.vectorCount !== undefined ? { vectorCount: updates.vectorCount as number } : {}),
      ...(updates.vectorKeys !== undefined ? { vectorKeys: { set: updates.vectorKeys as string[] } } : {}),
      ...(updates.lastSyncAt !== undefined ? { lastSyncAt: updates.lastSyncAt ? new Date(updates.lastSyncAt as string) : null } : {}),
      ...(updates.lastSyncError !== undefined ? { lastSyncError: updates.lastSyncError as string | null } : {}),
      updatedAt: new Date(),
    },
  });
}

async function updateKBVectorCountPg(kbId: string, delta: number) {
  if (delta === 0) return;
  await getPrisma().knowledgeBase.updateMany({
    where: { id: kbId },
    data: { vectorCount: { increment: delta }, updatedAt: new Date() },
  });
}
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `cd workers && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add workers/src/jobs/kb-sync/
git commit -m "feat(workers): extract KB sync types and shared libs from Lambda"
```

---

### Task 7: Create KB sync handlers

**Files:**
- Create: `workers/src/jobs/kb-sync/handlers/file-upload.ts`
- Create: `workers/src/jobs/kb-sync/handlers/s3-sync.ts`
- Create: `workers/src/jobs/kb-sync/handlers/confluence-sync.ts`
- Create: `workers/src/jobs/kb-sync/handlers/bitbucket-sync.ts`

- [ ] **Step 1: Create workers/src/jobs/kb-sync/handlers/file-upload.ts**

Extract from `lambda/kb_sync_processor/src/index.ts` lines 325–333:

```typescript
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { parseContent } from '../lib/parsing.js';
import { chunkText } from '../lib/chunking.js';
import { embedAndStore } from '../lib/embedding.js';
import type { FileUploadJob } from '../types.js';

const region = process.env.AWS_REGION || 'ap-south-1';
const s3 = new S3Client({ region });
const STAGING_BUCKET = process.env.KB_STAGING_BUCKET_NAME!;

export async function handleFileUpload(job: FileUploadJob): Promise<string[]> {
  const res = await s3.send(new GetObjectCommand({ Bucket: STAGING_BUCKET, Key: job.stagingKey }));
  const chunks: Uint8Array[] = [];
  for await (const c of res.Body as AsyncIterable<Uint8Array>) chunks.push(c);
  const buffer = Buffer.concat(chunks);
  const text = await parseContent(buffer, job.mimeType, job.fileName);
  const kbChunks = chunkText(text, job.fileName);
  return embedAndStore({ chunks: kbChunks, kbId: job.kbId, dsId: job.dsId, sourceType: 'file-upload', docName: job.fileName });
}
```

- [ ] **Step 2: Create workers/src/jobs/kb-sync/handlers/s3-sync.ts**

Extract from `lambda/kb_sync_processor/src/index.ts` lines 342–365:

```typescript
import { S3Client, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { parseContent, isSupportedKey, getMime } from '../lib/parsing.js';
import { chunkText } from '../lib/chunking.js';
import { embedAndStore } from '../lib/embedding.js';
import type { S3SyncJob } from '../types.js';

const region = process.env.AWS_REGION || 'ap-south-1';
const MAX_FILES = 50;

export async function handleS3Sync(job: S3SyncJob): Promise<string[]> {
  const srcS3 = new S3Client({ region: job.config.region || region });
  const list = await srcS3.send(new ListObjectsV2Command({ Bucket: job.config.bucketName, Prefix: job.config.prefix, MaxKeys: MAX_FILES }));
  let objects = (list.Contents || []).filter((o) => o.Key && isSupportedKey(o.Key));
  if (job.config.filePatterns?.length) {
    objects = objects.filter((o) => job.config.filePatterns!.some((p) => o.Key!.includes(p.replace(/\*/g, ''))));
  }
  const allKeys: string[] = [];
  for (const obj of objects.slice(0, MAX_FILES)) {
    try {
      const get = await srcS3.send(new GetObjectCommand({ Bucket: job.config.bucketName, Key: obj.Key! }));
      const chunks: Uint8Array[] = [];
      for await (const c of get.Body as AsyncIterable<Uint8Array>) chunks.push(c);
      const buf = Buffer.concat(chunks);
      const fileName = obj.Key!.split('/').pop() || obj.Key!;
      const text = await parseContent(buf, getMime(obj.Key!), fileName);
      const kbChunks = chunkText(text, fileName);
      const keys = await embedAndStore({ chunks: kbChunks, kbId: job.kbId, dsId: job.dsId, sourceType: 's3-bucket', docName: fileName, extra: { s3Key: obj.Key! } });
      allKeys.push(...keys);
    } catch (e) { console.error(`[kb-sync] S3 skip ${obj.Key}:`, e); }
  }
  return allKeys;
}
```

- [ ] **Step 3: Create workers/src/jobs/kb-sync/handlers/confluence-sync.ts**

Extract from `lambda/kb_sync_processor/src/index.ts` lines 367–462. This includes `fetchConfluencePage`, `collectPageTree`, `fetchAllSpacePages`, and `handleConfluenceSync`:

```typescript
import { chunkText } from '../lib/chunking.js';
import { embedAndStore } from '../lib/embedding.js';
import type { ConfluenceSyncJob } from '../types.js';

const BLOCKED = [/^https?:\/\/localhost/i, /^https?:\/\/127\./, /^https?:\/\/10\./, /^https?:\/\/172\.(1[6-9]|2\d|3[01])\./, /^https?:\/\/192\.168\./, /^https?:\/\/169\.254\./];
function guardUrl(url: string) {
  if (!url.startsWith('http')) throw new Error(`Invalid URL: ${url}`);
  for (const p of BLOCKED) if (p.test(url)) throw new Error(`Blocked private URL: ${url}`);
}

async function fetchConfluencePage(
  base: string, headers: Record<string, string>, pageId: string,
): Promise<{ id: string; title: string; body: string } | null> {
  const r = await fetch(`${base}/rest/api/content/${pageId}?expand=body.view.value`, { headers });
  if (!r.ok) return null;
  const d = await r.json() as any;
  return { id: d.id, title: d.title, body: d.body?.view?.value || '' };
}

async function collectPageTree(
  base: string, headers: Record<string, string>, pageId: string, visited = new Set<string>(),
): Promise<Array<{ id: string; title: string; body: string }>> {
  if (visited.has(pageId)) return [];
  visited.add(pageId);
  const page = await fetchConfluencePage(base, headers, pageId);
  const results: Array<{ id: string; title: string; body: string }> = page ? [page] : [];
  let start = 0;
  while (true) {
    const r = await fetch(`${base}/rest/api/content/${pageId}/child/page?limit=50&start=${start}`, { headers });
    if (!r.ok) break;
    const d = await r.json() as any;
    const children: Array<{ id: string }> = d.results || [];
    if (!children.length) break;
    for (const child of children) {
      results.push(...await collectPageTree(base, headers, child.id, visited));
    }
    if (!d._links?.next) break;
    start += children.length;
  }
  return results;
}

async function fetchAllSpacePages(
  base: string, headers: Record<string, string>, spaceKey: string,
): Promise<Array<{ id: string; title: string; body: string }>> {
  const pages: Array<{ id: string; title: string; body: string }> = [];
  let start = 0;
  while (true) {
    const r = await fetch(`${base}/rest/api/content?spaceKey=${encodeURIComponent(spaceKey)}&expand=body.view.value&limit=50&start=${start}`, { headers });
    if (!r.ok) break;
    const d = await r.json() as any;
    const results: Array<{ id: string; title: string; body?: { view?: { value?: string } } }> = d.results || [];
    if (!results.length) break;
    pages.push(...results.map((p) => ({ id: p.id, title: p.title, body: p.body?.view?.value || '' })));
    if (!d._links?.next) break;
    start += results.length;
  }
  return pages;
}

export async function handleConfluenceSync(job: ConfluenceSyncJob): Promise<string[]> {
  const { baseUrl, spaceKey, pageIds, email, apiToken } = job.config;
  guardUrl(baseUrl);
  const base = baseUrl.replace(/\/$/, '');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (email && apiToken) headers['Authorization'] = `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;

  let pages: Array<{ id: string; title: string; body: string }>;
  if (pageIds?.length) {
    const visited = new Set<string>();
    const allPages: Array<{ id: string; title: string; body: string }> = [];
    for (const pid of pageIds) {
      const tree = await collectPageTree(base, headers, pid, visited);
      allPages.push(...tree);
    }
    pages = allPages;
  } else {
    pages = await fetchAllSpacePages(base, headers, spaceKey);
  }

  const seen = new Set<string>();
  pages = pages.filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  console.log(`[kb-sync] Confluence: ${pages.length} pages to ingest`);

  const allKeys: string[] = [];
  for (const page of pages) {
    const text = page.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const keys = await embedAndStore({ chunks: chunkText(text, page.title), kbId: job.kbId, dsId: job.dsId, sourceType: 'confluence', docName: page.title, docId: page.id, extra: { confluencePageId: page.id } });
    allKeys.push(...keys);
  }
  return allKeys;
}
```

- [ ] **Step 4: Create workers/src/jobs/kb-sync/handlers/bitbucket-sync.ts**

Extract from `lambda/kb_sync_processor/src/index.ts` lines 468–553. This includes `bbResolveBranch`, `bbListRepoFiles`, `bbListWorkspaceRepos`, `bbScrapeRepo`, and `handleBitbucketSync`:

```typescript
import { parseContent, isSupportedKey, getMime } from '../lib/parsing.js';
import { chunkText } from '../lib/chunking.js';
import { embedAndStore } from '../lib/embedding.js';
import type { BitbucketSyncJob } from '../types.js';

const MAX_FILES = 50;

const BLOCKED = [/^https?:\/\/localhost/i, /^https?:\/\/127\./, /^https?:\/\/10\./, /^https?:\/\/172\.(1[6-9]|2\d|3[01])\./, /^https?:\/\/192\.168\./, /^https?:\/\/169\.254\./];
function guardUrl(url: string) {
  if (!url.startsWith('http')) throw new Error(`Invalid URL: ${url}`);
  for (const p of BLOCKED) if (p.test(url)) throw new Error(`Blocked private URL: ${url}`);
}

async function bbResolveBranch(apiBase: string, auth: string, workspace: string, repoSlug: string, preferred?: string): Promise<string> {
  if (preferred) return preferred;
  for (const b of ['main', 'master']) {
    const r = await fetch(`${apiBase}/2.0/repositories/${workspace}/${repoSlug}/refs/branches/${b}`, { headers: { Authorization: auth } });
    if (r.ok) return b;
  }
  const r = await fetch(`${apiBase}/2.0/repositories/${workspace}/${repoSlug}`, { headers: { Authorization: auth } });
  if (r.ok) {
    const d = await r.json() as any;
    return d.mainbranch?.name || 'main';
  }
  return 'main';
}

async function bbListRepoFiles(apiBase: string, auth: string, workspace: string, repoSlug: string, branch: string): Promise<string[]> {
  const files: string[] = [];
  let url: string | null = `${apiBase}/2.0/repositories/${workspace}/${repoSlug}/src/${branch}/?pagelen=100&max_depth=10`;
  while (url && files.length < MAX_FILES) {
    const r = await fetch(url, { headers: { Accept: 'application/json', Authorization: auth } });
    if (!r.ok) break;
    const d = await r.json() as any;
    for (const v of (d.values || [])) {
      if (v.type === 'commit_file' && isSupportedKey(v.path)) files.push(v.path);
    }
    url = d.next || null;
  }
  return files.slice(0, MAX_FILES);
}

async function bbListWorkspaceRepos(apiBase: string, auth: string, workspace: string, project?: string): Promise<string[]> {
  const slugs: string[] = [];
  const q = project ? `&q=project.key="${encodeURIComponent(project)}"` : '';
  let url: string | null = `${apiBase}/2.0/repositories/${workspace}?pagelen=50${q}`;
  while (url) {
    const r = await fetch(url, { headers: { Accept: 'application/json', Authorization: auth } });
    if (!r.ok) break;
    const d = await r.json() as any;
    for (const repo of (d.values || [])) slugs.push(repo.slug);
    url = d.next || null;
  }
  return slugs;
}

async function bbScrapeRepo(
  apiBase: string, auth: string, workspace: string, repoSlug: string,
  branch: string | undefined, paths: string[] | undefined,
  job: BitbucketSyncJob,
): Promise<string[]> {
  const resolvedBranch = await bbResolveBranch(apiBase, auth, workspace, repoSlug, branch);
  const filePaths = paths?.length ? paths.slice(0, MAX_FILES) : await bbListRepoFiles(apiBase, auth, workspace, repoSlug, resolvedBranch);
  const allKeys: string[] = [];
  for (const fp of filePaths) {
    try {
      const clean = fp.replace(/^\//, '');
      const r = await fetch(`${apiBase}/2.0/repositories/${workspace}/${repoSlug}/src/${resolvedBranch}/${clean}`, { headers: { Authorization: auth } });
      if (!r.ok) continue;
      const content = await r.text();
      const fileName = clean.split('/').pop() || clean;
      const text = await parseContent(Buffer.from(content, 'utf-8'), getMime(fileName), fileName);
      const keys = await embedAndStore({ chunks: chunkText(text, fileName), kbId: job.kbId, dsId: job.dsId, sourceType: 'bitbucket', docName: fileName, extra: { bitbucketRepo: `${workspace}/${repoSlug}`, bitbucketPath: clean } });
      allKeys.push(...keys);
    } catch (e) { console.error(`[kb-sync] BB skip ${fp}:`, e); }
  }
  return allKeys;
}

export async function handleBitbucketSync(job: BitbucketSyncJob): Promise<string[]> {
  const { workspace, project, repoSlug, branch, paths, apiToken, email, baseUrl } = job.config;
  const apiBase = (baseUrl || 'https://api.bitbucket.org').replace(/\/$/, '');
  guardUrl(apiBase);
  const auth = 'Basic ' + Buffer.from(`${email}:${apiToken}`).toString('base64');

  const repos = repoSlug ? [repoSlug] : await bbListWorkspaceRepos(apiBase, auth, workspace, project);
  console.log(`[kb-sync] Bitbucket: ${repos.length} repo(s) to scrape in workspace=${workspace}`);

  const allKeys: string[] = [];
  for (const slug of repos) {
    const keys = await bbScrapeRepo(apiBase, auth, workspace, slug, branch, paths, job);
    allKeys.push(...keys);
  }
  return allKeys;
}
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd workers && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add workers/src/jobs/kb-sync/handlers/
git commit -m "feat(workers): add KB sync handlers (file-upload, s3, confluence, bitbucket)"
```

---

### Task 8: Create KB sync job registration and handler

**Files:**
- Create: `workers/src/jobs/kb-sync/index.ts`
- Create: `workers/src/jobs/kb-sync/index.test.ts`

- [ ] **Step 1: Write the failing test for KB sync job registration**

Create `workers/src/jobs/kb-sync/index.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockWork = vi.fn();

const mockBoss = {
  work: mockWork,
  send: vi.fn(),
  schedule: vi.fn(),
} as any;

vi.mock('./handlers/file-upload.js', () => ({ handleFileUpload: vi.fn().mockResolvedValue(['key1']) }));
vi.mock('./handlers/s3-sync.js', () => ({ handleS3Sync: vi.fn().mockResolvedValue(['key2']) }));
vi.mock('./handlers/confluence-sync.js', () => ({ handleConfluenceSync: vi.fn().mockResolvedValue(['key3']) }));
vi.mock('./handlers/bitbucket-sync.js', () => ({ handleBitbucketSync: vi.fn().mockResolvedValue(['key4']) }));
vi.mock('./lib/vector-store.js', () => ({
  getDataSource: vi.fn().mockResolvedValue({ vectorCount: 0, vectorKeys: [], status: 'synced' }),
  updateDS: vi.fn().mockResolvedValue(undefined),
  updateKBVectorCount: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./lib/embedding.js', () => ({
  deleteOldVectors: vi.fn().mockResolvedValue(undefined),
  embedAndStore: vi.fn().mockResolvedValue([]),
  getEmbedding: vi.fn().mockResolvedValue([]),
}));

import { register } from './index.js';

describe('kb-sync job registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should register kb-sync worker with teamSize 3', async () => {
    await register(mockBoss);

    expect(mockWork).toHaveBeenCalledWith(
      'kb-sync',
      expect.objectContaining({ teamSize: 3 }),
      expect.any(Function),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workers && npx vitest run src/jobs/kb-sync/index.test.ts`
Expected: FAIL — `Cannot find module './index.js'`

- [ ] **Step 3: Create workers/src/jobs/kb-sync/index.ts**

```typescript
import type PgBoss from 'pg-boss';
import { handleFileUpload } from './handlers/file-upload.js';
import { handleS3Sync } from './handlers/s3-sync.js';
import { handleConfluenceSync } from './handlers/confluence-sync.js';
import { handleBitbucketSync } from './handlers/bitbucket-sync.js';
import { getDataSource, updateDS, updateKBVectorCount } from './lib/vector-store.js';
import { deleteOldVectors } from './lib/embedding.js';
import type { KBSyncJob } from './types.js';

export async function register(boss: PgBoss): Promise<void> {
  // teamSize: 3 — max 3 concurrent KB jobs to avoid Bedrock rate limiting
  await boss.work<KBSyncJob>(
    'kb-sync',
    { teamSize: 3, teamConcurrency: 3 },
    async (job) => {
      const { kbId, dsId } = job.data;

      console.log(`[kb-sync] Processing ${job.data.type} for KB=${kbId} DS=${dsId}`);

      const ds = await getDataSource(kbId, dsId);
      const oldVectorCount = (ds?.vectorCount as number) || 0;
      const oldVectorKeys: string[] = job.data.oldVectorKeys || (ds?.vectorKeys as string[]) || [];

      try {
        // Delete old vectors
        if (oldVectorKeys.length) {
          await deleteOldVectors(oldVectorKeys);
          await updateKBVectorCount(kbId, -oldVectorCount);
        }

        let vectorKeys: string[];
        switch (job.data.type) {
          case 'file-upload':    vectorKeys = await handleFileUpload(job.data); break;
          case 's3-sync':        vectorKeys = await handleS3Sync(job.data); break;
          case 'confluence-sync': vectorKeys = await handleConfluenceSync(job.data); break;
          case 'bitbucket-sync': vectorKeys = await handleBitbucketSync(job.data); break;
          default: throw new Error(`Unknown job type: ${(job.data as KBSyncJob).type}`);
        }

        await updateDS(kbId, dsId, {
          status: 'synced',
          vectorCount: vectorKeys.length,
          vectorKeys,
          lastSyncAt: new Date().toISOString(),
          lastSyncError: null,
        });
        await updateKBVectorCount(kbId, vectorKeys.length);

        console.log(`[kb-sync] Done ${job.data.type} KB=${kbId} DS=${dsId} vectors=${vectorKeys.length}`);
      } catch (err) {
        console.error(`[kb-sync] Error ${job.data.type} KB=${kbId} DS=${dsId}:`, err);
        try {
          await updateDS(kbId, dsId, {
            status: 'error',
            lastSyncError: err instanceof Error ? err.message : 'Sync failed',
          });
        } catch (e) {
          console.error('[kb-sync] Error update failed:', e);
        }
        throw err; // Re-throw so pg-boss retries
      }
    },
  );

  console.log('[kb-sync] Registered kb-sync job');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd workers && npx vitest run src/jobs/kb-sync/index.test.ts`
Expected: PASS

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd workers && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add workers/src/jobs/kb-sync/index.ts workers/src/jobs/kb-sync/index.test.ts
git commit -m "feat(workers): add KB sync job registration with pg-boss"
```

---

### Task 9: Wire entry point to register all jobs

**Files:**
- Modify: `workers/src/index.ts`

- [ ] **Step 1: Update workers/src/index.ts to register both job types**

Replace the contents of `workers/src/index.ts` with:

```typescript
import { createBoss } from './boss.js';
import { register as registerSchedulerJobs } from './jobs/scheduler/index.js';
import { register as registerKbSyncJobs } from './jobs/kb-sync/index.js';

const boss = createBoss();

async function main() {
  console.log('[workers] Starting pg-boss...');

  boss.on('error', (error) => {
    console.error('[workers] pg-boss error:', error);
  });

  await boss.start();
  console.log('[workers] pg-boss started');

  await registerSchedulerJobs(boss);
  await registerKbSyncJobs(boss);

  console.log('[workers] All jobs registered. Waiting for work...');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`[workers] Received ${signal}, shutting down...`);
    await boss.stop({ graceful: true, timeout: 30000 });
    console.log('[workers] pg-boss stopped');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[workers] Fatal error:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd workers && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add workers/src/index.ts
git commit -m "feat(workers): wire entry point to register scheduler + kb-sync jobs"
```

---

### Task 10: Create web-ui boss client and update API routes

**Files:**
- Create: `web-ui/lib/boss-client.ts`
- Modify: `web-ui/app/api/knowledge-base/[kbId]/sources/[dsId]/sync/route.ts`
- Modify: `web-ui/app/api/scheduler/execute/route.ts`
- Modify: `web-ui/app/api/schedules/[scheduleId]/execute/route.ts`

- [ ] **Step 1: Create web-ui/lib/boss-client.ts**

```typescript
import PgBoss from 'pg-boss';

let _boss: PgBoss | null = null;

/**
 * Singleton pg-boss client for the web-ui (producer-only mode).
 * Connects lazily on first use. No workers registered here —
 * the workers container handles all job processing.
 */
export async function getBoss(): Promise<PgBoss> {
  if (_boss) return _boss;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for pg-boss');
  }

  _boss = new PgBoss({
    connectionString: databaseUrl,
    // Producer-only: no monitoring, no maintenance
    noScheduling: true,
    noSupervisor: true,
  });

  await _boss.start();
  return _boss;
}
```

- [ ] **Step 2: Install pg-boss in web-ui**

Run: `cd web-ui && npm install pg-boss@^10.1.5`
Expected: pg-boss added to web-ui/package.json dependencies

- [ ] **Step 3: Update KB sync route — replace SQS with boss.send()**

Replace the contents of `web-ui/app/api/knowledge-base/[kbId]/sources/[dsId]/sync/route.ts` with:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { KnowledgeBaseService } from '@/lib/knowledge-base/service';
import { getSessionTenantId } from '@/lib/auth-session';
import { getBoss } from '@/lib/boss-client';
import type { S3BucketConfig, ConfluenceConfig, BitbucketConfig } from '@/lib/knowledge-base/types';

const JOB_TYPE_MAP = {
  's3-bucket': 's3-sync',
  'confluence': 'confluence-sync',
  'bitbucket': 'bitbucket-sync',
} as const;

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ kbId: string; dsId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { kbId, dsId } = await params;
  const tenantId = await getSessionTenantId();
  const kb = await KnowledgeBaseService.getKnowledgeBase(kbId, tenantId);
  if (!kb) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });

  const ds = await KnowledgeBaseService.getDataSource(kbId, dsId, tenantId);
  if (!ds) return NextResponse.json({ error: 'Data source not found' }, { status: 404 });
  if (ds.sourceType === 'file-upload') return NextResponse.json({ error: 'Re-sync not supported for file uploads' }, { status: 400 });

  const jobType = JOB_TYPE_MAP[ds.sourceType as keyof typeof JOB_TYPE_MAP];
  if (!jobType) return NextResponse.json({ error: `Unsupported source type: ${ds.sourceType}` }, { status: 400 });

  // Mark as syncing immediately
  await KnowledgeBaseService.updateDataSource(kbId, dsId, { status: 'syncing' }, tenantId);

  // Enqueue background job via pg-boss
  const boss = await getBoss();
  await boss.send('kb-sync', {
    type: jobType,
    kbId,
    dsId,
    oldVectorKeys: ds.vectorKeys,
    config: ds.config as S3BucketConfig | ConfluenceConfig | BitbucketConfig,
  });

  return NextResponse.json({ success: true, status: 'syncing' }, { status: 202 });
}
```

- [ ] **Step 4: Update scheduler full-scan route — replace Lambda invoke with boss.send()**

Replace the contents of `web-ui/app/api/scheduler/execute/route.ts` with:

```typescript
import { NextResponse } from "next/server";
import { AuditService } from "@/lib/audit-service";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth-options";
import { authorize } from "@/lib/rbac/authorize";
import { getSessionTenantId } from "@/lib/auth-session";
import { getBoss } from "@/lib/boss-client";

export async function POST() {
    const authError = await authorize('execute', 'Schedule');
    if (authError) return authError;

    try {
        console.log(`[API] Execute Now (Full Scan) triggered`);

        const session = await getServerSession(authOptions);
        const userEmail = session?.user?.email;
        const tenantId = await getSessionTenantId();
        const executionTime = new Date().toISOString();

        try {
            const boss = await getBoss();
            await boss.send('scheduler-scan', {
                triggeredBy: 'web-ui',
                userEmail: userEmail || 'unknown-web-user',
            });
        } catch (sendError) {
            console.error(`[API] pg-boss send failed:`, sendError);
            const errorMessage = sendError instanceof Error ? sendError.message : String(sendError);

            await AuditService.logUserAction({
                action: "Execute Full Scan",
                resourceType: "scheduler",
                resourceId: "full-scan",
                resourceName: "Scheduler Full Scan",
                status: 'error',
                details: `Manual full scan triggering failed: ${errorMessage}`,
                user: userEmail || "unknown-web-user",
                userType: "user",
                tenantId,
            });

            return NextResponse.json(
                { success: false, error: errorMessage, message: "Failed to enqueue job" },
                { status: 500 }
            );
        }

        await AuditService.logUserAction({
            action: "Execute Full Scan",
            resourceType: "scheduler",
            resourceId: "full-scan",
            resourceName: "Scheduler Full Scan",
            status: 'success',
            details: `Manual full scan triggered via Dashboard. Job enqueued.`,
            user: userEmail || "unknown-web-user",
            userType: "user",
            tenantId,
        });

        return NextResponse.json({
            success: true,
            message: "Full scan execution triggered successfully (Background)",
            executionTime,
            executionStatus: 'success',
            isAsync: true
        });

    } catch (error) {
        console.error("[API] Error executing full scan:", error);
        const errorMessage = error instanceof Error ? error.message : "Failed to execute full scan";
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}
```

- [ ] **Step 5: Update scheduler partial-scan route — replace Lambda invoke with boss.send()**

Replace the contents of `web-ui/app/api/schedules/[scheduleId]/execute/route.ts` with:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { ScheduleService } from "@/lib/schedule-service";
import { AuditService } from "@/lib/audit-service";
import { ScheduleExecutionService } from "@/lib/schedule-execution-service";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth-options";
import { authorize } from "@/lib/rbac/authorize";
import { getSessionTenantId } from "@/lib/auth-session";
import { getBoss } from "@/lib/boss-client";

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ scheduleId: string }> }
) {
    const authError = await authorize('execute', 'Schedule');
    if (authError) return authError;

    try {
        const { scheduleId } = await params;
        const tenantId = await getSessionTenantId();
        console.log(`[API] Execute Now triggered for schedule ${scheduleId}`);

        if (!scheduleId) {
            return NextResponse.json({ error: "Schedule ID is required" }, { status: 400 });
        }

        const schedule = await ScheduleService.getSchedule(scheduleId, undefined, tenantId);
        if (!schedule) {
            return NextResponse.json({ error: "Schedule not found" }, { status: 404 });
        }

        const session = await getServerSession(authOptions);
        const userEmail = session?.user?.email;
        const executionTime = new Date().toISOString();
        let executionStatus: 'success' | 'failed' = 'success';

        try {
            const boss = await getBoss();
            await boss.send('scheduler-scan', {
                scheduleId: schedule.id,
                scheduleName: schedule.name,
                triggeredBy: 'web-ui',
                userEmail: userEmail || 'unknown-web-user',
                tenantId,
            });
        } catch (sendError) {
            console.error(`[API] pg-boss send failed:`, sendError);
            executionStatus = 'failed';

            try {
                const errorMessage = sendError instanceof Error ? sendError.message : String(sendError);
                await ScheduleExecutionService.logExecution({
                    tenantId,
                    accountId: (schedule.accounts && schedule.accounts[0]) || 'unknown',
                    scheduleId: schedule.id,
                    executionTime,
                    status: 'failed',
                    resourcesStarted: 0,
                    resourcesStopped: 0,
                    resourcesFailed: 0,
                    errorMessage: `Job enqueue failed: ${errorMessage}`,
                    details: { triggeredBy: 'web-ui', error: String(sendError) }
                });
            } catch (logError) {
                console.error(`[API] Failed to log execution:`, logError);
            }
        }

        await ScheduleService.updateSchedule(schedule.id, {
            lastExecution: executionTime,
            executionCount: (schedule.executionCount || 0) + 1,
            active: true
        }, (schedule.accounts && schedule.accounts[0]) || 'unknown', tenantId);

        await AuditService.logResourceAction({
            action: "Execute Schedule",
            resourceType: "schedule",
            resourceId: schedule.id,
            resourceName: schedule.name,
            status: executionStatus === 'failed' ? 'error' : 'success',
            details: `Manual execution triggered via Dashboard. Status: ${executionStatus}`,
            user: userEmail || "unknown-web-user",
            source: "web-ui",
            tenantId,
            metadata: { tenantId },
        });

        return NextResponse.json({
            success: executionStatus !== 'failed',
            message: executionStatus === 'failed'
                ? "Execution failed - job enqueue error"
                : "Schedule execution triggered successfully",
            executionTime,
            executionStatus,
        });

    } catch (error) {
        console.error("[API] Error executing schedule:", error);
        const errorMessage = error instanceof Error ? error.message : "Failed to execute schedule";
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}
```

- [ ] **Step 6: Verify web-ui TypeScript compiles**

Run: `cd web-ui && npx tsc --noEmit`
Expected: No errors (or only pre-existing errors unrelated to this change)

- [ ] **Step 7: Commit**

```bash
git add web-ui/lib/boss-client.ts web-ui/package.json web-ui/package-lock.json
git add web-ui/app/api/knowledge-base/\[kbId\]/sources/\[dsId\]/sync/route.ts
git add web-ui/app/api/scheduler/execute/route.ts
git add web-ui/app/api/schedules/\[scheduleId\]/execute/route.ts
git commit -m "feat(web-ui): replace SQS + Lambda with pg-boss send() in API routes"
```

---

### Task 11: Create workers Dockerfile

**Files:**
- Create: `workers/Dockerfile`

- [ ] **Step 1: Create workers/Dockerfile**

```dockerfile
# Multi-stage Dockerfile for pg-boss workers on ECS Fargate (ARM64)
# Build context: project root (not workers/) — required to include prisma/

FROM public.ecr.aws/docker/library/node:20.9.0-slim AS builder
WORKDIR /app

# Copy package files
COPY workers/package*.json ./

# Install all dependencies for build
RUN npm ci && npm cache clean --force

# Copy source code and prisma schema
COPY workers/ .
COPY prisma/ ./prisma/

# Generate Prisma client
RUN npx prisma@5 generate --schema=./prisma/schema.prisma

# Build TypeScript
RUN npm run build

FROM public.ecr.aws/docker/library/node:20.9.0-slim AS runner
WORKDIR /app

# Install openssl for Prisma
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Download RDS CA bundle for TLS connections
RUN curl -sSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    -o /etc/ssl/certs/rds-combined-ca-bundle.pem 2>/dev/null || true

# Copy package files and install production deps only
COPY workers/package*.json ./
RUN npm ci --only=production --omit=dev && npm cache clean --force

# Copy built output
COPY --from=builder /app/dist ./dist

# Copy Prisma schema + generated client
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

ENV NODE_ENV=production

# Non-root user
USER node

CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Verify Docker build works locally**

Run from project root:
```bash
docker build -f workers/Dockerfile --platform linux/arm64 -t nucleus-workers:test .
```
Expected: Image builds successfully

- [ ] **Step 3: Commit**

```bash
git add workers/Dockerfile
git commit -m "feat(workers): add Dockerfile for ECS Fargate deployment"
```

---

### Task 12: Update Pulumi infra — add workers ECS service, remove Lambda + SQS

**Files:**
- Modify: `infra/compute/index.ts`
- Modify: `infra/compute/package.json`

This is the largest task. It modifies `infra/compute/index.ts` to:
1. Add workers ECR repo, Docker image build, task definition, ECS service, IAM role
2. Remove scheduler Lambda, EventBridge rule, KB sync Lambda, KB sync SQS queue + DLQ
3. Remove `SCHEDULER_LAMBDA_ARN` and `KB_SYNC_QUEUE_URL` from web-ui container env vars

- [ ] **Step 1: Remove KB sync SQS queue + DLQ (lines ~401-415)**

Delete the `kbSyncDlq` and `kbSyncQueue` resource definitions:

```typescript
// DELETE these resources:
// const kbSyncDlq = new aws.sqs.Queue("kb-sync-dlq", { ... });
// const kbSyncQueue = new aws.sqs.Queue("kb-sync-queue", { ... });
```

- [ ] **Step 2: Remove scheduler Lambda section (lines ~636-762)**

Delete the entire `SCHEDULER LAMBDA` section:
- `schedulerLambdaRole` and all its inline policies (`scheduler-lambda-dynamodb-policy`, `scheduler-lambda-sts-policy`, `scheduler-lambda-sns-policy`)
- `buildScheduler` command
- `schedulerLambda` function
- `schedulerRule` EventBridge rule
- `scheduler-trigger-target` EventTarget
- `scheduler-eventbridge-permission` Lambda Permission

- [ ] **Step 3: Remove KB sync processor Lambda section (lines ~924-1078)**

Delete the entire `KB SYNC PROCESSOR LAMBDA` section:
- `kbSyncProcessorRole` and all its inline policies (`kb-sync-processor-kb-staging-policy`, `kb-sync-processor-s3-read-policy`, `kb-sync-processor-dynamodb-policy`, `kb-sync-processor-s3vectors-policy`, `kb-sync-processor-bedrock-policy`, `kb-sync-processor-sqs-policy`)
- `buildKbSyncProcessor` command
- `kbSyncProcessorLambda` function
- `kb-sync-processor-sqs-trigger` EventSourceMapping

- [ ] **Step 4: Remove SQS policy from web-ui ECS task role**

Delete the `ecs-task-sqs-policy` inline policy (lines ~1375-1387) that grants `sqs:SendMessage` on `kbSyncQueue`.

- [ ] **Step 5: Update web-ui container env vars**

In the `webUiTaskDef` container definitions, remove these environment variables:
- `{ name: "SCHEDULER_LAMBDA_ARN", value: schedulerLambdaArnVal }` 
- `{ name: "KB_SYNC_QUEUE_URL", value: kbSyncQueueUrl }`

Also remove `schedulerLambda.arn` and `kbSyncQueue.url` from the `pulumi.all([...])` input array and the destructured parameter list.

- [ ] **Step 6: Add workers ECR repository**

Add after the existing `ecrRepository` definition:

```typescript
// ECR Repository — Workers container images
const workersEcrRepo = new aws.ecr.Repository("workers-ecr-repo", {
    name: "nucleus-cloud-ops-workers",
    imageTagMutability: "MUTABLE",
    forceDelete: false,
});
```

- [ ] **Step 7: Add workers Docker image build**

Add after the `webUiImage` definition:

```typescript
// Workers Docker image — auto-built and pushed to ECR on source change
const workersImage = new awsx.ecr.Image("workers-image", {
    repositoryUrl: workersEcrRepo.repositoryUrl,
    context: repoRoot,
    dockerfile: path.join(repoRoot, "workers/Dockerfile"),
    platform: "linux/arm64",
    args: {
        BUILDX_NO_DEFAULT_ATTESTATIONS: "1",
    },
});
```

- [ ] **Step 8: Add workers CloudWatch Log Group**

```typescript
// Workers CloudWatch Log Group
const workersLogGroup = new aws.cloudwatch.LogGroup("workers-log-group", {
    name: "/ecs/nucleus-cloud-ops-workers",
    retentionInDays: 7,
});
```

- [ ] **Step 9: Add workers ECS Task Role with IAM policies**

```typescript
// Workers Task Role — application permissions
const workersTaskRole = new aws.iam.Role("workers-task-role", {
    name: "nucleus-cloud-ops-workers-task-role",
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Principal: { Service: "ecs-tasks.amazonaws.com" },
            Action: "sts:AssumeRole",
        }],
    }),
});

// Workers: DynamoDB — read/write on app + audit tables
new aws.iam.RolePolicy("workers-dynamodb-policy", {
    role: workersTaskRole.id,
    policy: pulumi.all([appTable.arn, auditTable.arn]).apply(([appArn, auditArn]) =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
                Effect: "Allow",
                Action: [
                    "dynamodb:GetItem", "dynamodb:Scan", "dynamodb:Query",
                    "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem",
                    "dynamodb:BatchWriteItem",
                ],
                Resource: [
                    appArn, `${appArn}/index/*`,
                    auditArn, `${auditArn}/index/*`,
                ],
            }],
        })
    ),
});

// Workers: cross-account STS AssumeRole (scheduler)
new aws.iam.RolePolicy("workers-sts-policy", {
    role: workersTaskRole.id,
    policy: pulumi.output(crossAccountRoleName).apply(roleName =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
                Effect: "Allow",
                Action: ["sts:AssumeRole"],
                Resource: [
                    `arn:aws:iam::*:role/${roleName}`,
                    "arn:aws:iam::*:role/NucleusAccess-*",
                ],
            }],
        })
    ),
});

// Workers: SNS Publish (scheduler notifications)
new aws.iam.RolePolicy("workers-sns-policy", {
    role: workersTaskRole.id,
    policy: snsTopic.arn.apply(topicArn =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
                Effect: "Allow",
                Action: ["sns:Publish"],
                Resource: [topicArn],
            }],
        })
    ),
});

// Workers: Bedrock InvokeModel (KB sync embeddings)
new aws.iam.RolePolicy("workers-bedrock-policy", {
    role: workersTaskRole.id,
    policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Action: ["bedrock:InvokeModel"],
            Resource: ["*"],
        }],
    }),
});

// Workers: S3 Vectors (KB sync)
new aws.iam.RolePolicy("workers-s3vectors-policy", {
    role: workersTaskRole.id,
    policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Action: [
                "s3vectors:PutVectors",
                "s3vectors:DeleteVectors",
                "s3vectors:QueryVectors",
            ],
            Resource: ["*"],
        }],
    }),
});

// Workers: S3 GetObject on KB staging bucket + arbitrary buckets (s3-sync)
new aws.iam.RolePolicy("workers-s3-policy", {
    role: workersTaskRole.id,
    policy: pulumi.all([kbStagingBucket.arn]).apply(([bucketArn]) =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [
                {
                    Effect: "Allow",
                    Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
                    Resource: [bucketArn, `${bucketArn}/*`],
                },
                {
                    Effect: "Allow",
                    Action: ["s3:GetObject", "s3:ListBucket"],
                    Resource: ["*"],
                },
            ],
        })
    ),
});

// Workers: CloudWatch Logs
new aws.iam.RolePolicy("workers-logs-policy", {
    role: workersTaskRole.id,
    policy: workersLogGroup.arn.apply(logArn =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
                Effect: "Allow",
                Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
                Resource: [logArn, `${logArn}:*`],
            }],
        })
    ),
});
```

- [ ] **Step 10: Add workers ECS Task Definition**

```typescript
// Workers Task Definition — ARM64, FARGATE, 512 CPU / 1024 MiB
const workersTaskDef = new aws.ecs.TaskDefinition("workers-task-def", {
    family: "nucleus-cloud-ops-workers-task",
    cpu: "512",
    memory: "1024",
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    executionRoleArn: ecsTaskExecutionRole.arn,
    taskRoleArn: workersTaskRole.arn,
    runtimePlatform: {
        cpuArchitecture: "ARM64",
        operatingSystemFamily: "LINUX",
    },
    containerDefinitions: pulumi.all([
        appTable.name,
        auditTable.name,
        kbStagingBucket.bucket,
        workersLogGroup.name,
        databaseUrl,
        snsTopic.arn,
        workersImage.imageUri,
    ]).apply(([
        appTableN, auditTableN, kbStagingBucketN,
        workersLogGroupN, databaseUrlVal, snsTopicArn, imageUri,
    ]) => JSON.stringify([{
        name: "WorkersContainer",
        image: imageUri,
        essential: true,
        logConfiguration: {
            logDriver: "awslogs",
            options: {
                "awslogs-group": workersLogGroupN,
                "awslogs-region": region,
                "awslogs-stream-prefix": "workers",
            },
        },
        environment: [
            { name: "NODE_ENV", value: "production" },
            { name: "AWS_REGION", value: region },
            { name: "DATABASE_URL", value: databaseUrlVal },
            { name: "APP_TABLE_NAME", value: appTableN },
            { name: "AUDIT_TABLE_NAME", value: auditTableN },
            { name: "SNS_TOPIC_ARN", value: snsTopicArn },
            { name: "CROSS_ACCOUNT_ROLE_NAME", value: crossAccountRoleName },
            { name: "KB_VECTOR_BUCKET_NAME", value: vectorBucketName || "" },
            { name: "KB_VECTOR_INDEX_NAME", value: "knowledge-base-embeddings" },
            { name: "KB_STAGING_BUCKET_NAME", value: kbStagingBucketN },
            { name: "BEDROCK_MODEL_ID", value: "amazon.titan-embed-text-v2:0" },
            { name: "USE_PG_SCHEDULES", value: "true" },
            { name: "USE_PG_KB", value: "true" },
            { name: "LOG_LEVEL", value: "info" },
        ],
    }])),
});
```

- [ ] **Step 11: Add workers ECS Service**

```typescript
// Workers Security Group — egress only (no inbound needed, workers pull from PG)
const workersSecurityGroup = new aws.ec2.SecurityGroup("workers-sg", {
    name: "nucleus-cloud-ops-workers-sg",
    description: "Security group for pg-boss workers - egress only",
    vpcId: vpcId,
    egress: [{
        fromPort: 0,
        toPort: 0,
        protocol: "-1",
        cidrBlocks: ["0.0.0.0/0"],
        description: "Allow all outbound for AWS API calls + PostgreSQL",
    }],
});

// Workers ECS Service — 1 task, no ALB needed
const workersService = new aws.ecs.Service("workers-service", {
    name: "nucleus-cloud-ops-workers-service",
    cluster: ecsCluster.arn,
    taskDefinition: workersTaskDef.arn,
    desiredCount: 1,
    launchType: "FARGATE",
    forceNewDeployment: true,
    networkConfiguration: {
        subnets: privateSubnetIds,
        securityGroups: [workersSecurityGroup.id],
        assignPublicIp: false,
    },
});
```

- [ ] **Step 12: Update exports — remove Lambda/SQS exports, add workers exports**

At the bottom of the file, remove any exports referencing `schedulerLambda`, `kbSyncProcessorLambda`, `kbSyncQueue`, `kbSyncDlq`. Add:

```typescript
export const workersServiceName = workersService.name;
export const workersEcrRepoUrl = workersEcrRepo.repositoryUrl;
```

- [ ] **Step 13: Verify Pulumi preview**

Run: `cd infra/compute && AWS_PROFILE=PLATFORM-ADMIN pulumi preview --stack prod`
Expected: Shows resources to create (workers ECS service, task def, IAM, ECR, SG) and resources to delete (scheduler Lambda, KB sync Lambda, SQS queues, EventBridge rule). Review carefully before proceeding.

- [ ] **Step 14: Commit**

```bash
git add infra/compute/index.ts
git commit -m "feat(infra): add workers ECS service, remove scheduler Lambda + KB sync Lambda + SQS"
```

---

### Task 13: Update build scripts

**Files:**
- Modify: `infra/build-images.sh`
- Modify: `infra/build-lambdas.sh`

- [ ] **Step 1: Add workers build to build-images.sh**

Add a second build block after the existing web-ui build. Append before the final echo:

```bash
# --- Workers image ---
WORKERS_ECR_REPO_NAME="nucleus-cloud-ops-workers"
WORKERS_ECR_URI="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${WORKERS_ECR_REPO_NAME}"

# Create ECR repo if it doesn't exist
aws ecr describe-repositories \
    --repository-names "$WORKERS_ECR_REPO_NAME" \
    --region "$AWS_REGION" \
    --profile "$AWS_PROFILE" 2>/dev/null \
  || aws ecr create-repository \
    --repository-name "$WORKERS_ECR_REPO_NAME" \
    --region "$AWS_REGION" \
    --profile "$AWS_PROFILE"

echo "==> Building Workers container image..."
docker build \
    -f "${PROJECT_ROOT}/workers/Dockerfile" \
    --platform linux/arm64 \
    -t "${WORKERS_ECR_URI}:latest" \
    "${PROJECT_ROOT}"

docker push "${WORKERS_ECR_URI}:latest"

echo ""
echo "Workers Image URI: ${WORKERS_ECR_URI}:latest"
```

- [ ] **Step 2: Remove scheduler + kb_sync_processor from build-lambdas.sh**

Remove the `build_scheduler` and `build_kb_sync_processor` functions and their references in the case statement and the default (no-arg) path. Keep only `build_vector_processor`.

The updated script should look like:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

TARGET_LAMBDA=""
for arg in "$@"; do
    case "$arg" in
        --lambda=*) TARGET_LAMBDA="${arg#--lambda=}" ;;
    esac
done

build_vector_processor() {
    echo "==> Building VectorProcessor Lambda..."
    cd "$PROJECT_ROOT"
    mkdir -p lambda/vector_processor/dist
    npx esbuild lambda/vector_processor/src/index.ts \
        --bundle \
        --platform=node \
        --target=node20 \
        --format=cjs \
        --outfile=lambda/vector_processor/dist/index.js \
        --external:@aws-sdk/client-s3 \
        --external:@aws-sdk/client-bedrock-runtime \
        --external:@aws-sdk/client-dynamodb \
        --external:@aws-sdk/lib-dynamodb \
        --external:@prisma/client \
        --external:.prisma/client
    mkdir -p lambda/vector_processor/dist/node_modules/@prisma
    mkdir -p lambda/vector_processor/dist/node_modules/.prisma
    cp -r node_modules/@prisma/client lambda/vector_processor/dist/node_modules/@prisma/
    cp -r node_modules/.prisma/client lambda/vector_processor/dist/node_modules/.prisma/
    cd lambda/vector_processor/dist && zip -r ../lambda.zip . && cd ..
    echo "    Done: lambda/vector_processor/lambda.zip"
}

if [ -z "$TARGET_LAMBDA" ]; then
    build_vector_processor
else
    case "$TARGET_LAMBDA" in
        vector_processor)  build_vector_processor ;;
        *)
            echo "ERROR: Unknown lambda '$TARGET_LAMBDA'. Valid: vector_processor"
            exit 1
            ;;
    esac
fi

echo ""
echo "All requested Lambda builds complete."
```

- [ ] **Step 3: Commit**

```bash
git add infra/build-images.sh infra/build-lambdas.sh
git commit -m "chore(infra): update build scripts — add workers image, remove scheduler + kb_sync Lambda builds"
```

---

### Task 14: Run all tests and verify

**Files:**
- No new files

- [ ] **Step 1: Run workers tests**

Run: `cd workers && npm run test`
Expected: All tests pass (boss.test.ts, scheduler/index.test.ts, scheduler/services/dynamodb-service.test.ts, kb-sync/index.test.ts)

- [ ] **Step 2: Run web-ui tests**

Run: `cd web-ui && npm run test`
Expected: All existing tests pass. The API route changes are fire-and-forget — mocking `getBoss()` in tests works the same way SQS was mocked.

- [ ] **Step 3: Verify web-ui lint**

Run: `cd web-ui && npm run lint`
Expected: No new lint errors

- [ ] **Step 4: Verify workers TypeScript compiles**

Run: `cd workers && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit any test fixes**

```bash
git add -A
git commit -m "test: fix any test adjustments for pg-boss migration"
```

---

### Task 15: Delete old Lambda source (after deployment verified)

**Files:**
- Delete: `lambda/scheduler/` (entire directory)
- Delete: `lambda/kb_sync_processor/` (entire directory)

**Important:** Only execute this task AFTER the workers ECS service has been deployed and verified in production. The Lambda source should be kept until you've confirmed:
1. Workers ECS service is running and healthy
2. Scheduler cron fires every 30 minutes and processes schedules
3. KB sync jobs complete successfully when triggered from the UI
4. No errors in CloudWatch logs for the workers service

- [ ] **Step 1: Delete lambda/scheduler/**

```bash
rm -rf lambda/scheduler/
```

- [ ] **Step 2: Delete lambda/kb_sync_processor/**

```bash
rm -rf lambda/kb_sync_processor/
```

- [ ] **Step 3: Remove scheduler Lambda hash + build from infra/compute/index.ts**

If not already removed in Task 12, ensure the `hashDirectory` call for `lambda/scheduler/src` and `lambda/kb_sync_processor/src` are removed, along with the `buildScheduler` and `buildKbSyncProcessor` command resources.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: delete lambda/scheduler and lambda/kb_sync_processor after pg-boss migration verified"
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Scaffold workers package | 3 create |
| 2 | pg-boss singleton + entry point | 3 create |
| 3 | Copy scheduler types, utils, services | 8 create |
| 4 | Copy resource schedulers | 6 create |
| 5 | Scheduler job registration | 2 create, 1 copy |
| 6 | Extract KB sync types + shared libs | 5 create |
| 7 | KB sync handlers | 4 create |
| 8 | KB sync job registration | 2 create |
| 9 | Wire entry point | 1 modify |
| 10 | Web-UI boss client + API routes | 1 create, 3 modify |
| 11 | Workers Dockerfile | 1 create |
| 12 | Pulumi infra changes | 1 modify |
| 13 | Update build scripts | 2 modify |
| 14 | Run all tests | 0 |
| 15 | Delete old Lambda source | 2 delete |

---

### Task 14a: Add docker-compose for local smoke testing

**Files:**
- Create: `docker-compose.workers.yml`

This enables local smoke testing per spec step 6: "docker compose up starts postgres + workers."

- [ ] **Step 1: Create docker-compose.workers.yml at project root**

```yaml
# Local development: postgres + workers
# Usage: docker compose -f docker-compose.workers.yml up
version: "3.8"

services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: nucleus
      POSTGRES_USER: nucleus_admin
      POSTGRES_PASSWORD: localdev
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U nucleus_admin -d nucleus"]
      interval: 5s
      timeout: 3s
      retries: 5

  migrate:
    image: node:20-slim
    working_dir: /app
    volumes:
      - .:/app
    environment:
      DATABASE_URL: postgresql://nucleus_admin:localdev@postgres:5432/nucleus
    depends_on:
      postgres:
        condition: service_healthy
    command: npx prisma@5 migrate deploy --schema=./prisma/schema.prisma
    restart: "no"

  workers:
    build:
      context: .
      dockerfile: workers/Dockerfile
    environment:
      DATABASE_URL: postgresql://nucleus_admin:localdev@postgres:5432/nucleus
      AWS_REGION: ap-south-1
      APP_TABLE_NAME: nucleus-cloud-ops-app-table
      AUDIT_TABLE_NAME: nucleus-cloud-ops-audit-table
      USE_PG_SCHEDULES: "true"
      USE_PG_KB: "true"
      LOG_LEVEL: debug
    depends_on:
      migrate:
        condition: service_completed_successfully

volumes:
  pgdata:
```

- [ ] **Step 2: Verify compose starts**

Run: `docker compose -f docker-compose.workers.yml up --build`
Expected: postgres starts, migrations run, workers starts and logs `[workers] All jobs registered. Waiting for work...`

- [ ] **Step 3: Commit**

```bash
git add docker-compose.workers.yml
git commit -m "chore: add docker-compose for local workers smoke testing"
```

---
