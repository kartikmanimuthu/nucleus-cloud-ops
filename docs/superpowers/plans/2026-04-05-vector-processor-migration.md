# Vector Processor Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the TypeScript vector processor logic from `lambda/vector_processor/` into the discovery worker as an inline step inside `discovery-scan`, then delete the Lambda.

**Architecture:** A new `vector-processor.ts` service is added to `workers/src/jobs/discovery/services/`. It is called inline after `writeResourcesToPg` in the `discovery-scan` handler. Vector errors are non-fatal — they are logged but do not fail the scan job. The Lambda directory is deleted after the worker implementation is verified.

**Tech Stack:** TypeScript (ESM), pg-boss, `@aws-sdk/client-bedrock-runtime`, `@aws-sdk/client-s3vectors`, `@prisma/client`, Vitest

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `workers/src/jobs/discovery/services/vector-processor.ts` | Embedding + S3 Vectors upsert + stale cleanup + PG key tracking |
| Create | `workers/src/jobs/discovery/__tests__/vector-processor.test.ts` | Unit tests for vector-processor service |
| Modify | `workers/src/jobs/discovery/index.ts` | Call `processAccountVectors` after `writeResourcesToPg` |
| Modify | `workers/.env.example` | Add `VECTOR_BUCKET_NAME`, `VECTOR_INDEX_NAME`, `USE_PG_INVENTORY` |
| Delete | `lambda/vector_processor/` | Entire directory — Lambda replaced by worker |

---

### Task 1: Create `vector-processor.ts` with text + hash helpers

**Files:**
- Create: `workers/src/jobs/discovery/services/vector-processor.ts`
- Create: `workers/src/jobs/discovery/__tests__/vector-processor.test.ts`

- [ ] **Step 1: Write the failing tests for `createResourceText` and `computeContentHash`**

Create `workers/src/jobs/discovery/__tests__/vector-processor.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { createResourceText, computeContentHash } from '../services/vector-processor.js';
import type { Resource } from '../types.js';

describe('createResourceText', () => {
  it('produces pipe-delimited text with core fields', () => {
    const resource: Resource = {
      resourceType: 'ec2_instances',
      resourceId: 'i-abc123',
      region: 'us-east-1',
      service: 'ec2',
      name: 'my-instance',
      state: 'running',
      resourceArn: 'arn:aws:ec2:us-east-1:123456789012:instance/i-abc123',
      tags: { Environment: 'prod', Team: 'platform' },
      rawData: {},
    };

    const text = createResourceText(resource);

    expect(text).toContain('Name: my-instance');
    expect(text).toContain('Type: ec2_instances');
    expect(text).toContain('Service: ec2');
    expect(text).toContain('Region: us-east-1');
    expect(text).toContain('State: running');
    expect(text).toContain('ARN: arn:aws:ec2:us-east-1:123456789012:instance/i-abc123');
    expect(text).toContain('Tags: Environment=prod, Team=platform');
    expect(text.split(' | ').length).toBeGreaterThanOrEqual(6);
  });

  it('falls back to resourceId when name is absent', () => {
    const resource: Resource = {
      resourceType: 'ec2_vpcs',
      resourceId: 'vpc-xyz',
      region: 'ap-south-1',
      service: 'ec2',
      tags: {},
      rawData: {},
    };
    expect(createResourceText(resource)).toContain('Name: vpc-xyz');
  });

  it('omits State field when state is absent', () => {
    const resource: Resource = {
      resourceType: 'ec2_vpcs',
      resourceId: 'vpc-xyz',
      region: 'ap-south-1',
      service: 'ec2',
      tags: {},
      rawData: {},
    };
    expect(createResourceText(resource)).not.toContain('State:');
  });

  it('includes CIDR block for ec2_vpcs', () => {
    const resource: Resource = {
      resourceType: 'ec2_vpcs',
      resourceId: 'vpc-xyz',
      region: 'ap-south-1',
      service: 'ec2',
      tags: {},
      rawData: { CidrBlock: '10.0.0.0/16' },
    };
    const text = createResourceText(resource);
    expect(text).toContain('CIDR: 10.0.0.0/16');
  });
});

describe('computeContentHash', () => {
  it('returns a 16-char hex string', () => {
    const hash = computeContentHash('some text');
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it('is deterministic for the same input', () => {
    expect(computeContentHash('hello')).toBe(computeContentHash('hello'));
  });

  it('differs for different inputs', () => {
    expect(computeContentHash('hello')).not.toBe(computeContentHash('world'));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration/workers
npm test -- --reporter=verbose 2>&1 | grep -A 5 "vector-processor"
```

Expected: FAIL — `Cannot find module '../services/vector-processor.js'`

- [ ] **Step 3: Create `vector-processor.ts` with text + hash helpers only**

Create `workers/src/jobs/discovery/services/vector-processor.ts`:

```typescript
// workers/src/jobs/discovery/services/vector-processor.ts
import { createHash } from 'crypto';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { S3VectorsClient, PutVectorsCommand, DeleteVectorsCommand } from '@aws-sdk/client-s3vectors';
import { PrismaClient } from '@prisma/client';
import type { Resource } from '../types.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const EMBEDDING_CONCURRENCY = 5;
const VECTOR_BATCH_SIZE = 20;
const DELETE_BATCH_SIZE = 500;

const region = process.env.AWS_REGION || 'ap-south-1';
const VECTOR_BUCKET_NAME = process.env.VECTOR_BUCKET_NAME!;
const VECTOR_INDEX_NAME = process.env.VECTOR_INDEX_NAME!;
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || 'amazon.titan-embed-text-v2:0';
const USE_PG_INVENTORY = process.env.USE_PG_INVENTORY === 'true';

// ---------------------------------------------------------------------------
// Lazy clients
// ---------------------------------------------------------------------------

let _bedrock: BedrockRuntimeClient | null = null;
function getBedrock(): BedrockRuntimeClient {
  if (!_bedrock) _bedrock = new BedrockRuntimeClient({ region });
  return _bedrock;
}

let _s3vectors: S3VectorsClient | null = null;
function getS3Vectors(): S3VectorsClient {
  if (!_s3vectors) _s3vectors = new S3VectorsClient({ region });
  return _s3vectors;
}

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

// ---------------------------------------------------------------------------
// Text + hash helpers (exported for testing)
// ---------------------------------------------------------------------------

export function createResourceText(resource: Resource): string {
  const parts: string[] = [];

  const name = resource.name || resource.resourceId || 'Unknown';
  parts.push(`Name: ${name}`);
  parts.push(`Type: ${resource.resourceType || 'Unknown'}`);
  parts.push(`Service: ${resource.service || resource.resourceType?.split('_')[0] || 'Unknown'}`);
  parts.push(`Region: ${resource.region || 'Unknown'}`);
  parts.push(`Account: ${resource.resourceId ? resource.resourceId : 'Unknown'}`);

  if (resource.state) {
    parts.push(`State: ${resource.state}`);
  }

  if (resource.resourceArn) {
    parts.push(`ARN: ${resource.resourceArn}`);
  }

  const tags = resource.tags;
  if (tags && typeof tags === 'object' && Object.keys(tags).length > 0) {
    const tagList = Object.entries(tags)
      .slice(0, 20)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    parts.push(`Tags: ${tagList}`);
  }

  // VPC-specific: surface CIDR block for semantic search
  if (resource.resourceType === 'ec2_vpcs' && resource.rawData && typeof resource.rawData === 'object') {
    const raw = resource.rawData as Record<string, unknown>;
    if (raw.CidrBlock) parts.push(`CIDR: ${raw.CidrBlock}`);
    if (raw.IsDefault) parts.push(`Default VPC: true`);
  }

  const meta = resource.rawData;
  if (meta && typeof meta === 'object') {
    const metaList: string[] = [];
    for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        metaList.push(`${k}=${v}`);
      } else if (Array.isArray(v) && v.length > 0 && v.length < 5) {
        metaList.push(`${k}=${v.join(',')}`);
      }
    }
    if (metaList.length > 0) {
      parts.push(`Details: ${metaList.join(', ')}`);
    }
  }

  return parts.join(' | ');
}

export function computeContentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration/workers
npm test -- --reporter=verbose 2>&1 | grep -A 5 "vector-processor"
```

Expected: all `createResourceText` and `computeContentHash` tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration/workers
git add src/jobs/discovery/services/vector-processor.ts src/jobs/discovery/__tests__/vector-processor.test.ts
git commit -m "feat(vector-processor): add createResourceText and computeContentHash helpers"
```

---

### Task 2: Add embedding + S3 Vectors upsert to `vector-processor.ts`

**Files:**
- Modify: `workers/src/jobs/discovery/services/vector-processor.ts`
- Modify: `workers/src/jobs/discovery/__tests__/vector-processor.test.ts`

- [ ] **Step 1: Add tests for `processAccountVectors` (mocking Bedrock + S3 Vectors + Prisma)**

Append to `workers/src/jobs/discovery/__tests__/vector-processor.test.ts`:

```typescript
import { vi, beforeEach } from 'vitest';

// Mock AWS SDK clients and Prisma before importing the module under test
const mockInvokeModel = vi.fn().mockResolvedValue({
  body: new TextEncoder().encode(JSON.stringify({ embedding: Array(1024).fill(0.1) })),
});
const mockPutVectors = vi.fn().mockResolvedValue({});
const mockDeleteVectors = vi.fn().mockResolvedValue({});
const mockFindUnique = vi.fn().mockResolvedValue(null);
const mockUpsert = vi.fn().mockResolvedValue({});

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: vi.fn().mockImplementation(() => ({ send: mockInvokeModel })),
  InvokeModelCommand: vi.fn().mockImplementation((input) => input),
}));

vi.mock('@aws-sdk/client-s3vectors', () => ({
  S3VectorsClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockImplementation((cmd) => {
      if (cmd.__type === 'put') return mockPutVectors(cmd);
      return mockDeleteVectors(cmd);
    }),
  })),
  PutVectorsCommand: vi.fn().mockImplementation((input) => ({ ...input, __type: 'put' })),
  DeleteVectorsCommand: vi.fn().mockImplementation((input) => ({ ...input, __type: 'delete' })),
}));

vi.mock('@prisma/client', () => ({
  PrismaClient: vi.fn().mockImplementation(() => ({
    inventoryVectorKey: { findUnique: mockFindUnique, upsert: mockUpsert },
  })),
}));

import { processAccountVectors } from '../services/vector-processor.js';

describe('processAccountVectors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
    process.env.VECTOR_BUCKET_NAME = 'test-bucket';
    process.env.VECTOR_INDEX_NAME = 'test-index';
    process.env.USE_PG_INVENTORY = 'true';
  });

  it('returns 0 for empty resources array', async () => {
    const count = await processAccountVectors([], 'acc-123', 'tenant-1');
    expect(count).toBe(0);
    expect(mockInvokeModel).not.toHaveBeenCalled();
  });

  it('embeds resources and calls PutVectors', async () => {
    const resources: Resource[] = [
      { resourceType: 'ec2_instances', resourceId: 'i-001', region: 'us-east-1', service: 'ec2', tags: {}, rawData: {} },
      { resourceType: 'ec2_instances', resourceId: 'i-002', region: 'us-east-1', service: 'ec2', tags: {}, rawData: {} },
    ];

    const count = await processAccountVectors(resources, 'acc-123', 'tenant-1');

    expect(count).toBe(2);
    expect(mockInvokeModel).toHaveBeenCalledTimes(2);
    expect(mockPutVectors).toHaveBeenCalled();
  });

  it('deduplicates resources with the same resourceId', async () => {
    const resources: Resource[] = [
      { resourceType: 'ec2_instances', resourceId: 'i-dup', region: 'us-east-1', service: 'ec2', tags: {}, rawData: {} },
      { resourceType: 'ec2_instances', resourceId: 'i-dup', region: 'us-east-1', service: 'ec2', tags: {}, rawData: {} },
    ];

    const count = await processAccountVectors(resources, 'acc-123', 'tenant-1');

    expect(count).toBe(1);
    expect(mockInvokeModel).toHaveBeenCalledTimes(1);
  });

  it('deletes stale keys when previous keys exist', async () => {
    mockFindUnique.mockResolvedValueOnce({ vectorKeys: ['stale-key-1', 'stale-key-2'] });

    const resources: Resource[] = [
      { resourceType: 'ec2_instances', resourceId: 'i-new', region: 'us-east-1', service: 'ec2', tags: {}, rawData: {} },
    ];

    await processAccountVectors(resources, 'acc-123', 'tenant-1');

    expect(mockDeleteVectors).toHaveBeenCalled();
  });

  it('saves new vector keys to PostgreSQL when USE_PG_INVENTORY=true', async () => {
    const resources: Resource[] = [
      { resourceType: 'ec2_instances', resourceId: 'i-001', region: 'us-east-1', service: 'ec2', tags: {}, rawData: {} },
    ];

    await processAccountVectors(resources, 'acc-123', 'tenant-1');

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { accountId: 'acc-123' },
        update: expect.objectContaining({ vectorKeys: expect.any(Array) }),
        create: expect.objectContaining({ accountId: 'acc-123' }),
      }),
    );
  });

  it('skips key tracking when USE_PG_INVENTORY=false', async () => {
    process.env.USE_PG_INVENTORY = 'false';

    const resources: Resource[] = [
      { resourceType: 'ec2_instances', resourceId: 'i-001', region: 'us-east-1', service: 'ec2', tags: {}, rawData: {} },
    ];

    await processAccountVectors(resources, 'acc-123', 'tenant-1');

    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

```bash
cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration/workers
npm test -- --reporter=verbose 2>&1 | grep -E "FAIL|processAccountVectors"
```

Expected: FAIL — `processAccountVectors is not a function`

- [ ] **Step 3: Implement `processAccountVectors` — append to `vector-processor.ts`**

Append the following to `workers/src/jobs/discovery/services/vector-processor.ts` (after the `computeContentHash` function):

```typescript
// ---------------------------------------------------------------------------
// Embedding helper
// ---------------------------------------------------------------------------

async function getEmbedding(text: string): Promise<number[]> {
  const res = await getBedrock().send(
    new InvokeModelCommand({
      modelId: BEDROCK_MODEL_ID,
      body: JSON.stringify({ inputText: text.slice(0, 8000) }),
      contentType: 'application/json',
      accept: 'application/json',
    }),
  );
  return JSON.parse(new TextDecoder().decode(res.body)).embedding;
}

// ---------------------------------------------------------------------------
// PG key tracking helpers
// ---------------------------------------------------------------------------

async function getPreviousVectorKeys(accountId: string): Promise<string[]> {
  try {
    const record = await getPrisma().inventoryVectorKey.findUnique({
      where: { accountId },
      select: { vectorKeys: true },
    });
    return record?.vectorKeys || [];
  } catch (err) {
    console.warn(`[vector-processor] Could not read previous keys for ${accountId}:`, err);
    return [];
  }
}

async function saveVectorKeys(accountId: string, keys: string[]): Promise<void> {
  await getPrisma().inventoryVectorKey.upsert({
    where: { accountId },
    update: { vectorKeys: keys },
    create: { accountId, vectorKeys: keys },
  });
}

// ---------------------------------------------------------------------------
// Stale vector cleanup
// ---------------------------------------------------------------------------

async function deleteStaleVectors(staleKeys: string[]): Promise<void> {
  if (!staleKeys.length) return;
  console.log(`[vector-processor] Deleting ${staleKeys.length} stale vectors`);
  for (let i = 0; i < staleKeys.length; i += DELETE_BATCH_SIZE) {
    await getS3Vectors().send(
      new DeleteVectorsCommand({
        vectorBucketName: VECTOR_BUCKET_NAME,
        indexName: VECTOR_INDEX_NAME,
        keys: staleKeys.slice(i, i + DELETE_BATCH_SIZE),
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function processAccountVectors(
  resources: Resource[],
  accountId: string,
  tenantId: string,
): Promise<number> {
  if (!resources.length) return 0;

  // Fetch previous keys before processing (for stale cleanup)
  const previousKeys = USE_PG_INVENTORY ? await getPreviousVectorKeys(accountId) : [];

  const vectorPayload: Array<{
    key: string;
    data: { float32: number[] };
    metadata: Record<string, string>;
  }> = [];

  // Embed in batches of EMBEDDING_CONCURRENCY to respect Bedrock rate limits
  for (let i = 0; i < resources.length; i += EMBEDDING_CONCURRENCY) {
    const batch = resources.slice(i, i + EMBEDDING_CONCURRENCY);

    const results = await Promise.all(
      batch.map(async (resource) => {
        if (!resource.resourceId) return null;

        const text = createResourceText(resource);
        if (!text) return null;

        const contentHash = computeContentHash(text);

        try {
          const embedding = await getEmbedding(text);
          return {
            key: `${resource.resourceId}_${contentHash}`,
            data: { float32: embedding },
            metadata: {
              resourceId: resource.resourceId,
              resourceArn: resource.resourceArn || '',
              resourceType: resource.resourceType || '',
              name: resource.name || resource.resourceId,
              region: resource.region || '',
              accountId,
              tenantId,
              state: resource.state || '',
              service: resource.service || '',
              contentHash,
              text_content: text.slice(0, 1000),
              lastDiscoveredAt: new Date().toISOString(),
            },
          };
        } catch (err) {
          console.error(`[vector-processor] Failed embedding for ${resource.resourceId}:`, err);
          return null;
        }
      }),
    );

    vectorPayload.push(...(results.filter(Boolean) as typeof vectorPayload));
  }

  if (!vectorPayload.length) {
    console.warn(`[vector-processor] No vectors generated for account ${accountId}`);
    return 0;
  }

  // Deduplicate by key
  const seen = new Set<string>();
  const deduped = vectorPayload.filter((v) => {
    if (seen.has(v.key)) return false;
    seen.add(v.key);
    return true;
  });

  if (deduped.length < vectorPayload.length) {
    console.warn(`[vector-processor] Deduplicated ${vectorPayload.length - deduped.length} duplicate keys for ${accountId}`);
  }

  // Upsert to S3 Vectors in batches of VECTOR_BATCH_SIZE
  for (let i = 0; i < deduped.length; i += VECTOR_BATCH_SIZE) {
    const batch = deduped.slice(i, i + VECTOR_BATCH_SIZE);
    await getS3Vectors().send(
      new PutVectorsCommand({
        vectorBucketName: VECTOR_BUCKET_NAME,
        indexName: VECTOR_INDEX_NAME,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        vectors: batch as any,
      }),
    );
  }

  const newKeys = deduped.map((v) => v.key);

  // Delete stale vectors and persist new keys (only when USE_PG_INVENTORY=true)
  if (USE_PG_INVENTORY) {
    const newKeySet = new Set(newKeys);
    const staleKeys = previousKeys.filter((k) => !newKeySet.has(k));
    await deleteStaleVectors(staleKeys);
    await saveVectorKeys(accountId, newKeys);
  }

  console.log(`[vector-processor] Ingested ${deduped.length} vectors for account ${accountId}`);
  return deduped.length;
}
```

- [ ] **Step 4: Run all tests to verify they pass**

```bash
cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration/workers
npm test -- --reporter=verbose 2>&1 | tail -20
```

Expected: all tests PASS (including existing discovery tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration/workers
git add src/jobs/discovery/services/vector-processor.ts src/jobs/discovery/__tests__/vector-processor.test.ts
git commit -m "feat(vector-processor): implement processAccountVectors with embedding, dedup, stale cleanup"
```

---

### Task 3: Wire `processAccountVectors` into the discovery scan handler

**Files:**
- Modify: `workers/src/jobs/discovery/index.ts`

- [ ] **Step 1: Add the import at the top of `index.ts`**

In `workers/src/jobs/discovery/index.ts`, add after the existing imports:

```typescript
import { processAccountVectors } from './services/vector-processor.js';
```

- [ ] **Step 2: Add the inline call after `writeResourcesToPg`**

In the `discovery-scan` handler, find the block:

```typescript
          await writeResourcesToPg(result.resources, tenantId, account.accountId, scanId);
          await updateAccountSyncStatus(tenantId, account.accountId, {
```

Replace with:

```typescript
          await writeResourcesToPg(result.resources, tenantId, account.accountId, scanId);

          // Vector embedding — non-fatal: errors are logged but do not fail the scan
          try {
            const vectorCount = await processAccountVectors(result.resources, account.accountId, tenantId);
            console.log(`[discovery] Vectorized ${vectorCount} resources for ${account.accountId}`);
          } catch (err) {
            console.error(`[discovery] Vector processing failed for ${account.accountId} (non-fatal):`, err);
          }

          await updateAccountSyncStatus(tenantId, account.accountId, {
```

- [ ] **Step 3: Run all tests to verify nothing broke**

```bash
cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration/workers
npm test -- --reporter=verbose 2>&1 | tail -20
```

Expected: all tests PASS.

- [ ] **Step 4: Typecheck**

```bash
cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration/workers
npm run typecheck 2>&1
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration/workers
git add src/jobs/discovery/index.ts
git commit -m "feat(discovery): wire processAccountVectors inline after writeResourcesToPg"
```

---

### Task 4: Update `.env.example` and delete the Lambda

**Files:**
- Modify: `workers/.env.example`
- Delete: `lambda/vector_processor/` (entire directory)

- [ ] **Step 1: Add vector processor env vars to `.env.example`**

In `workers/.env.example`, append after the `KB Sync — Bedrock` section:

```bash
# ─── Inventory Vector Processor ───────────────────────────────────────────────
# S3 Vectors bucket and index used to store inventory resource embeddings.
VECTOR_BUCKET_NAME="nucleus-inventory-vectors"
VECTOR_INDEX_NAME="nucleus-inventory-index"

# "true"  → vector key tracking reads/writes from PostgreSQL (enables stale cleanup)
# "false" → key tracking disabled; vectors are written but stale keys are not cleaned up
USE_PG_INVENTORY="false"
```

- [ ] **Step 2: Delete the Lambda directory**

```bash
rm -rf /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration/lambda/vector_processor
```

- [ ] **Step 3: Verify the Lambda directory is gone**

```bash
ls /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration/lambda/
```

Expected: `vector_processor` is no longer listed.

- [ ] **Step 4: Run all tests one final time**

```bash
cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration/workers
npm test -- --reporter=verbose 2>&1 | tail -20
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/pg-boss-migration
git add workers/.env.example
git rm -r lambda/vector_processor
git commit -m "chore: delete vector_processor Lambda — logic migrated to discovery worker"
```

---

## Self-Review

**Spec coverage:**
- [x] New `vector-processor.ts` service — Task 1 + 2
- [x] `createResourceText` ported from Lambda — Task 1
- [x] `computeContentHash` ported from Lambda — Task 1
- [x] Bedrock embedding, batched at concurrency 5 — Task 2
- [x] S3 Vectors upsert in batches of 20 — Task 2
- [x] Deduplication by key — Task 2
- [x] Stale key cleanup — Task 2
- [x] PG key tracking via `inventoryVectorKey.upsert` — Task 2
- [x] `USE_PG_INVENTORY` feature flag — Task 2 + 4
- [x] Inline call in `discovery-scan` handler — Task 3
- [x] Non-fatal error handling — Task 3
- [x] `.env.example` updated — Task 4
- [x] Lambda directory deleted — Task 4

**Type consistency:** `Resource` type from `../types.js` used consistently across all tasks. `processAccountVectors(resources: Resource[], accountId: string, tenantId: string): Promise<number>` signature is consistent between Task 2 implementation and Task 3 call site.
