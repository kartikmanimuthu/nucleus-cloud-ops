# Agent Memory Refactor — Phase 0 + Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the foundation of a native-TS multi-layer memory system (typed kind-discriminated schema + HNSW index + a typed `MemoryService`) and Phase 1 working memory (in-session compaction + budget-aware context assembly) so autonomous agents survive long runs.

**Architecture:** Evolve the existing `AgentMemory` table with a `kind` discriminator and scaffolding columns (one table, one vector index, one retrieval path). A new `MemoryService` becomes the single typed entry point; `PostgresMemoryStore.batch()` stays as a thin delegating shim so the deep-agent's tools are untouched. Working memory lives in the checkpointed `ReflectionState` (source of truth during a run) and is mirrored to a durable `AgentWorkingMemory` table on each compaction. A pure `prepareContext()` helper replaces the naive `getRecentMessages()` slice at each agent-node call site — folding evicted turns into a running summary and assembling a budget-bounded window.

**Tech Stack:** TypeScript 5, Next.js 15, Prisma (dual client: `@prisma/client@5` web-ui root + `@6` workers), PostgreSQL + pgvector (`pgvector/pgvector:pg16`), LangGraph JS, `@t3-oss/env-nextjs`, Vitest + fast-check.

## Global Constraints

- **Prisma dual-client:** after any `schema.prisma` change, regenerate BOTH clients — `cd apps/web-ui && bun run db:generate` AND `cd apps/workers && bun run db:generate`.
- **Schema is the single source of truth:** `libs/prisma/schema.prisma` (shared by web-ui + workers).
- **Multi-tenant safety:** every query scoped by `tenantId`. Use `getTenantClient(tenantId)` for ORM calls; for `$executeRaw`/`$queryRaw` (NOT intercepted by the tenant extension) add `WHERE "tenantId" = ...` manually.
- **Embeddings:** provider-only via `getTenantEmbeddings(tenantId)`; fixed **1024-dim**; embedding failure is non-fatal (degrade to recency/text search). No Bedrock fallback.
- **Additive migrations only:** no dropped columns; existing `agent_memories` rows must keep working.
- **Feature-flag gating:** new behavior gated by `WORKING_MEMORY_ENABLED` (pattern: `RIGHT_SIZING_ENABLED`); when off, behavior is identical to today.
- **Style:** 4-space indent in `lib/` service files; named exports (no default); functional code; `@/` path alias for cross-dir imports in web-ui.
- **Deep-agent is out of scope** — do not modify `apps/web-ui/lib/deep-agent/**`.
- **Provider-only LLM:** memory summarization uses the agent's existing `reflectorModel` — never instantiate a hardcoded model.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `libs/prisma/schema.prisma` | `MemoryKind` enum, new `AgentMemory` columns, `AgentWorkingMemory` model |
| `libs/prisma/migrations/<ts>_agent_memory_foundation/migration.sql` | additive DDL + raw HNSW index |
| `apps/web-ui/lib/agent/memory/types.ts` | `MemoryKind`, per-kind value unions, `MemoryHit`, `Scratchpad`, `WorkingMemory` |
| `apps/web-ui/lib/agent/memory/memory-service.ts` | typed `recall`/`remember`/`getWorkingMemory`/`putWorkingMemory` + `getMemoryService()` singleton |
| `apps/web-ui/lib/agent/memory/memory-service.test.ts` | unit tests for MemoryService (mocked prisma) |
| `apps/web-ui/lib/agent/memory/working-memory.ts` | config accessors, token estimation, tool-log compression, `selectWindow`, `foldWorkingMemory`, `prepareContext` |
| `apps/web-ui/lib/agent/memory/working-memory.test.ts` | unit + fast-check tests for working memory (mocked reflector) |
| `apps/web-ui/env.ts` | `WORKING_MEMORY_*` env vars |
| `apps/web-ui/lib/agent/persistence.ts` | `PostgresMemoryStore.batch()` delegates to `MemoryService` |
| `apps/web-ui/lib/agent/memory-nodes.ts` | recall/save call `MemoryService` (typed, kind-aware) |
| `apps/web-ui/lib/agent/agent-shared.ts` | `ReflectionState` + `graphState` gain `runningSummary`/`scratchpad` |
| `apps/web-ui/lib/agent/fast-agent.ts` | wire `prepareContext` into `agentNode` + `finalizeNode` |
| `apps/web-ui/lib/agent/planning-agent.ts` | wire `prepareContext` into its 3 window call sites |
| `apps/web-ui/lib/db/repositories/agent-memory/{interface,postgres}.ts` | expose `kind` on `AgentMemoryRecord` (keeps Memory UI working, enables later filtering) |

---

## Interfaces (locked — every task must match these names/types)

`apps/web-ui/lib/agent/memory/types.ts`:

```typescript
export type MemoryKind = 'SEMANTIC' | 'EPISODIC' | 'PROCEDURAL';

export interface SemanticValue { fact: string; source: string; confidence: 'high' | 'medium'; }
export interface EpisodicValue { context: string; reasoning: string; action: string; outcome: string; }
export interface ProceduralValue { instruction: string; trigger: string; evidence: string; }

export interface MemoryHit {
    namespace: string;
    key: string;
    value: Record<string, unknown>;
    kind: MemoryKind;
}

export interface Scratchpad {
    openGoals: string[];
    keyFindings: string[];
    resourceIds: string[];
    pendingSteps: string[];
}

export interface WorkingMemory {
    runningSummary: string;
    scratchpad: Scratchpad;
    tokenCount: number;
    turnCount: number;
}
```

`apps/web-ui/lib/agent/memory/memory-service.ts`:

```typescript
export interface RecallParams {
    tenantId: string;
    userId: string;
    query: string;
    kinds?: MemoryKind[];
    namespacePrefix?: string[];
    limit?: number;
}
export interface RememberParams {
    tenantId: string;
    userId: string;
    kind: MemoryKind;
    namespace: string[];
    key: string;
    value: Record<string, unknown>;
    sourceThreadId?: string;
}
export interface PutWorkingMemoryParams {
    tenantId: string;
    threadId: string;
    wm: WorkingMemory;
}
// methods: recall(RecallParams) => Promise<MemoryHit[]>
//          remember(RememberParams) => Promise<void>
//          getWorkingMemory(tenantId, threadId) => Promise<WorkingMemory | null>
//          putWorkingMemory(PutWorkingMemoryParams) => Promise<void>
export function getMemoryService(): MemoryService;
```

`apps/web-ui/lib/agent/memory/working-memory.ts`:

```typescript
export function workingMemoryEnabled(): boolean;
export function tokenBudget(): number;      // WORKING_MEMORY_TOKEN_BUDGET, default 60000
export function keepRecent(): number;        // WORKING_MEMORY_KEEP_RECENT, default 8
export function estimateTokens(text: string): number;                 // ceil(len/4)
export function estimateMessagesTokens(messages: BaseMessage[]): number;
export function compressToolOutput(content: string, maxChars?: number): string;  // head+tail
export function emptyScratchpad(): Scratchpad;
export function selectWindow(messages: BaseMessage[], budget: number, keep: number): BaseMessage[];
export function buildWorkingMemorySection(wm: WorkingMemory | null): string; // '' or "## Working Memory\n..."

export interface PrepareContextDeps {
    reflectorModel: BaseChatModel;
    tenantId?: string;
    threadId?: string;
}
export interface PreparedContext {
    windowMessages: BaseMessage[];
    workingMemorySection: string;
    stateUpdate: Partial<Pick<ReflectionState, 'runningSummary' | 'scratchpad'>>;
}
export async function prepareContext(
    state: ReflectionState,
    deps: PrepareContextDeps,
    fallbackWindow: number,
): Promise<PreparedContext>;
```

`ReflectionState` gains (in `agent-shared.ts`): `runningSummary: string;` and `scratchpad: Scratchpad;`.

---

## Task 1: Schema + migration (Phase 0-A, 0-B)

**Files:**
- Modify: `libs/prisma/schema.prisma:498-514` (AgentMemory) + add `MemoryKind` enum + `AgentWorkingMemory` model
- Create: `libs/prisma/migrations/<timestamp>_agent_memory_foundation/migration.sql`

**Interfaces:**
- Produces: DB columns `agent_memories.kind|sourceThreadId|supersededById|supersededAt|lastAccessedAt|accessCount`; table `agent_working_memory`; HNSW index `agent_memories_embedding_hnsw`. Prisma models `AgentMemory` (extended) + `AgentWorkingMemory` + enum `MemoryKind`.

- [ ] **Step 1: Start Postgres (if not running)**

Run: `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/agent-memory && docker compose up -d postgres`
Expected: container `postgres` is `Up`/healthy.

- [ ] **Step 2: Edit the schema — add the enum**

In `libs/prisma/schema.prisma`, directly above `model AgentMemory {` (line ~498), add:

```prisma
enum MemoryKind {
  SEMANTIC
  EPISODIC
  PROCEDURAL
}
```

- [ ] **Step 3: Edit the schema — extend `AgentMemory`**

Replace the `AgentMemory` model body with (additive fields + index; existing fields unchanged):

```prisma
model AgentMemory {
  id             String                       @id @default(cuid())
  tenantId       String
  userId         String
  namespace      String
  key            String
  value          Json
  kind           MemoryKind                   @default(SEMANTIC)
  embedding      Unsupported("vector(1024)")?
  sourceThreadId String?
  supersededById String?
  supersededAt   DateTime?
  lastAccessedAt DateTime?
  accessCount    Int                          @default(0)
  createdAt      DateTime                     @default(now())
  updatedAt      DateTime                     @updatedAt
  expiresAt      DateTime // 90-day TTL

  @@unique([tenantId, namespace, key])
  @@index([tenantId, userId])
  @@index([tenantId, kind])
  @@index([expiresAt])
  @@map("agent_memories")
}
```

- [ ] **Step 4: Edit the schema — add `AgentWorkingMemory`**

Immediately after the `AgentMemory` model, add:

```prisma
// AgentWorkingMemory — per-thread in-session scratchpad + rolling summary (Phase 1).
// Live source of truth is the LangGraph checkpoint; this table is a durable mirror
// written on each compaction. No embedding (this is live context, not searched).
model AgentWorkingMemory {
  id             String   @id @default(cuid())
  tenantId       String
  threadId       String
  runningSummary String   @db.Text
  scratchpad     Json
  tokenCount     Int      @default(0)
  turnCount      Int      @default(0)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  expiresAt      DateTime

  @@unique([tenantId, threadId])
  @@index([expiresAt])
  @@map("agent_working_memory")
}
```

- [ ] **Step 5: Generate the migration SQL (do NOT apply yet)**

Run: `cd apps/web-ui && bun run db:migrate -- --create-only --name agent_memory_foundation`
(The `db:migrate` script is `cd ../.. && prisma migrate dev --schema=./libs/prisma/schema.prisma`; args after `--` are forwarded.)
Expected: a new folder `libs/prisma/migrations/<timestamp>_agent_memory_foundation/migration.sql` is created; nothing applied to the DB yet.

- [ ] **Step 6: Append the raw HNSW index to the generated migration**

Open the generated `migration.sql` and append at the very end (Prisma cannot emit an index on an `Unsupported` column):

```sql
-- pgvector HNSW index for cosine similarity (matches the <=> queries in persistence.ts)
CREATE INDEX IF NOT EXISTS "agent_memories_embedding_hnsw"
  ON "agent_memories" USING hnsw ("embedding" vector_cosine_ops);
```

(Note: the `kind` column is added with `DEFAULT 'SEMANTIC'`, so existing rows backfill automatically — no manual `UPDATE` needed.)

- [ ] **Step 7: Apply the migration**

Run: `cd apps/web-ui && bun run db:migrate`
Expected: `The following migration(s) have been applied` including `agent_memory_foundation`; ends `Your database is now in sync with your schema.`

- [ ] **Step 8: Regenerate BOTH Prisma clients**

Run: `cd apps/web-ui && bun run db:generate && cd ../workers && bun run db:generate`
Expected: both print `Generated Prisma Client`.

- [ ] **Step 9: Verify the schema changes in the DB**

Run (local container is `nucleus-postgres`, user `nucleus`, db `nucleus`):
```bash
docker exec -i nucleus-postgres psql -U nucleus -d nucleus -c "SELECT indexname FROM pg_indexes WHERE tablename='agent_memories' AND indexname='agent_memories_embedding_hnsw';"
docker exec -i nucleus-postgres psql -U nucleus -d nucleus -c "SELECT count(*) AS null_kind FROM agent_memories WHERE kind IS NULL;"
docker exec -i nucleus-postgres psql -U nucleus -d nucleus -c "\d agent_working_memory"
```
Expected: first prints `agent_memories_embedding_hnsw` (1 row); second prints `null_kind = 0`; third shows the `agent_working_memory` table with a unique index on `(tenantId, threadId)`.

> If the credentials differ, re-read them from the root `.env` `DATABASE_URL` and substitute `-U`/`-d` accordingly.

- [ ] **Step 10: Commit**

```bash
git add libs/prisma/schema.prisma libs/prisma/migrations/
git commit -m "feat(memory): schema foundation — MemoryKind, scaffolding columns, working-memory table, HNSW index"
```

---

## Task 2: Memory types (Phase 0-C)

**Files:**
- Create: `apps/web-ui/lib/agent/memory/types.ts`

**Interfaces:**
- Produces: `MemoryKind`, `SemanticValue`, `EpisodicValue`, `ProceduralValue`, `MemoryHit`, `Scratchpad`, `WorkingMemory` (exact shapes in the "Interfaces" section above).

- [ ] **Step 1: Write the file**

Create `apps/web-ui/lib/agent/memory/types.ts` with exactly the contents of the `types.ts` block in the "Interfaces" section above.

- [ ] **Step 2: Verify it typechecks**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep "memory/types.ts" || echo "no errors in types.ts"`
Expected: `no errors in types.ts`.

- [ ] **Step 3: Commit**

```bash
git add apps/web-ui/lib/agent/memory/types.ts
git commit -m "feat(memory): typed value unions and working-memory types"
```

---

## Task 3: MemoryService (Phase 0-C)

**Files:**
- Create: `apps/web-ui/lib/agent/memory/memory-service.ts`
- Create: `apps/web-ui/lib/agent/memory/memory-service.test.ts`

**Interfaces:**
- Consumes: `types.ts` (Task 2); `getPrismaClient` from `@/lib/db/pg-config`; `getTenantEmbeddings` from `../embeddings-factory`.
- Produces: `MemoryService` class, `getMemoryService()` singleton, `RecallParams`, `RememberParams`, `PutWorkingMemoryParams` (signatures in "Interfaces" section).

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/lib/agent/memory/memory-service.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the prisma client + embeddings BEFORE importing the service.
const mockExecuteRaw = vi.fn().mockResolvedValue(1);
const mockQueryRaw = vi.fn().mockResolvedValue([]);
const mockUpsert = vi.fn().mockResolvedValue({});
const mockFindUnique = vi.fn().mockResolvedValue(null);

vi.mock('@/lib/db/pg-config', () => ({
    getPrismaClient: () => ({
        $executeRaw: mockExecuteRaw,
        $queryRaw: mockQueryRaw,
        agentMemory: { upsert: mockUpsert },
        agentWorkingMemory: { upsert: mockUpsert, findUnique: mockFindUnique },
    }),
}));

vi.mock('../embeddings-factory', () => ({
    getTenantEmbeddings: vi.fn().mockResolvedValue({
        embedQuery: vi.fn().mockResolvedValue(new Array(1024).fill(0.1)),
    }),
}));

import { getMemoryService } from './memory-service';

describe('MemoryService.recall', () => {
    beforeEach(() => {
        mockQueryRaw.mockClear();
        mockQueryRaw.mockResolvedValue([
            { namespace: 'infra/123', key: 'region', value: { fact: 'us-east-1' }, kind: 'SEMANTIC' },
        ]);
    });

    it('returns typed MemoryHit[] and filters by kind', async () => {
        const svc = getMemoryService();
        const hits = await svc.recall({
            tenantId: 't1', userId: 'u1', query: 'where is prod', kinds: ['SEMANTIC'], limit: 5,
        });
        expect(hits).toHaveLength(1);
        expect(hits[0]).toMatchObject({ namespace: 'infra/123', key: 'region', kind: 'SEMANTIC' });
        // vector search path was used (embedding available)
        expect(mockQueryRaw).toHaveBeenCalled();
    });
});

describe('MemoryService.remember', () => {
    it('upserts with an embedding vector', async () => {
        mockExecuteRaw.mockClear();
        const svc = getMemoryService();
        await svc.remember({
            tenantId: 't1', userId: 'u1', kind: 'SEMANTIC',
            namespace: ['infra', '123'], key: 'region',
            value: { fact: 'us-east-1', source: 'cli', confidence: 'high' },
        });
        expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/agent/memory/memory-service.test.ts`
Expected: FAIL — `Cannot find module './memory-service'`.

- [ ] **Step 3: Write the implementation**

Create `apps/web-ui/lib/agent/memory/memory-service.ts`:

```typescript
import type { Embeddings } from '@langchain/core/embeddings';
import { getPrismaClient } from '@/lib/db/pg-config';
import { getTenantEmbeddings } from '../embeddings-factory';
import type { MemoryHit, MemoryKind, WorkingMemory, Scratchpad } from './types';

export interface RecallParams {
    tenantId: string;
    userId: string;
    query: string;
    kinds?: MemoryKind[];
    namespacePrefix?: string[];
    limit?: number;
}
export interface RememberParams {
    tenantId: string;
    userId: string;
    kind: MemoryKind;
    namespace: string[];
    key: string;
    value: Record<string, unknown>;
    sourceThreadId?: string;
}
export interface PutWorkingMemoryParams {
    tenantId: string;
    threadId: string;
    wm: WorkingMemory;
}

const TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days, matches existing memory TTL

export class MemoryService {
    private embeddingsCache = new Map<string, Promise<Embeddings>>();

    private getEmbeddings(tenantId: string): Promise<Embeddings> {
        let cached = this.embeddingsCache.get(tenantId);
        if (!cached) {
            cached = getTenantEmbeddings(tenantId);
            cached.catch(() => this.embeddingsCache.delete(tenantId));
            this.embeddingsCache.set(tenantId, cached);
        }
        return cached;
    }

    async remember(m: RememberParams): Promise<void> {
        const prisma = getPrismaClient();
        const namespace = m.namespace.join('/');
        const expiresAt = new Date(Date.now() + TTL_MS);

        let vec: number[] | null = null;
        try {
            const emb = await this.getEmbeddings(m.tenantId);
            vec = await emb.embedQuery(JSON.stringify(m.value));
        } catch {
            // provider missing / embedding failure is non-fatal
        }

        if (vec) {
            const vecStr = `[${vec.join(',')}]`;
            // $executeRaw is NOT tenant-intercepted — tenantId is bound explicitly.
            await prisma.$executeRaw`
                INSERT INTO agent_memories ("id","tenantId","userId","namespace","key","value","kind","embedding","sourceThreadId","createdAt","updatedAt","expiresAt")
                VALUES (gen_random_uuid()::text, ${m.tenantId}, ${m.userId}, ${namespace}, ${m.key}, ${JSON.stringify(m.value)}::jsonb, ${m.kind}::"MemoryKind", ${vecStr}::vector, ${m.sourceThreadId ?? null}, NOW(), NOW(), ${expiresAt})
                ON CONFLICT ("tenantId","namespace","key") DO UPDATE
                SET "value" = EXCLUDED."value", "kind" = EXCLUDED."kind", "embedding" = EXCLUDED."embedding", "updatedAt" = NOW(), "expiresAt" = EXCLUDED."expiresAt"
            `;
        } else {
            await prisma.agentMemory.upsert({
                where: { tenantId_namespace_key: { tenantId: m.tenantId, namespace, key: m.key } },
                create: { tenantId: m.tenantId, userId: m.userId, namespace, key: m.key, value: m.value, kind: m.kind, sourceThreadId: m.sourceThreadId ?? null, expiresAt },
                update: { value: m.value, kind: m.kind, expiresAt, updatedAt: new Date() },
            });
        }
    }

    async recall(p: RecallParams): Promise<MemoryHit[]> {
        const prisma = getPrismaClient();
        const limit = p.limit ?? 5;
        const nsPrefix = (p.namespacePrefix ?? []).join('/');
        const kinds = p.kinds ?? [];

        let queryVec: number[] | null = null;
        try {
            const emb = await this.getEmbeddings(p.tenantId);
            queryVec = await emb.embedQuery(p.query);
        } catch {
            // fall through to recency search
        }

        // Build the kind filter as a parameter list; empty => all kinds.
        const kindList = kinds.length ? kinds : null;

        let rows: Array<{ namespace: string; key: string; value: unknown; kind: MemoryKind }>;
        if (queryVec) {
            const vecStr = `[${queryVec.join(',')}]`;
            rows = await prisma.$queryRaw<Array<{ namespace: string; key: string; value: unknown; kind: MemoryKind }>>`
                SELECT "namespace","key","value","kind"
                FROM agent_memories
                WHERE "tenantId" = ${p.tenantId}
                  AND "supersededById" IS NULL
                  AND (${nsPrefix} = '' OR "namespace" LIKE ${nsPrefix + '%'})
                  AND (${kindList}::text[] IS NULL OR "kind"::text = ANY(${kindList}::text[]))
                ORDER BY embedding <=> ${vecStr}::vector
                LIMIT ${limit}
            `;
        } else {
            rows = await prisma.$queryRaw<Array<{ namespace: string; key: string; value: unknown; kind: MemoryKind }>>`
                SELECT "namespace","key","value","kind"
                FROM agent_memories
                WHERE "tenantId" = ${p.tenantId}
                  AND "supersededById" IS NULL
                  AND (${nsPrefix} = '' OR "namespace" LIKE ${nsPrefix + '%'})
                  AND (${kindList}::text[] IS NULL OR "kind"::text = ANY(${kindList}::text[]))
                ORDER BY "createdAt" DESC
                LIMIT ${limit}
            `;
        }

        // Reinforcement signal — best-effort, non-blocking.
        const keys = rows.map((r) => r.key);
        if (keys.length) {
            prisma.$executeRaw`
                UPDATE agent_memories SET "lastAccessedAt" = NOW(), "accessCount" = "accessCount" + 1
                WHERE "tenantId" = ${p.tenantId} AND "key" = ANY(${keys}::text[])
            `.catch(() => {});
        }

        return rows.map((r) => ({
            namespace: r.namespace,
            key: r.key,
            value: (r.value ?? {}) as Record<string, unknown>,
            kind: r.kind,
        }));
    }

    async getWorkingMemory(tenantId: string, threadId: string): Promise<WorkingMemory | null> {
        const prisma = getPrismaClient();
        const row = await prisma.agentWorkingMemory.findUnique({
            where: { tenantId_threadId: { tenantId, threadId } },
        });
        if (!row) return null;
        return {
            runningSummary: row.runningSummary,
            scratchpad: (row.scratchpad ?? {}) as unknown as Scratchpad,
            tokenCount: row.tokenCount,
            turnCount: row.turnCount,
        };
    }

    async putWorkingMemory(p: PutWorkingMemoryParams): Promise<void> {
        const prisma = getPrismaClient();
        const expiresAt = new Date(Date.now() + TTL_MS);
        await prisma.agentWorkingMemory.upsert({
            where: { tenantId_threadId: { tenantId: p.tenantId, threadId: p.threadId } },
            create: {
                tenantId: p.tenantId, threadId: p.threadId,
                runningSummary: p.wm.runningSummary,
                scratchpad: p.wm.scratchpad as unknown as object,
                tokenCount: p.wm.tokenCount, turnCount: p.wm.turnCount, expiresAt,
            },
            update: {
                runningSummary: p.wm.runningSummary,
                scratchpad: p.wm.scratchpad as unknown as object,
                tokenCount: p.wm.tokenCount, turnCount: p.wm.turnCount,
                expiresAt, updatedAt: new Date(),
            },
        });
    }
}

let _service: MemoryService | undefined;
export function getMemoryService(): MemoryService {
    if (!_service) _service = new MemoryService();
    return _service;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run lib/agent/memory/memory-service.test.ts`
Expected: PASS (both `recall` and `remember` tests green).

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/agent/memory/memory-service.ts apps/web-ui/lib/agent/memory/memory-service.test.ts
git commit -m "feat(memory): typed MemoryService (recall/remember + working-memory get/put)"
```

---

## Task 4: Config + env vars (Phase 1-G)

**Files:**
- Modify: `apps/web-ui/env.ts:82-88` (feature-flags block)
- Create: `apps/web-ui/lib/agent/memory/working-memory.ts` (config accessors only — grows in Task 5)
- Create: `apps/web-ui/lib/agent/memory/working-memory.test.ts`

**Interfaces:**
- Produces: `workingMemoryEnabled()`, `tokenBudget()`, `keepRecent()`.

- [ ] **Step 1: Add env vars**

In `apps/web-ui/env.ts`, inside the `server:` object's "Feature flags / misc" block (after `RIGHT_SIZING_ENABLED` at line ~83), add:

```typescript
        WORKING_MEMORY_ENABLED: z.string().optional(),
        WORKING_MEMORY_TOKEN_BUDGET: z.string().optional(),
        WORKING_MEMORY_KEEP_RECENT: z.string().optional(),
```

- [ ] **Step 2: Write the failing test**

Create `apps/web-ui/lib/agent/memory/working-memory.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { workingMemoryEnabled, tokenBudget, keepRecent } from './working-memory';

describe('working-memory config', () => {
    const saved = { ...process.env };
    afterEach(() => { process.env = { ...saved }; });

    it('defaults: enabled=true, budget=60000, keep=8', () => {
        delete process.env.WORKING_MEMORY_ENABLED;
        delete process.env.WORKING_MEMORY_TOKEN_BUDGET;
        delete process.env.WORKING_MEMORY_KEEP_RECENT;
        expect(workingMemoryEnabled()).toBe(true);
        expect(tokenBudget()).toBe(60000);
        expect(keepRecent()).toBe(8);
    });

    it('WORKING_MEMORY_ENABLED=false disables', () => {
        process.env.WORKING_MEMORY_ENABLED = 'false';
        expect(workingMemoryEnabled()).toBe(false);
    });

    it('reads numeric overrides', () => {
        process.env.WORKING_MEMORY_TOKEN_BUDGET = '30000';
        process.env.WORKING_MEMORY_KEEP_RECENT = '4';
        expect(tokenBudget()).toBe(30000);
        expect(keepRecent()).toBe(4);
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/agent/memory/working-memory.test.ts`
Expected: FAIL — `Cannot find module './working-memory'`.

- [ ] **Step 4: Write the config accessors**

Create `apps/web-ui/lib/agent/memory/working-memory.ts`:

```typescript
// Working-memory configuration. Read process.env directly (not the typed `env`
// object) so Vitest can mutate values per-test — env.ts skips validation under
// NODE_ENV==='test' but caches at import time.
export function workingMemoryEnabled(): boolean {
    const v = process.env.WORKING_MEMORY_ENABLED?.toLowerCase();
    return !(v === 'false' || v === '0');
}

export function tokenBudget(): number {
    const n = Number(process.env.WORKING_MEMORY_TOKEN_BUDGET);
    return Number.isFinite(n) && n > 0 ? n : 60000;
}

export function keepRecent(): number {
    const n = Number(process.env.WORKING_MEMORY_KEEP_RECENT);
    return Number.isFinite(n) && n > 0 ? n : 8;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run lib/agent/memory/working-memory.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/web-ui/env.ts apps/web-ui/lib/agent/memory/working-memory.ts apps/web-ui/lib/agent/memory/working-memory.test.ts
git commit -m "feat(memory): working-memory feature flags + config accessors"
```

---

## Task 5: Working-memory core — estimation, compression, windowing (Phase 1-D/E)

**Files:**
- Modify: `apps/web-ui/lib/agent/memory/working-memory.ts` (add estimation/compression/windowing/section)
- Modify: `apps/web-ui/lib/agent/memory/working-memory.test.ts` (add tests incl. fast-check)

**Interfaces:**
- Consumes: `types.ts` (Task 2); `BaseMessage` from `@langchain/core/messages`; `getRecentMessages` from `../agent-shared`.
- Produces: `estimateTokens`, `estimateMessagesTokens`, `compressToolOutput`, `emptyScratchpad`, `selectWindow`, `buildWorkingMemorySection`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web-ui/lib/agent/memory/working-memory.test.ts`:

```typescript
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import fc from 'fast-check';
import {
    estimateTokens, estimateMessagesTokens, compressToolOutput,
    selectWindow, buildWorkingMemorySection, emptyScratchpad,
} from './working-memory';

describe('estimateTokens', () => {
    it('is ceil(len/4)', () => {
        expect(estimateTokens('12345678')).toBe(2);
        expect(estimateTokens('123')).toBe(1);
        expect(estimateTokens('')).toBe(0);
    });
});

describe('compressToolOutput', () => {
    it('keeps head+tail with an elision marker when over the cap', () => {
        const big = 'A'.repeat(500) + 'B'.repeat(500);
        const out = compressToolOutput(big, 200);
        expect(out.length).toBeLessThan(big.length);
        expect(out).toContain('elided');
        expect(out.startsWith('A')).toBe(true);
        expect(out.endsWith('B')).toBe(true);
    });
    it('returns short content unchanged', () => {
        expect(compressToolOutput('short', 200)).toBe('short');
    });
});

describe('selectWindow', () => {
    it('always keeps at least the last `keep` messages', () => {
        const msgs = Array.from({ length: 20 }, (_, i) => new HumanMessage(`m${i}`));
        const win = selectWindow(msgs, 1, 5); // tiny budget
        expect(win.length).toBeGreaterThanOrEqual(5);
    });

    it('property: window is a recency-preserving suffix, keeps >= min(keep,n), and stays within budget once the keep-floor fits', () => {
        fc.assert(fc.property(
            fc.array(fc.string({ minLength: 1, maxLength: 400 }), { minLength: 1, maxLength: 60 }),
            fc.integer({ min: 1, max: 10 }),
            (contents, keep) => {
                // Alternate Human/AI roles + non-empty content so getRecentMessages
                // passes the slice through UNCHANGED. (Two same-role messages adjacent
                // make getRecentMessages inject a synthetic "Acknowledged." AIMessage to
                // satisfy Bedrock adjacency — that repair is getRecentMessages' concern,
                // not selectWindow's, and would grow the array out from under a suffix check.)
                const msgs = contents.map((c, i) =>
                    i % 2 === 0 ? new HumanMessage(`${i}:${c}`) : new AIMessage(`${i}:${c}`),
                );
                const budget = 5000;
                const win = selectWindow(msgs, budget, keep);

                // (1) Floor: never drops below min(keep, n) messages.
                expect(win.length).toBeGreaterThanOrEqual(Math.min(keep, msgs.length));

                // (2) Suffix: the window is exactly the last win.length messages, in order
                //     (getRecentMessages preserves order and, for these non-empty human
                //     messages, does not drop any). This is what "recency-preserving" means.
                const tail = msgs.slice(msgs.length - win.length);
                expect(win.map((m) => m.content)).toEqual(tail.map((m) => m.content));

                // (3) Budget: any message ADDED beyond the keep-floor stays within budget.
                //     (The keep-floor itself may exceed budget by design — that is allowed.)
                if (win.length > keep) {
                    expect(estimateMessagesTokens(win)).toBeLessThanOrEqual(budget);
                }
            },
        ));
    });
});

describe('buildWorkingMemorySection', () => {
    it('returns empty string for null WM', () => {
        expect(buildWorkingMemorySection(null)).toBe('');
    });
    it('renders summary + scratchpad goals', () => {
        const sec = buildWorkingMemorySection({
            runningSummary: 'Investigated ECS.',
            scratchpad: { ...emptyScratchpad(), openGoals: ['restart task'], resourceIds: ['cluster-1'] },
            tokenCount: 100, turnCount: 3,
        });
        expect(sec).toContain('## Working Memory');
        expect(sec).toContain('Investigated ECS.');
        expect(sec).toContain('restart task');
        expect(sec).toContain('cluster-1');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web-ui && bunx vitest run lib/agent/memory/working-memory.test.ts`
Expected: FAIL — the new named exports do not exist yet.

- [ ] **Step 3: Implement the functions**

Append to `apps/web-ui/lib/agent/memory/working-memory.ts` (add imports at top):

```typescript
import type { BaseMessage } from '@langchain/core/messages';
import { getRecentMessages } from '../agent-shared';
import type { Scratchpad, WorkingMemory } from './types';

export function emptyScratchpad(): Scratchpad {
    return { openGoals: [], keyFindings: [], resourceIds: [], pendingSteps: [] };
}

export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

function messageText(m: BaseMessage): string {
    return typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
}

export function estimateMessagesTokens(messages: BaseMessage[]): number {
    return messages.reduce((sum, m) => sum + estimateTokens(messageText(m)), 0);
}

export function compressToolOutput(content: string, maxChars = 2000): string {
    if (content.length <= maxChars) return content;
    const half = Math.floor(maxChars / 2);
    const head = content.slice(0, half);
    const tail = content.slice(content.length - half);
    return `${head}\n… [${content.length - maxChars} chars elided] …\n${tail}`;
}

// Pick the most-recent messages that fit `budget` tokens, always keeping at least
// `keep` of them, then run getRecentMessages() to preserve tool_call/tool_result
// pairing and drop empties (Bedrock adjacency rules).
export function selectWindow(messages: BaseMessage[], budget: number, keep: number): BaseMessage[] {
    if (messages.length === 0) return [];
    let count = Math.min(keep, messages.length);
    let used = estimateMessagesTokens(messages.slice(messages.length - count));
    for (let i = messages.length - count - 1; i >= 0; i--) {
        const t = estimateTokens(messageText(messages[i]));
        if (used + t > budget) break;
        used += t;
        count++;
    }
    const slice = messages.slice(messages.length - count);
    return getRecentMessages(slice, slice.length);
}

export function buildWorkingMemorySection(wm: WorkingMemory | null): string {
    if (!wm) return '';
    const s = wm.scratchpad ?? emptyScratchpad();
    const list = (label: string, items: string[]) =>
        items && items.length ? `\n**${label}:**\n${items.map((i) => `- ${i}`).join('\n')}` : '';
    const body = [
        wm.runningSummary ? `\n${wm.runningSummary}` : '',
        list('Open goals', s.openGoals),
        list('Key findings', s.keyFindings),
        list('Resource IDs', s.resourceIds),
        list('Pending steps', s.pendingSteps),
    ].join('');
    if (!body.trim()) return '';
    return `\n## Working Memory\nA compacted record of this long-running session so far:${body}\n`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web-ui && bunx vitest run lib/agent/memory/working-memory.test.ts`
Expected: PASS (all config + core tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/agent/memory/working-memory.ts apps/web-ui/lib/agent/memory/working-memory.test.ts
git commit -m "feat(memory): token estimation, tool-log compression, budget windowing, WM section"
```

---

## Task 6: `ReflectionState` + graph channels (Phase 1-F)

**Files:**
- Modify: `apps/web-ui/lib/agent/agent-shared.ts:63-76` (ReflectionState) and `:79-133` (graphState channels)

**Interfaces:**
- Consumes: `Scratchpad` from `./memory/types`.
- Produces: `ReflectionState.runningSummary: string`, `ReflectionState.scratchpad: Scratchpad`; matching channels.

- [ ] **Step 1: Import the Scratchpad type**

At the top of `apps/web-ui/lib/agent/agent-shared.ts`, add:

```typescript
import type { Scratchpad } from "./memory/types";
```

- [ ] **Step 2: Extend `ReflectionState`**

In the `ReflectionState` interface (ends at line ~76), add two fields after `memoryContext: string;`:

```typescript
    runningSummary: string; // Phase 1: rolling summary of compacted turns
    scratchpad: Scratchpad; // Phase 1: structured working-memory scratchpad
```

- [ ] **Step 3: Add channel reducers**

In `graphState` (after the `memoryContext` channel, before the closing `};` at line ~133), add:

```typescript
    runningSummary: {
        reducer: (x: string, y: string) => y || x,
        default: () => "",
    },
    scratchpad: {
        reducer: (x: Scratchpad, y: Scratchpad) => y || x,
        default: () => ({ openGoals: [], keyFindings: [], resourceIds: [], pendingSteps: [] }),
    },
```

- [ ] **Step 4: Verify typecheck (agent-shared has no isolated unit test)**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep "agent-shared.ts" || echo "no errors in agent-shared.ts"`
Expected: `no errors in agent-shared.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/agent/agent-shared.ts
git commit -m "feat(memory): add runningSummary + scratchpad to agent state"
```

---

## Task 7: `prepareContext` — compaction orchestrator (Phase 1-D/E/F)

**Files:**
- Modify: `apps/web-ui/lib/agent/memory/working-memory.ts` (add `foldWorkingMemory` + `prepareContext`)
- Modify: `apps/web-ui/lib/agent/memory/working-memory.test.ts` (add orchestrator tests)

**Interfaces:**
- Consumes: `ReflectionState` from `../agent-shared` (Task 6); `getMemoryService` from `./memory-service` (Task 3); `BaseChatModel` from `@langchain/core/language_models/chat_models`; `SystemMessage`/`HumanMessage`.
- Produces: `PrepareContextDeps`, `PreparedContext`, `prepareContext(state, deps, fallbackWindow)`, `foldWorkingMemory(prev, evicted, reflectorModel)`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web-ui/lib/agent/memory/working-memory.test.ts`:

```typescript
import { prepareContext, foldWorkingMemory } from './working-memory';
import type { ReflectionState } from '../agent-shared';

function baseState(messages: any[]): ReflectionState {
    return {
        messages, taskDescription: 't', plan: [], code: '', executionOutput: '',
        errors: [], reflection: '', iterationCount: 0, nextAction: 'plan',
        isComplete: false, toolResults: [], memoryContext: '',
        runningSummary: '', scratchpad: { openGoals: [], keyFindings: [], resourceIds: [], pendingSteps: [] },
    };
}

const fakeReflector = {
    invoke: async () => ({
        content: JSON.stringify({
            summary: 'Restarted the stuck ECS task.',
            scratchpad: { openGoals: ['verify health'], keyFindings: ['task was OOM'], resourceIds: ['svc-1'], pendingSteps: [] },
        }),
    }),
} as any;

describe('prepareContext', () => {
    afterEach(() => { delete process.env.WORKING_MEMORY_ENABLED; delete process.env.WORKING_MEMORY_TOKEN_BUDGET; });

    it('disabled → falls back to getRecentMessages(fallbackWindow), no WM section, no LLM call', async () => {
        process.env.WORKING_MEMORY_ENABLED = 'false';
        const msgs = Array.from({ length: 30 }, (_, i) => new HumanMessage(`m${i}`));
        const res = await prepareContext(baseState(msgs), { reflectorModel: fakeReflector }, 20);
        expect(res.workingMemorySection).toBe('');
        expect(res.stateUpdate).toEqual({});
        expect(res.windowMessages.length).toBeLessThanOrEqual(20);
    });

    it('enabled + under budget → no compaction, no LLM call, empty stateUpdate', async () => {
        process.env.WORKING_MEMORY_TOKEN_BUDGET = '100000';
        const msgs = [new HumanMessage('hi'), new AIMessage('hello')];
        const res = await prepareContext(baseState(msgs), { reflectorModel: fakeReflector }, 20);
        expect(res.stateUpdate).toEqual({});
        expect(res.windowMessages.length).toBe(2);
    });

    it('enabled + over budget → folds evicted turns into summary + scratchpad', async () => {
        process.env.WORKING_MEMORY_TOKEN_BUDGET = '10'; // force compaction
        const msgs = Array.from({ length: 12 }, (_, i) => new HumanMessage('X'.repeat(80) + i));
        const res = await prepareContext(baseState(msgs), { reflectorModel: fakeReflector }, 20);
        expect(res.workingMemorySection).toContain('## Working Memory');
        expect(res.workingMemorySection).toContain('Restarted the stuck ECS task.');
        expect(res.stateUpdate.runningSummary).toContain('Restarted');
        expect(res.stateUpdate.scratchpad?.openGoals).toContain('verify health');
    });
});

describe('foldWorkingMemory monotonicity', () => {
    it('never drops a pre-existing open goal', async () => {
        const prev = {
            runningSummary: 'prior', tokenCount: 0, turnCount: 1,
            scratchpad: { openGoals: ['KEEP ME'], keyFindings: [], resourceIds: [], pendingSteps: [] },
        };
        const next = await foldWorkingMemory(prev, [new HumanMessage('did stuff')], fakeReflector);
        expect(next.scratchpad.openGoals).toContain('KEEP ME');   // merged, not replaced
        expect(next.scratchpad.openGoals).toContain('verify health'); // plus the new one
        expect(next.turnCount).toBe(2);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web-ui && bunx vitest run lib/agent/memory/working-memory.test.ts`
Expected: FAIL — `prepareContext`/`foldWorkingMemory` not exported.

- [ ] **Step 3: Implement `foldWorkingMemory` + `prepareContext`**

Append to `apps/web-ui/lib/agent/memory/working-memory.ts` (add imports at top):

```typescript
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ReflectionState } from "../agent-shared";
import { getMemoryService } from "./memory-service";

function uniq(a: string[]): string[] { return Array.from(new Set(a.filter(Boolean))); }

function mergeScratchpad(prev: Scratchpad, next: Partial<Scratchpad>): Scratchpad {
    return {
        openGoals: uniq([...(prev.openGoals ?? []), ...(next.openGoals ?? [])]),
        keyFindings: uniq([...(prev.keyFindings ?? []), ...(next.keyFindings ?? [])]),
        resourceIds: uniq([...(prev.resourceIds ?? []), ...(next.resourceIds ?? [])]),
        pendingSteps: uniq([...(prev.pendingSteps ?? []), ...(next.pendingSteps ?? [])]),
    };
}

// Fold evicted turns into the running summary + scratchpad using the reflector
// model. Monotonicity (never lose a recorded goal/finding) is enforced in code by
// MERGING the LLM output with the prior scratchpad — we do not trust the LLM to
// carry everything forward.
export async function foldWorkingMemory(
    prev: WorkingMemory,
    evicted: BaseMessage[],
    reflectorModel: BaseChatModel,
): Promise<WorkingMemory> {
    const transcript = evicted
        .map((m) => `[${m._getType()}] ${compressToolOutput(messageText(m), 1200)}`)
        .join('\n\n');

    const sys = new SystemMessage(
        `You compress a long-running agent session into durable working memory. ` +
        `Given the prior summary/scratchpad and newly-evicted turns, return ONLY a JSON object:\n` +
        `{"summary": string, "scratchpad": {"openGoals": string[], "keyFindings": string[], "resourceIds": string[], "pendingSteps": string[]}}\n` +
        `- summary: a concise cumulative narrative (fold the new turns into the prior summary).\n` +
        `- scratchpad: only NEW items discovered in the evicted turns (prior items are preserved automatically).\n` +
        `Never fabricate. Return the JSON object and nothing else.`,
    );
    const input = new HumanMessage(
        `**Prior summary:**\n${prev.runningSummary || '(none)'}\n\n` +
        `**Prior open goals:** ${JSON.stringify(prev.scratchpad?.openGoals ?? [])}\n\n` +
        `**Newly evicted turns:**\n${compressToolOutput(transcript, 8000)}`,
    );

    let summary = prev.runningSummary;
    let newSp: Partial<Scratchpad> = {};
    try {
        const resp = await reflectorModel.invoke([sys, input]);
        const content = typeof resp.content === 'string' ? resp.content : JSON.stringify(resp.content);
        const match = content.match(/\{[\s\S]*\}/);
        if (match) {
            const parsed = JSON.parse(match[0]) as { summary?: string; scratchpad?: Partial<Scratchpad> };
            if (parsed.summary) summary = parsed.summary;
            if (parsed.scratchpad) newSp = parsed.scratchpad;
        }
    } catch {
        // Folding failure is non-fatal — keep the prior summary, still advance turnCount.
    }

    return {
        runningSummary: summary,
        scratchpad: mergeScratchpad(prev.scratchpad ?? emptyScratchpad(), newSp),
        tokenCount: 0,
        turnCount: (prev.turnCount ?? 0) + 1,
    };
}

export interface PrepareContextDeps {
    reflectorModel: BaseChatModel;
    tenantId?: string;
    threadId?: string;
}
export interface PreparedContext {
    windowMessages: BaseMessage[];
    workingMemorySection: string;
    stateUpdate: Partial<Pick<ReflectionState, 'runningSummary' | 'scratchpad'>>;
}

export async function prepareContext(
    state: ReflectionState,
    deps: PrepareContextDeps,
    fallbackWindow: number,
): Promise<PreparedContext> {
    const { messages } = state;

    // Disabled → identical to legacy behavior.
    if (!workingMemoryEnabled()) {
        return {
            windowMessages: getRecentMessages(messages, fallbackWindow),
            workingMemorySection: '',
            stateUpdate: {},
        };
    }

    const budget = tokenBudget();
    const keep = keepRecent();
    const total = estimateMessagesTokens(messages);

    const currentWm: WorkingMemory = {
        runningSummary: state.runningSummary ?? '',
        scratchpad: state.scratchpad ?? emptyScratchpad(),
        tokenCount: total,
        turnCount: 0,
    };

    // Under budget → no compaction; surface any existing WM from state.
    if (total <= budget) {
        const hasWm = currentWm.runningSummary || (currentWm.scratchpad.openGoals?.length ?? 0) > 0;
        return {
            windowMessages: selectWindow(messages, budget, keep),
            workingMemorySection: hasWm ? buildWorkingMemorySection(currentWm) : '',
            stateUpdate: {},
        };
    }

    // Over budget → fold the evicted prefix into working memory.
    const window = selectWindow(messages, budget, keep);
    const evicted = messages.slice(0, Math.max(0, messages.length - window.length));
    const folded = evicted.length
        ? await foldWorkingMemory(currentWm, evicted, deps.reflectorModel)
        : currentWm;

    // Durable mirror (best-effort; checkpoint state is the source of truth).
    if (deps.tenantId && deps.threadId) {
        getMemoryService()
            .putWorkingMemory({ tenantId: deps.tenantId, threadId: deps.threadId, wm: folded })
            .catch(() => {});
    }

    return {
        windowMessages: window,
        workingMemorySection: buildWorkingMemorySection(folded),
        stateUpdate: { runningSummary: folded.runningSummary, scratchpad: folded.scratchpad },
    };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web-ui && bunx vitest run lib/agent/memory/working-memory.test.ts`
Expected: PASS (config + core + orchestrator + monotonicity).

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/agent/memory/working-memory.ts apps/web-ui/lib/agent/memory/working-memory.test.ts
git commit -m "feat(memory): prepareContext compaction orchestrator + monotonic summary folding"
```

---

## Task 8: Wire working memory into the fast agent (Phase 1)

**Files:**
- Modify: `apps/web-ui/lib/agent/fast-agent.ts:72-126` (agentNode) and `:292-350` (finalizeNode)

**Interfaces:**
- Consumes: `prepareContext`, `PrepareContextDeps` from `./memory/working-memory` (Task 7).

- [ ] **Step 1: Import and build WM deps**

In `apps/web-ui/lib/agent/fast-agent.ts`, add to the imports:

```typescript
import { prepareContext } from "./memory/working-memory";
```

After the memory-nodes wiring (around line 67, after `memorySaveNode`), add:

```typescript
    // Working-memory deps — threadId is read per-node from the runtime config.
    const wmDeps = { reflectorModel, tenantId, userId: config.userId };
```

- [ ] **Step 2: Change `agentNode` to accept runtime config and use `prepareContext`**

Change the signature at line ~72 from `async function agentNode(state: ReflectionState)` to:

```typescript
    async function agentNode(state: ReflectionState, runtimeConfig?: any): Promise<Partial<ReflectionState>> {
```

Replace the `const recentMessages = getRecentMessages(messages, 20);` line (~108) and the two lines around it with:

```typescript
        const threadId = runtimeConfig?.configurable?.thread_id as string | undefined;
        const { windowMessages, workingMemorySection, stateUpdate } =
            await prepareContext(state, { ...wmDeps, threadId }, 20);

        const safeMessages = sanitizeMessagesForBedrock(windowMessages);
```

In the `systemPrompt` template (the `new SystemMessage(...)` at ~86), insert `${workingMemorySection}` on the line directly after `${memorySection}`:

```typescript
${memorySection}
${workingMemorySection}
## Conversation Continuity
```

Change the node's return (line ~122) to merge the WM state update:

```typescript
        return {
            messages: [tagMessagePhase(response, 'execution')],
            iterationCount: iterationCount + 1,
            ...stateUpdate,
        };
```

- [ ] **Step 3: Inject the WM section into `finalizeNode` too**

`finalizeNode` builds its own system prompt from plain text (no message window), so it only needs the WM section for continuity. At the top of `finalizeNode` (~293), after destructuring state, add:

```typescript
        const { runningSummary, scratchpad } = state;
        const workingMemorySection = buildWorkingMemorySection(
            runningSummary || (scratchpad?.openGoals?.length ?? 0) > 0
                ? { runningSummary: runningSummary ?? '', scratchpad: scratchpad ?? { openGoals: [], keyFindings: [], resourceIds: [], pendingSteps: [] }, tokenCount: 0, turnCount: 0 }
                : null,
        );
```

Add `buildWorkingMemorySection` to the import from `./memory/working-memory`:

```typescript
import { prepareContext, buildWorkingMemorySection } from "./memory/working-memory";
```

In the `finalizeSystemPrompt` template (~322), insert `${workingMemorySection}` after `${memorySection}`.

- [ ] **Step 4: Typecheck**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep "fast-agent.ts" || echo "no errors in fast-agent.ts"`
Expected: `no errors in fast-agent.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/agent/fast-agent.ts
git commit -m "feat(memory): wire working-memory compaction into the fast agent"
```

---

## Task 9: Wire working memory into the planning agent (Phase 1)

**Files:**
- Modify: `apps/web-ui/lib/agent/planning-agent.ts` (imports; 3 window call sites at ~205, ~493, and the planner prompt at ~73/166)

**Interfaces:**
- Consumes: `prepareContext`, `buildWorkingMemorySection` from `./memory/working-memory`.

- [ ] **Step 1: Import + WM deps**

Add to imports:

```typescript
import { prepareContext, buildWorkingMemorySection } from "./memory/working-memory";
```

After the memory-nodes wiring (~67), add:

```typescript
    const wmDeps = { reflectorModel, tenantId, userId: config.userId };
```

- [ ] **Step 2: Executor node — replace the window at ~205**

Locate the node whose body contains `const recentMessages = getRecentMessages(messages, 15);`. Change its signature to accept `runtimeConfig?: any` as the 2nd arg, and replace that line with:

```typescript
        const threadId = runtimeConfig?.configurable?.thread_id as string | undefined;
        const { windowMessages, workingMemorySection, stateUpdate } =
            await prepareContext(state, { ...wmDeps, threadId }, 15);
        const recentMessages = windowMessages;
```

Insert `${workingMemorySection}` into that node's system-prompt template (right after the existing `${memoryContext ? ... : ''}` fragment), and merge `...stateUpdate` into the node's returned object.

- [ ] **Step 3: Second window call site at ~493**

Locate the node containing `const recentMessages = getRecentMessages(messages, 10);`. Change its signature to accept `runtimeConfig?: any`, and replace that line with:

```typescript
        const threadId = runtimeConfig?.configurable?.thread_id as string | undefined;
        const { windowMessages, workingMemorySection, stateUpdate } =
            await prepareContext(state, { ...wmDeps, threadId }, 10);
        const recentMessages = windowMessages;
```

Insert `${workingMemorySection}` into that node's system-prompt template after the memory fragment, and merge `...stateUpdate` into its return.

- [ ] **Step 4: Planner node — surface WM (no window there)**

In the planner node (~73) and any node that builds a prompt from `memoryContext` but does NOT call `getRecentMessages` (~166), add near the top after destructuring:

```typescript
        const workingMemorySection = buildWorkingMemorySection(
            state.runningSummary || (state.scratchpad?.openGoals?.length ?? 0) > 0
                ? { runningSummary: state.runningSummary ?? '', scratchpad: state.scratchpad ?? { openGoals: [], keyFindings: [], resourceIds: [], pendingSteps: [] }, tokenCount: 0, turnCount: 0 }
                : null,
        );
```

and insert `${workingMemorySection}` into that node's system-prompt template after the `${memoryContext ? ... : ''}` fragment.

- [ ] **Step 5: Typecheck**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep "planning-agent.ts" || echo "no errors in planning-agent.ts"`
Expected: `no errors in planning-agent.ts`.

- [ ] **Step 6: Commit**

```bash
git add apps/web-ui/lib/agent/planning-agent.ts
git commit -m "feat(memory): wire working-memory compaction into the planning agent"
```

---

## Task 10: MemoryService delegation shim + typed recall/save (Phase 0-C)

**Files:**
- Modify: `apps/web-ui/lib/agent/persistence.ts:109-206` (`PostgresMemoryStore.batch` delegates) + helper functions
- Modify: `apps/web-ui/lib/agent/memory-nodes.ts:21-215` (recall/save via MemoryService, kind-aware)

**Interfaces:**
- Consumes: `getMemoryService`, `MemoryHit` from `./memory/memory-service` + `./memory/types`.

- [ ] **Step 1: Route `saveMemory`/`searchMemory` helpers through `MemoryService`**

In `apps/web-ui/lib/agent/persistence.ts`, add import at top:

```typescript
import { getMemoryService } from "./memory/memory-service";
```

Replace the body of `saveMemory` (~260) so it delegates (default kind SEMANTIC preserves current behavior):

```typescript
export async function saveMemory(
    tenantId: string,
    userId: string,
    namespace: string[],
    key: string,
    value: Record<string, unknown>
): Promise<void> {
    await getMemoryService().remember({ tenantId, userId, kind: 'SEMANTIC', namespace, key, value });
}
```

Replace the body of `searchMemory` (~274) so it delegates and preserves the `{ key, value, namespace }[]` return shape existing callers expect:

```typescript
export async function searchMemory(
    tenantId: string,
    userId: string,
    namespacePrefix: string[],
    query: string,
    limit = 5
): Promise<unknown[]> {
    const hits = await getMemoryService().recall({ tenantId, userId, query, namespacePrefix, limit });
    return hits.map((h) => ({ key: h.key, value: h.value, namespace: h.namespace }));
}
```

Leave `PostgresMemoryStore` (used as the LangGraph `store` for the deep-agent tools) intact — it still works. This keeps deep-agent untouched while unifying the app-facing helpers on `MemoryService`.

- [ ] **Step 2: Make `memory-nodes.ts` recall kind-aware (optional filter, same default behavior)**

In `apps/web-ui/lib/agent/memory-nodes.ts`, the recall node already calls `searchMemory(tenantId, userId, [], query, 10)`, which now flows through `MemoryService` — no change needed for behavior. Add a clarifying comment above that call (~45):

```typescript
        // Recall spans all memory kinds (SEMANTIC today; EPISODIC/PROCEDURAL in later phases).
```

The save node keeps writing SEMANTIC facts via `saveMemory` (now delegating). No behavioral change — this task is the plumbing swap that later phases build on.

- [ ] **Step 3: Run the existing agent tests to confirm no regressions**

Run: `cd apps/web-ui && bunx vitest run lib/agent/memory/ 2>&1 | tail -20`
Expected: all memory-module tests PASS. (Pre-existing unrelated failures elsewhere in the suite, per project notes, are out of scope — do not fix here.)

- [ ] **Step 4: Typecheck**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "persistence.ts|memory-nodes.ts" || echo "no errors"`
Expected: `no errors`.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/agent/persistence.ts apps/web-ui/lib/agent/memory-nodes.ts
git commit -m "refactor(memory): route saveMemory/searchMemory through MemoryService"
```

---

## Task 11: Expose `kind` on the Memory-module record (Phase 0-A)

**Files:**
- Modify: `apps/web-ui/lib/db/repositories/agent-memory/interface.ts:3-18` (add `kind`)
- Modify: `apps/web-ui/lib/db/repositories/agent-memory/postgres.ts:12-48` (map `kind`)

**Interfaces:**
- Consumes: `MemoryKind` from `@/lib/agent/memory/types`.
- Produces: `AgentMemoryRecord.kind: MemoryKind`.

- [ ] **Step 1: Add `kind` to the record type**

In `interface.ts`, add the import and field:

```typescript
import type { MemoryKind } from '@/lib/agent/memory/types';
```

In `AgentMemoryRecord`, after `category: MemoryCategory;` add:

```typescript
    kind: MemoryKind;
```

- [ ] **Step 2: Map `kind` in the repository**

In `postgres.ts`, extend the `MemoryRow` type with `kind: MemoryKind;` (add the import `import type { MemoryKind } from '@/lib/agent/memory/types';`), and in `toRecord` add `kind: row.kind,` to the returned object.

- [ ] **Step 3: Verify the Memory-module repo test still passes**

Run: `cd apps/web-ui && bunx vitest run lib/db/repositories/agent-memory/postgres.test.ts`
Expected: PASS (existing tests still green; `kind` now present on records).

- [ ] **Step 4: Typecheck**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep "agent-memory" || echo "no errors"`
Expected: `no errors`.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/db/repositories/agent-memory/interface.ts apps/web-ui/lib/db/repositories/agent-memory/postgres.ts
git commit -m "feat(memory): surface memory kind on Memory-module records"
```

---

## Task 12: Full verification + docs

**Files:**
- Modify: `CLAUDE.md` (Agent Architecture section — one line on working memory) — only if it does not conflict with the GSD-generated lower half.

- [ ] **Step 1: Run the whole web-ui memory test suite**

Run: `cd apps/web-ui && bunx vitest run lib/agent/memory/ lib/db/repositories/agent-memory/`
Expected: all PASS.

- [ ] **Step 2: Full typecheck**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "lib/agent/memory|working-memory|memory-service|fast-agent|planning-agent|persistence|memory-nodes|agent-shared" || echo "no errors in touched files"`
Expected: `no errors in touched files`.

- [ ] **Step 3: Lint the touched files**

Run: `cd apps/web-ui && bun run lint 2>&1 | grep -E "memory|agent" || echo "no lint errors in touched files"`
Expected: `no lint errors in touched files`.

- [ ] **Step 4: Manual long-run smoke (dev server)**

Run: `cd apps/web-ui && WORKING_MEMORY_TOKEN_BUDGET=2000 bun run dev` then start a fast-agent chat that produces a long tool-heavy transcript.
Expected in server logs: after the transcript grows past the budget, the agent still responds coherently, references earlier findings, and no context-overflow error occurs. (Set the budget low to force compaction quickly.)

- [ ] **Step 5: Note the new env vars in `.env.example`**

Add to the root `.env.example` under a "Working memory (Phase 1)" comment:

```
# Working memory — in-session compaction for long-running agents
WORKING_MEMORY_ENABLED=true
WORKING_MEMORY_TOKEN_BUDGET=60000
WORKING_MEMORY_KEEP_RECENT=8
```

- [ ] **Step 6: Commit**

```bash
git add .env.example CLAUDE.md
git commit -m "docs(memory): document working-memory env vars"
```

---

## Self-Review (completed against the spec)

- **Spec A (schema evolution):** Task 1 (enum, columns, WM table) + Task 11 (expose `kind`). ✅
- **Spec B (HNSW index):** Task 1 Step 6. ✅
- **Spec C (MemoryService + delegation shim):** Tasks 2, 3, 10. ✅
- **Spec D (compaction):** Task 7 (`foldWorkingMemory`) + Task 5 (compression). ✅
- **Spec E (budget-aware assembly):** Task 5 (`selectWindow`) + Tasks 8, 9 (wiring). ✅
- **Spec F (checkpoint-live + table snapshot):** Task 6 (state fields) + Task 7 (`putWorkingMemory` mirror). ✅
- **Spec G (config/env):** Task 4. ✅
- **Testing (Vitest + fast-check budget/monotonicity):** Tasks 3, 4, 5, 7. ✅
- **Migration verify:** Task 1 Step 9. ✅
- **Non-goals honored:** deep-agent untouched (Task 10 explicitly leaves `PostgresMemoryStore` intact); no conflict-resolution/episodic/procedural *logic* — only scaffolding columns. ✅
- **Type consistency:** `MemoryKind`, `Scratchpad`, `WorkingMemory`, `PreparedContext`, `prepareContext(state, deps, fallbackWindow)`, `getMemoryService()` used identically across Tasks 2–11. ✅
