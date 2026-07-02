# Agent Memory Phase 2 — Semantic Conflict Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inline Mem0-style reconciliation at memory-save time — extract → neighbor fetch → batched LLM judge (ADD/UPDATE/SUPERSEDE/REINFORCE/NOOP) → apply with an auditable supersede trail — so the memory store stays accurate as it grows.

**Architecture:** A partial unique index (live rows only) replaces the full `(tenantId, namespace, key)` unique constraint so a superseded row and its same-key successor coexist. `MemoryService` stays a pure data layer and gains primitives (`remember` returns id; `recall` returns id+distance; new `update`/`supersede`/`reinforce`). A new `reconcile.ts` holds the policy: per-fact neighbor fetch with a distance threshold, one batched judge call on the reflector model, per-fact apply with ADD fallback on any failure. `memorySaveNode` routes through it behind `MEMORY_RECONCILE_ENABLED` (default true; off = today's direct-save loop).

**Tech Stack:** TypeScript 5, Prisma (dual client), PostgreSQL + pgvector, LangGraph JS, Vitest.

## Global Constraints

- **Prisma dual-client:** after any `schema.prisma` change, regenerate BOTH clients — `cd apps/web-ui && bun run db:generate` AND `cd apps/workers && bun run db:generate`.
- **Multi-tenant safety:** every query scoped by `tenantId`. Raw `$queryRaw`/`$executeRaw` are NOT tenant-intercepted — bind `tenantId` explicitly. ORM writes by id use `updateMany({ where: { id, tenantId } })` (same pattern as the repo's `deleteById`).
- **Embeddings:** provider-only via `getTenantEmbeddings(tenantId)`; embedding failure is NON-FATAL everywhere (store/update without vector; recall falls back to recency).
- **Non-fatal reconciliation:** `reconcileMemories` never throws; judge/parse/validation failure degrades to ADD (today's behavior); one bad fact never blocks siblings.
- **Feature gate:** `MEMORY_RECONCILE_ENABLED` read from `process.env` (accessor pattern of `working-memory.ts`); default true; `'false'`/`'0'` disables. Off = byte-for-byte legacy save loop.
- **Judge model:** the agent's existing `reflectorModel`, passed in as a param — never instantiate a model.
- **SUPERSEDE policy:** explicit contradiction only; never delete the old row (set `supersededById`/`supersededAt`).
- **Deep-agent untouched behaviorally:** `PostgresMemoryStore.batch()` gets ONLY the conflict-target SQL edit (required by the index change); no reconcile there.
- **Migrations:** `prisma migrate dev` is unusable non-interactively in this environment (known) — hand-author `migration.sql` and apply with `prisma migrate deploy`. Local DB: container `nucleus-postgres`, user `nucleus`, db `nucleus`.
- **Style:** named exports, 4-space indent in `lib/` files, `@/` alias for cross-dir imports.
- **Known tsc baseline (do not fix, do not count as new):** `fast-agent.ts`/`planning-agent.ts` store→BaseStore compile errors; `agent-shared.ts:530-531`; `persistence.ts` PostgresChatHistory/PostgresMemoryStore JSON errors.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `libs/prisma/schema.prisma` + new migration | drop compound unique → regular index + raw-SQL partial unique (live rows) |
| `apps/web-ui/lib/agent/memory/types.ts` | `MemoryHit` gains `id`/`distance?`; new `ExtractedFact`, `ReconcileAction`, `ReconcileDecision`, `ReconcileSummary` |
| `apps/web-ui/lib/agent/memory/memory-service.ts` | `remember` returns id + new conflict target + ORM-fallback rework; `recall` returns id+distance; new `update`/`supersede`/`reinforce` |
| `apps/web-ui/lib/agent/memory/memory-service.test.ts` | updated + new primitive tests |
| `apps/web-ui/lib/agent/memory/reconcile.ts` | **new** — constants, `reconcileEnabled`, judge prompt, `reconcileMemories` |
| `apps/web-ui/lib/agent/memory/reconcile.test.ts` | **new** — fake judge + mocked service tests |
| `apps/web-ui/lib/agent/memory-nodes.ts` | `memorySaveNode` routes through reconcile behind the flag; gains `runtimeConfig` for threadId |
| `apps/web-ui/lib/agent/persistence.ts` | `PostgresMemoryStore.batch()` conflict-target edit (1 line) |
| `apps/web-ui/env.ts` | `MEMORY_RECONCILE_ENABLED` |
| `.env.example` | document the flag |
| `apps/web-ui/lib/db/repositories/agent-memory/{interface,postgres}.ts` (+test) | hide superseded in list; expose supersede fields |
| `apps/web-ui/lib/queries/agent-memories.ts` | `MemoryRow` gains supersede fields |
| `apps/web-ui/components/memory/memory-detail-dialog.tsx` | provenance row |
| `CLAUDE.md` | one table row for reconcile.ts |

## Interfaces (locked — every task must match)

```typescript
// types.ts additions
export interface MemoryHit {
    id: string;                        // NEW
    namespace: string;
    key: string;
    value: Record<string, unknown>;
    kind: MemoryKind;
    distance?: number;                 // NEW — cosine distance, only on vector-search hits
}
export interface ExtractedFact { namespace: string[]; key: string; value: SemanticValue; }
export type ReconcileAction = 'ADD' | 'UPDATE' | 'SUPERSEDE' | 'REINFORCE' | 'NOOP';
export interface ReconcileDecision {
    factIndex: number;
    action: ReconcileAction;
    targetId?: string;                 // UPDATE / SUPERSEDE / REINFORCE
    mergedValue?: Record<string, unknown>; // UPDATE only
}
export interface ReconcileSummary { added: number; updated: number; superseded: number; reinforced: number; noop: number; failed: number; }

// memory-service.ts
remember(m: RememberParams): Promise<string>;                                   // now returns row id
update(tenantId: string, id: string, value: Record<string, unknown>): Promise<void>;
supersede(tenantId: string, oldId: string, newId: string): Promise<void>;
reinforce(tenantId: string, id: string): Promise<void>;

// reconcile.ts
export const RECONCILE_TOP_K = 5;
export const RECONCILE_DISTANCE_THRESHOLD = 0.55;
export function reconcileEnabled(): boolean;
export async function reconcileMemories(params: {
    tenantId: string; userId: string; facts: ExtractedFact[];
    judgeModel: BaseChatModel; sourceThreadId?: string;
}): Promise<ReconcileSummary>;
```

---

## Task 1: Partial unique index migration + upsert-site compatibility

All three upsert sites and the migration land in ONE commit — old conflict-target SQL fails at runtime against the new index ("no unique or exclusion constraint matching the ON CONFLICT specification"), so they must move together.

**Files:**
- Modify: `libs/prisma/schema.prisma` (AgentMemory `@@unique` → `@@index`)
- Create: `libs/prisma/migrations/<timestamp>_agent_memory_partial_unique/migration.sql`
- Modify: `apps/web-ui/lib/agent/memory/memory-service.ts:45-74` (remember)
- Modify: `apps/web-ui/lib/agent/persistence.ts:136-141` (batch conflict target)
- Modify: `apps/web-ui/lib/agent/memory/memory-service.test.ts` (remember test)

**Interfaces:**
- Produces: partial unique index `agent_memories_live_tenant_ns_key`; `remember(): Promise<string>` (returns row id).

- [ ] **Step 1: Schema edit**

In `libs/prisma/schema.prisma`, in `model AgentMemory`, replace the line
`  @@unique([tenantId, namespace, key])` with:

```prisma
  @@index([tenantId, namespace, key])
```

(The uniqueness guarantee moves to a partial index that Prisma cannot express — created in Step 2.)

- [ ] **Step 2: Hand-author the migration**

```bash
cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/agent-memory
MIG="libs/prisma/migrations/$(date +%Y%m%d%H%M%S)_agent_memory_partial_unique"
mkdir -p "$MIG"
```

Write `$MIG/migration.sql` with exactly:

```sql
-- Replace the full unique constraint with a live-rows-only partial unique index so a
-- superseded row and its same-key successor can coexist (supersede audit trail).
-- Index name verified in DB: agent_memories_tenantId_namespace_key_key
DROP INDEX "agent_memories_tenantId_namespace_key_key";

-- Plain index for lookup performance (mirrors the schema's @@index).
CREATE INDEX "agent_memories_tenantId_namespace_key_idx"
  ON "agent_memories"("tenantId", "namespace", "key");

-- Uniqueness applies to LIVE rows only.
CREATE UNIQUE INDEX "agent_memories_live_tenant_ns_key"
  ON "agent_memories" ("tenantId", "namespace", "key")
  WHERE "supersededById" IS NULL;
```

- [ ] **Step 3: Rewrite `MemoryService.remember` (new conflict target + returns id + ORM fallback rework)**

Replace the entire `remember` method with:

```typescript
    async remember(m: RememberParams): Promise<string> {
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
            // $queryRaw is NOT tenant-intercepted — tenantId is bound explicitly.
            // The conflict target names the PARTIAL unique index (live rows only), so a
            // superseded row with the same key never blocks inserting its successor.
            const rows = await prisma.$queryRaw<Array<{ id: string }>>`
                INSERT INTO agent_memories ("id","tenantId","userId","namespace","key","value","kind","embedding","sourceThreadId","createdAt","updatedAt","expiresAt")
                VALUES (gen_random_uuid()::text, ${m.tenantId}, ${m.userId}, ${namespace}, ${m.key}, ${JSON.stringify(m.value)}::jsonb, ${m.kind}::"MemoryKind", ${vecStr}::vector, ${m.sourceThreadId ?? null}, NOW(), NOW(), ${expiresAt})
                ON CONFLICT ("tenantId","namespace","key") WHERE "supersededById" IS NULL DO UPDATE
                SET "value" = EXCLUDED."value", "kind" = EXCLUDED."kind", "embedding" = EXCLUDED."embedding", "updatedAt" = NOW(), "expiresAt" = EXCLUDED."expiresAt"
                RETURNING "id"
            `;
            return rows[0].id;
        }

        // No embedding — ORM fallback. The compound unique no longer exists in the Prisma
        // schema (the partial unique index is SQL-only), so upsert is replaced by
        // find-live-then-update/create, with a one-shot retry if a concurrent create wins
        // the race (the partial unique index is the backstop; Prisma maps 23505 → P2002).
        const live = await prisma.agentMemory.findFirst({
            where: { tenantId: m.tenantId, namespace, key: m.key, supersededById: null },
            select: { id: true },
        });
        if (live) {
            await prisma.agentMemory.updateMany({
                where: { id: live.id, tenantId: m.tenantId },
                data: { value: m.value as Prisma.InputJsonValue, kind: m.kind, expiresAt, updatedAt: new Date() },
            });
            return live.id;
        }
        try {
            const created = await prisma.agentMemory.create({
                data: { tenantId: m.tenantId, userId: m.userId, namespace, key: m.key, value: m.value as Prisma.InputJsonValue, kind: m.kind, sourceThreadId: m.sourceThreadId ?? null, expiresAt },
            });
            return created.id;
        } catch (err) {
            if ((err as { code?: string })?.code === 'P2002') {
                const winner = await prisma.agentMemory.findFirst({
                    where: { tenantId: m.tenantId, namespace, key: m.key, supersededById: null },
                    select: { id: true },
                });
                if (winner) {
                    await prisma.agentMemory.updateMany({
                        where: { id: winner.id, tenantId: m.tenantId },
                        data: { value: m.value as Prisma.InputJsonValue, kind: m.kind, expiresAt, updatedAt: new Date() },
                    });
                    return winner.id;
                }
            }
            throw err;
        }
    }
```

- [ ] **Step 4: Same conflict-target edit in `PostgresMemoryStore.batch()`**

In `apps/web-ui/lib/agent/persistence.ts` (~line 139), change:

```sql
ON CONFLICT ("tenantId", "namespace", "key") DO UPDATE
```
to
```sql
ON CONFLICT ("tenantId", "namespace", "key") WHERE "supersededById" IS NULL DO UPDATE
```

(Deep-agent behavior unchanged — still a blind upsert.)

- [ ] **Step 5: Update the remember test (raw path now uses $queryRaw + RETURNING)**

In `memory-service.test.ts`, replace the `MemoryService.remember` describe block with:

```typescript
describe('MemoryService.remember', () => {
    it('upserts with an embedding vector and returns the row id', async () => {
        mockQueryRaw.mockClear();
        mockQueryRaw.mockResolvedValueOnce([{ id: 'row-1' }]);
        const svc = getMemoryService();
        const id = await svc.remember({
            tenantId: 't1', userId: 'u1', kind: 'SEMANTIC',
            namespace: ['infra', '123'], key: 'region',
            value: { fact: 'us-east-1', source: 'cli', confidence: 'high' },
        });
        expect(id).toBe('row-1');
        expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    });
});
```

(If the mock harness declares `mockExecuteRaw` expectations for remember, remove them — remember no longer uses `$executeRaw`.)

- [ ] **Step 6: Run the focused tests**

Run: `cd apps/web-ui && bunx vitest run lib/agent/memory/memory-service.test.ts`
Expected: PASS.

- [ ] **Step 7: Apply the migration + regenerate BOTH clients**

```bash
cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/agent-memory
bunx prisma migrate deploy --schema=./libs/prisma/schema.prisma
cd apps/web-ui && bun run db:generate && cd ../workers && bun run db:generate
```
Expected: migration applied; both clients regenerate.

- [ ] **Step 8: Verify in the DB**

```bash
docker exec -i nucleus-postgres psql -U nucleus -d nucleus -c "SELECT indexname FROM pg_indexes WHERE tablename='agent_memories' AND indexname IN ('agent_memories_live_tenant_ns_key','agent_memories_tenantId_namespace_key_idx','agent_memories_tenantId_namespace_key_key');"
```
Expected: the two NEW indexes present; the old `..._key_key` GONE.

Coexistence check (insert superseded + same-key live row, then clean up):

```bash
docker exec -i nucleus-postgres psql -U nucleus -d nucleus -c "
BEGIN;
INSERT INTO agent_memories (\"id\",\"tenantId\",\"userId\",\"namespace\",\"key\",\"value\",\"createdAt\",\"updatedAt\",\"expiresAt\",\"supersededById\",\"supersededAt\")
VALUES ('mig-test-old','mig-t','u','ns','k','{}'::jsonb,NOW(),NOW(),NOW(),'mig-test-new',NOW());
INSERT INTO agent_memories (\"id\",\"tenantId\",\"userId\",\"namespace\",\"key\",\"value\",\"createdAt\",\"updatedAt\",\"expiresAt\")
VALUES ('mig-test-new','mig-t','u','ns','k','{}'::jsonb,NOW(),NOW(),NOW());
SELECT count(*) AS coexist FROM agent_memories WHERE \"tenantId\"='mig-t';
ROLLBACK;"
```
Expected: `coexist = 2` (then rolled back). A third live insert of the same key inside that transaction would fail — optional to verify.

- [ ] **Step 9: Commit**

```bash
git add libs/prisma/schema.prisma libs/prisma/migrations/ apps/web-ui/lib/agent/memory/memory-service.ts apps/web-ui/lib/agent/persistence.ts apps/web-ui/lib/agent/memory/memory-service.test.ts
git commit -m "feat(memory): partial unique index on live rows + remember returns id"
```

---

## Task 2: MemoryService — recall id+distance, update/supersede/reinforce

**Files:**
- Modify: `apps/web-ui/lib/agent/memory/types.ts` (MemoryHit)
- Modify: `apps/web-ui/lib/agent/memory/memory-service.ts:76-134` (recall) + new methods
- Modify: `apps/web-ui/lib/agent/memory/memory-service.test.ts`

**Interfaces:**
- Consumes: Task 1's `remember(): Promise<string>`.
- Produces: `MemoryHit` with `id`/`distance?`; `update(tenantId, id, value)`, `supersede(tenantId, oldId, newId)`, `reinforce(tenantId, id)` (exact signatures in the Interfaces section).

- [ ] **Step 1: Write the failing tests**

Append to `memory-service.test.ts` (the harness's `mockPrisma`-style mocks already exist; add `updateMany` to the `agentMemory` mock in the `vi.mock` factory: `agentMemory: { upsert: mockUpsert, findFirst: mockFindUnique, create: mockUpsert, updateMany: mockUpdateMany }` with `const mockUpdateMany = vi.fn().mockResolvedValue({ count: 1 });` declared beside the other mocks — adapt names to the file's existing factory):

```typescript
describe('MemoryService.recall hit shape', () => {
    it('returns id and distance on vector hits', async () => {
        mockQueryRaw.mockClear();
        mockQueryRaw.mockResolvedValueOnce([
            { id: 'm-1', namespace: 'infra/123', key: 'region', value: { fact: 'us-east-1' }, kind: 'SEMANTIC', distance: 0.12 },
        ]);
        const svc = getMemoryService();
        const hits = await svc.recall({ tenantId: 't1', userId: 'u1', query: 'region', limit: 5 });
        expect(hits[0]).toMatchObject({ id: 'm-1', kind: 'SEMANTIC', distance: 0.12 });
    });
});

describe('MemoryService.supersede', () => {
    it('marks the old row tenant-scoped', async () => {
        const svc = getMemoryService();
        await svc.supersede('t1', 'old-1', 'new-1');
        expect(mockUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'old-1', tenantId: 't1' },
            data: expect.objectContaining({ supersededById: 'new-1' }),
        }));
    });
});

describe('MemoryService.reinforce', () => {
    it('refreshes TTL and bumps accessCount tenant-scoped', async () => {
        const svc = getMemoryService();
        await svc.reinforce('t1', 'm-1');
        const arg = mockUpdateMany.mock.calls.at(-1)![0];
        expect(arg.where).toEqual({ id: 'm-1', tenantId: 't1' });
        expect(arg.data.accessCount).toEqual({ increment: 1 });
        expect(arg.data.expiresAt).toBeInstanceOf(Date);
    });
});

describe('MemoryService.update', () => {
    it('updates value + embedding via raw SQL when embedding succeeds', async () => {
        mockExecuteRaw.mockClear();
        const svc = getMemoryService();
        await svc.update('t1', 'm-1', { fact: 'refined' });
        expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web-ui && bunx vitest run lib/agent/memory/memory-service.test.ts`
Expected: FAIL — `supersede`/`reinforce`/`update` not functions; recall hit missing `id`.

- [ ] **Step 3: Implement**

In `types.ts`, extend `MemoryHit`:

```typescript
export interface MemoryHit {
    id: string;
    namespace: string;
    key: string;
    value: Record<string, unknown>;
    kind: MemoryKind;
    /** Cosine distance to the query (0 = identical); present only on vector-search hits. */
    distance?: number;
}
```

In `memory-service.ts`, update both `recall` queries to select `"id"` and distance, and the mapper:

```typescript
        let rows: Array<{ id: string; namespace: string; key: string; value: unknown; kind: MemoryKind; distance: number | null }>;
        if (queryVec) {
            const vecStr = `[${queryVec.join(',')}]`;
            rows = await prisma.$queryRaw<Array<{ id: string; namespace: string; key: string; value: unknown; kind: MemoryKind; distance: number | null }>>`
                SELECT "id","namespace","key","value","kind", (embedding <=> ${vecStr}::vector) AS distance
                FROM agent_memories
                WHERE "tenantId" = ${p.tenantId}
                  AND "supersededById" IS NULL
                  AND (${nsPrefix} = '' OR "namespace" LIKE ${nsPrefix + '%'})
                  AND (${kindList}::text[] IS NULL OR "kind"::text = ANY(${kindList}::text[]))
                ORDER BY embedding <=> ${vecStr}::vector
                LIMIT ${limit}
            `;
        } else {
            rows = await prisma.$queryRaw<Array<{ id: string; namespace: string; key: string; value: unknown; kind: MemoryKind; distance: number | null }>>`
                SELECT "id","namespace","key","value","kind", NULL::float8 AS distance
                FROM agent_memories
                WHERE "tenantId" = ${p.tenantId}
                  AND "supersededById" IS NULL
                  AND (${nsPrefix} = '' OR "namespace" LIKE ${nsPrefix + '%'})
                  AND (${kindList}::text[] IS NULL OR "kind"::text = ANY(${kindList}::text[]))
                ORDER BY "createdAt" DESC
                LIMIT ${limit}
            `;
        }
```

and the return mapping:

```typescript
        return rows.map((r) => ({
            id: r.id,
            namespace: r.namespace,
            key: r.key,
            value: (r.value ?? {}) as Record<string, unknown>,
            kind: r.kind,
            ...(r.distance !== null && r.distance !== undefined ? { distance: Number(r.distance) } : {}),
        }));
```

Add the three methods to the class (after `recall`):

```typescript
    /** Replace a memory's value in place (judge UPDATE). Re-embeds; embed failure keeps the old vector. */
    async update(tenantId: string, id: string, value: Record<string, unknown>): Promise<void> {
        const prisma = getPrismaClient();
        const expiresAt = new Date(Date.now() + TTL_MS);
        let vec: number[] | null = null;
        try {
            const emb = await this.getEmbeddings(tenantId);
            vec = await emb.embedQuery(JSON.stringify(value));
        } catch {
            // keep the old embedding
        }
        if (vec) {
            const vecStr = `[${vec.join(',')}]`;
            await prisma.$executeRaw`
                UPDATE agent_memories
                SET "value" = ${JSON.stringify(value)}::jsonb, "embedding" = ${vecStr}::vector, "updatedAt" = NOW(), "expiresAt" = ${expiresAt}
                WHERE "id" = ${id} AND "tenantId" = ${tenantId}
            `;
        } else {
            await prisma.agentMemory.updateMany({
                where: { id, tenantId },
                data: { value: value as Prisma.InputJsonValue, expiresAt, updatedAt: new Date() },
            });
        }
    }

    /** Mark `oldId` as displaced by `newId` (judge SUPERSEDE). Old row is never deleted. */
    async supersede(tenantId: string, oldId: string, newId: string): Promise<void> {
        const prisma = getPrismaClient();
        await prisma.agentMemory.updateMany({
            where: { id: oldId, tenantId },
            data: { supersededById: newId, supersededAt: new Date(), updatedAt: new Date() },
        });
    }

    /** A duplicate re-confirmed this memory (judge REINFORCE): refresh TTL, bump the signal. */
    async reinforce(tenantId: string, id: string): Promise<void> {
        const prisma = getPrismaClient();
        await prisma.agentMemory.updateMany({
            where: { id, tenantId },
            data: { expiresAt: new Date(Date.now() + TTL_MS), accessCount: { increment: 1 }, lastAccessedAt: new Date(), updatedAt: new Date() },
        });
    }
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd apps/web-ui && bunx vitest run lib/agent/memory/memory-service.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/agent/memory/types.ts apps/web-ui/lib/agent/memory/memory-service.ts apps/web-ui/lib/agent/memory/memory-service.test.ts
git commit -m "feat(memory): recall returns id+distance; update/supersede/reinforce primitives"
```

---

## Task 3: Reconcile pipeline

**Files:**
- Modify: `apps/web-ui/lib/agent/memory/types.ts` (ExtractedFact + decision types)
- Create: `apps/web-ui/lib/agent/memory/reconcile.ts`
- Create: `apps/web-ui/lib/agent/memory/reconcile.test.ts`

**Interfaces:**
- Consumes: `getMemoryService()` primitives from Tasks 1–2; `SemanticValue`/`MemoryHit` from types.
- Produces: `reconcileEnabled()`, `reconcileMemories(params): Promise<ReconcileSummary>`, `RECONCILE_TOP_K`, `RECONCILE_DISTANCE_THRESHOLD` (exact shapes in the Interfaces section).

- [ ] **Step 1: Add the types**

Append to `types.ts`:

```typescript
export interface ExtractedFact {
    namespace: string[];
    key: string;
    value: SemanticValue;
}

export type ReconcileAction = 'ADD' | 'UPDATE' | 'SUPERSEDE' | 'REINFORCE' | 'NOOP';

export interface ReconcileDecision {
    factIndex: number;
    action: ReconcileAction;
    targetId?: string;                     // UPDATE / SUPERSEDE / REINFORCE
    mergedValue?: Record<string, unknown>; // UPDATE only
}

export interface ReconcileSummary {
    added: number;
    updated: number;
    superseded: number;
    reinforced: number;
    noop: number;
    failed: number;
}
```

- [ ] **Step 2: Write the failing tests**

Create `reconcile.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./memory-service', () => ({ getMemoryService: vi.fn() }));

import { getMemoryService } from './memory-service';
import { reconcileMemories, reconcileEnabled } from './reconcile';
import type { ExtractedFact } from './types';

const mockSvc = {
    recall: vi.fn(),
    remember: vi.fn(),
    update: vi.fn(),
    supersede: vi.fn(),
    reinforce: vi.fn(),
};

const fact = (key: string): ExtractedFact => ({
    namespace: ['infra', 'a1'], key,
    value: { fact: `${key} fact`, source: 's', confidence: 'high' },
});
const neighbor = (id: string, distance = 0.1) => ({
    id, namespace: 'infra/a1', key: 'existing', value: { fact: 'old' }, kind: 'SEMANTIC', distance,
});
const judgeReturning = (json: unknown) => ({
    invoke: vi.fn().mockResolvedValue({ content: JSON.stringify(json) }),
}) as any;
const base = { tenantId: 't1', userId: 'u1', sourceThreadId: 'th-1' };

beforeEach(() => {
    vi.clearAllMocks();
    mockSvc.recall.mockResolvedValue([]);
    mockSvc.remember.mockResolvedValue('new-id');
    mockSvc.update.mockResolvedValue(undefined);
    mockSvc.supersede.mockResolvedValue(undefined);
    mockSvc.reinforce.mockResolvedValue(undefined);
    vi.mocked(getMemoryService).mockReturnValue(mockSvc as any);
});
afterEach(() => { delete process.env.MEMORY_RECONCILE_ENABLED; });

describe('reconcileEnabled', () => {
    it('defaults true; false/0 disable', () => {
        expect(reconcileEnabled()).toBe(true);
        process.env.MEMORY_RECONCILE_ENABLED = 'false';
        expect(reconcileEnabled()).toBe(false);
    });
});

describe('reconcileMemories', () => {
    it('no near neighbors → ADD without calling the judge', async () => {
        mockSvc.recall.mockResolvedValue([neighbor('far-1', 0.9)]); // beyond threshold
        const judge = judgeReturning([]);
        const summary = await reconcileMemories({ ...base, facts: [fact('k1')], judgeModel: judge });
        expect(judge.invoke).not.toHaveBeenCalled();
        expect(mockSvc.remember).toHaveBeenCalledTimes(1);
        expect(summary.added).toBe(1);
    });

    it('SUPERSEDE → remember new then supersede old with the new id', async () => {
        mockSvc.recall.mockResolvedValue([neighbor('old-1')]);
        const judge = judgeReturning([{ factIndex: 0, action: 'SUPERSEDE', targetId: 'old-1' }]);
        const summary = await reconcileMemories({ ...base, facts: [fact('k1')], judgeModel: judge });
        expect(mockSvc.remember).toHaveBeenCalledTimes(1);
        expect(mockSvc.supersede).toHaveBeenCalledWith('t1', 'old-1', 'new-id');
        expect(summary.superseded).toBe(1);
    });

    it('REINFORCE → reinforce only, no new row', async () => {
        mockSvc.recall.mockResolvedValue([neighbor('old-1')]);
        const judge = judgeReturning([{ factIndex: 0, action: 'REINFORCE', targetId: 'old-1' }]);
        const summary = await reconcileMemories({ ...base, facts: [fact('k1')], judgeModel: judge });
        expect(mockSvc.reinforce).toHaveBeenCalledWith('t1', 'old-1');
        expect(mockSvc.remember).not.toHaveBeenCalled();
        expect(summary.reinforced).toBe(1);
    });

    it('UPDATE → update target with mergedValue', async () => {
        mockSvc.recall.mockResolvedValue([neighbor('old-1')]);
        const merged = { fact: 'merged', source: 's', confidence: 'high' };
        const judge = judgeReturning([{ factIndex: 0, action: 'UPDATE', targetId: 'old-1', mergedValue: merged }]);
        const summary = await reconcileMemories({ ...base, facts: [fact('k1')], judgeModel: judge });
        expect(mockSvc.update).toHaveBeenCalledWith('t1', 'old-1', merged);
        expect(summary.updated).toBe(1);
    });

    it('NOOP → nothing written', async () => {
        mockSvc.recall.mockResolvedValue([neighbor('old-1')]);
        const judge = judgeReturning([{ factIndex: 0, action: 'NOOP' }]);
        const summary = await reconcileMemories({ ...base, facts: [fact('k1')], judgeModel: judge });
        expect(mockSvc.remember).not.toHaveBeenCalled();
        expect(summary.noop).toBe(1);
    });

    it('judge throws → ADD fallback', async () => {
        mockSvc.recall.mockResolvedValue([neighbor('old-1')]);
        const judge = { invoke: vi.fn().mockRejectedValue(new Error('boom')) } as any;
        const summary = await reconcileMemories({ ...base, facts: [fact('k1')], judgeModel: judge });
        expect(mockSvc.remember).toHaveBeenCalledTimes(1);
        expect(summary.added).toBe(1);
    });

    it('invalid targetId → ADD fallback', async () => {
        mockSvc.recall.mockResolvedValue([neighbor('old-1')]);
        const judge = judgeReturning([{ factIndex: 0, action: 'SUPERSEDE', targetId: 'not-a-neighbor' }]);
        const summary = await reconcileMemories({ ...base, facts: [fact('k1')], judgeModel: judge });
        expect(mockSvc.supersede).not.toHaveBeenCalled();
        expect(summary.added).toBe(1);
    });

    it('one fact failing does not block its sibling', async () => {
        mockSvc.recall.mockResolvedValue([neighbor('old-1')]);
        mockSvc.reinforce.mockRejectedValueOnce(new Error('db down'));
        const judge = judgeReturning([
            { factIndex: 0, action: 'REINFORCE', targetId: 'old-1' },
            { factIndex: 1, action: 'NOOP' },
        ]);
        const summary = await reconcileMemories({ ...base, facts: [fact('k1'), fact('k2')], judgeModel: judge });
        expect(summary.failed).toBe(1);
        expect(summary.noop).toBe(1);
    });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd apps/web-ui && bunx vitest run lib/agent/memory/reconcile.test.ts`
Expected: FAIL — `Cannot find module './reconcile'`.

- [ ] **Step 4: Implement `reconcile.ts`**

```typescript
/**
 * reconcile.ts — save-time semantic conflict resolution (Phase 2).
 *
 * extract → neighbor fetch (pgvector) → one batched LLM judge call →
 * apply (ADD / UPDATE / SUPERSEDE / REINFORCE / NOOP) via MemoryService.
 * Policy layer only — MemoryService stays a pure data layer.
 * Never throws; every failure degrades to ADD (legacy behavior).
 */

import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { getMemoryService } from './memory-service';
import type { ExtractedFact, MemoryHit, ReconcileDecision, ReconcileSummary } from './types';

export const RECONCILE_TOP_K = 5;
// Cosine distance (0 = identical). Neighbors farther than this are treated as
// unrelated and the fact goes straight to ADD. Initial guess — tune from logs.
export const RECONCILE_DISTANCE_THRESHOLD = 0.55;

export function reconcileEnabled(): boolean {
    const v = process.env.MEMORY_RECONCILE_ENABLED?.toLowerCase();
    return !(v === 'false' || v === '0');
}

interface FactWithNeighbors {
    factIndex: number;
    fact: ExtractedFact;
    neighbors: MemoryHit[];
}

const JUDGE_SYSTEM = new SystemMessage(
    `You reconcile newly extracted agent memories against similar existing memories.
For each new fact, choose exactly one action:
- "ADD": genuinely new information not covered by any neighbor.
- "UPDATE": same fact as one neighbor but with more or refined detail. Provide "mergedValue": the neighbor's value enriched with the new detail (same JSON shape as the new fact's value).
- "SUPERSEDE": the new fact EXPLICITLY CONTRADICTS one neighbor — both cannot be true (e.g. a resource moved region). The new fact wins. Provide "targetId".
- "REINFORCE": semantically the same fact as one neighbor; nothing new. Provide "targetId".
- "NOOP": ephemeral or not worth remembering.
Rules:
- SUPERSEDE only on mutual exclusivity, NEVER on similarity or partial overlap.
- Uncertain between UPDATE and REINFORCE → choose REINFORCE.
- Uncertain whether facts contradict → choose ADD (keep both).
Return ONLY a JSON array with one object per fact:
[{"factIndex": 0, "action": "SUPERSEDE", "targetId": "..."}]
"targetId" must be an id from that fact's own neighbors. Include "mergedValue" only for UPDATE.`,
);

function parseDecisions(content: string): ReconcileDecision[] {
    const match = content.match(/\[[\s\S]*\]/);
    if (!match) return [];
    try {
        const parsed = JSON.parse(match[0]);
        return Array.isArray(parsed) ? (parsed as ReconcileDecision[]) : [];
    } catch {
        return [];
    }
}

function isValidDecision(d: ReconcileDecision, item: FactWithNeighbors): boolean {
    const neighborIds = new Set(item.neighbors.map((n) => n.id));
    switch (d.action) {
        case 'ADD':
        case 'NOOP':
            return true;
        case 'REINFORCE':
        case 'SUPERSEDE':
            return !!d.targetId && neighborIds.has(d.targetId);
        case 'UPDATE':
            return !!d.targetId && neighborIds.has(d.targetId)
                && !!d.mergedValue && typeof d.mergedValue === 'object';
        default:
            return false;
    }
}

export async function reconcileMemories(params: {
    tenantId: string;
    userId: string;
    facts: ExtractedFact[];
    judgeModel: BaseChatModel;
    sourceThreadId?: string;
}): Promise<ReconcileSummary> {
    const { tenantId, userId, facts, judgeModel, sourceThreadId } = params;
    const summary: ReconcileSummary = { added: 0, updated: 0, superseded: 0, reinforced: 0, noop: 0, failed: 0 };
    const svc = getMemoryService();

    const add = async (fact: ExtractedFact): Promise<void> => {
        await svc.remember({
            tenantId, userId, kind: 'SEMANTIC',
            namespace: fact.namespace, key: fact.key,
            value: fact.value as unknown as Record<string, unknown>,
            sourceThreadId,
        });
        summary.added++;
    };

    // 1. Neighbor fetch — facts with no near neighbor skip the judge entirely.
    const withNeighbors: FactWithNeighbors[] = [];
    for (const [factIndex, fact] of facts.entries()) {
        let neighbors: MemoryHit[] = [];
        try {
            // Query by the value JSON — the same text remember() embeds, so distances are comparable.
            const hits = await svc.recall({
                tenantId, userId, query: JSON.stringify(fact.value),
                kinds: ['SEMANTIC'], limit: RECONCILE_TOP_K,
            });
            neighbors = hits.filter((h) => h.distance !== undefined && h.distance <= RECONCILE_DISTANCE_THRESHOLD);
        } catch {
            // recall failure → treat as no neighbors
        }
        if (neighbors.length === 0) {
            try { await add(fact); } catch (err: any) {
                console.warn(`[Reconcile] ADD failed for ${fact.key}: ${err?.message ?? err}`);
                summary.failed++;
            }
        } else {
            withNeighbors.push({ factIndex, fact, neighbors });
        }
    }
    if (withNeighbors.length === 0) return summary;

    // 2. One batched judge call for every fact that has neighbors.
    const decisions = new Map<number, ReconcileDecision>();
    try {
        const input = new HumanMessage(JSON.stringify(
            withNeighbors.map((w) => ({
                factIndex: w.factIndex,
                newFact: { namespace: w.fact.namespace.join('/'), key: w.fact.key, value: w.fact.value },
                neighbors: w.neighbors.map((n) => ({ id: n.id, namespace: n.namespace, key: n.key, value: n.value })),
            })), null, 2,
        ));
        const resp = await judgeModel.invoke([JUDGE_SYSTEM, input]);
        const content = typeof resp.content === 'string' ? resp.content : JSON.stringify(resp.content);
        for (const d of parseDecisions(content)) {
            if (typeof d?.factIndex === 'number') decisions.set(d.factIndex, d);
        }
    } catch (err: any) {
        console.warn(`[Reconcile] Judge failed, falling back to ADD: ${err?.message ?? err}`);
        // decisions stays empty → every fact falls back to ADD below
    }

    // 3. Apply — anything missing/invalid degrades to ADD; one failure never blocks siblings.
    for (const item of withNeighbors) {
        const d = decisions.get(item.factIndex);
        try {
            if (!d || !isValidDecision(d, item)) {
                await add(item.fact);
                continue;
            }
            switch (d.action) {
                case 'ADD':
                    await add(item.fact);
                    break;
                case 'UPDATE':
                    await svc.update(tenantId, d.targetId!, d.mergedValue!);
                    summary.updated++;
                    break;
                case 'SUPERSEDE': {
                    const newId = await svc.remember({
                        tenantId, userId, kind: 'SEMANTIC',
                        namespace: item.fact.namespace, key: item.fact.key,
                        value: item.fact.value as unknown as Record<string, unknown>,
                        sourceThreadId,
                    });
                    await svc.supersede(tenantId, d.targetId!, newId);
                    summary.superseded++;
                    summary.added++;
                    break;
                }
                case 'REINFORCE':
                    await svc.reinforce(tenantId, d.targetId!);
                    summary.reinforced++;
                    break;
                case 'NOOP':
                    summary.noop++;
                    break;
            }
        } catch (err: any) {
            console.warn(`[Reconcile] Apply failed for ${item.fact.key}: ${err?.message ?? err}`);
            summary.failed++;
        }
    }

    return summary;
}
```

NOTE on the SUPERSEDE counter: it increments BOTH `superseded` and `added` (a new row was added AND an old one displaced). The Task 3 test asserts `summary.superseded === 1` only — keep the extra `added++`; adjust no tests.

- [ ] **Step 5: Run tests to verify pass**

Run: `cd apps/web-ui && bunx vitest run lib/agent/memory/reconcile.test.ts`
Expected: PASS (all 9).

- [ ] **Step 6: Commit**

```bash
git add apps/web-ui/lib/agent/memory/types.ts apps/web-ui/lib/agent/memory/reconcile.ts apps/web-ui/lib/agent/memory/reconcile.test.ts
git commit -m "feat(memory): reconcile pipeline — batched judge + apply with ADD fallback"
```

---

## Task 4: Wire reconcile into memorySaveNode + env flag

**Files:**
- Modify: `apps/web-ui/lib/agent/memory-nodes.ts:108-215` (memorySaveNode)
- Modify: `apps/web-ui/env.ts:82-88` (feature-flags block)
- Modify: `.env.example` (working-memory block)

**Interfaces:**
- Consumes: `reconcileMemories`, `reconcileEnabled` from `./memory/reconcile`; `ExtractedFact` from `./memory/types`.

- [ ] **Step 1: env.ts**

In the `server:` object's feature-flags block (after `WORKING_MEMORY_KEEP_RECENT`), add:

```typescript
        MEMORY_RECONCILE_ENABLED: z.string().optional(),
```

- [ ] **Step 2: memory-nodes.ts imports + node signature**

Add imports:

```typescript
import { reconcileMemories, reconcileEnabled } from "./memory/reconcile";
import type { ExtractedFact } from "./memory/types";
```

Change the node signature (line ~111) from
`return async function memorySaveNode(state: ReflectionState): Promise<Partial<ReflectionState>> {` to:

```typescript
    return async function memorySaveNode(state: ReflectionState, runtimeConfig?: any): Promise<Partial<ReflectionState>> {
```

- [ ] **Step 3: Replace the save loop**

Replace (lines ~199-208):

```typescript
            console.log(`🧠 [MEMORY SAVE] Saving ${toSave.length} memories...`);

            for (const mem of toSave) {
                try {
                    await saveMemory(tenantId, userId, mem.namespace, mem.key, mem.value as Record<string, unknown>);
                    console.log(`   ✅ Saved: ${mem.namespace.join("/")}/${mem.key}`);
                } catch (err: any) {
                    console.warn(`   ⚠️ Failed to save ${mem.key}: ${err?.message ?? err}`);
                }
            }
```

with:

```typescript
            if (reconcileEnabled()) {
                console.log(`🧠 [MEMORY SAVE] Reconciling ${toSave.length} extracted facts...`);
                const threadId = runtimeConfig?.configurable?.thread_id as string | undefined;
                const summary = await reconcileMemories({
                    tenantId, userId,
                    facts: toSave.map(m => ({ namespace: m.namespace, key: m.key, value: m.value })) as ExtractedFact[],
                    judgeModel: reflectorModel,
                    sourceThreadId: threadId,
                });
                console.log(`🧠 [MEMORY SAVE] Reconcile: ${summary.added} added, ${summary.updated} updated, ${summary.superseded} superseded, ${summary.reinforced} reinforced, ${summary.noop} noop, ${summary.failed} failed`);
            } else {
                console.log(`🧠 [MEMORY SAVE] Saving ${toSave.length} memories (reconcile disabled)...`);
                for (const mem of toSave) {
                    try {
                        await saveMemory(tenantId, userId, mem.namespace, mem.key, mem.value as Record<string, unknown>);
                        console.log(`   ✅ Saved: ${mem.namespace.join("/")}/${mem.key}`);
                    } catch (err: any) {
                        console.warn(`   ⚠️ Failed to save ${mem.key}: ${err?.message ?? err}`);
                    }
                }
            }
```

- [ ] **Step 4: .env.example**

After the `WORKING_MEMORY_KEEP_RECENT=8` line, add:

```
# Save-time memory reconciliation (Phase 2) — dedup/contradiction resolution via an
# LLM judge before writing. Set false to restore blind upserts (legacy behavior).
MEMORY_RECONCILE_ENABLED=true
```

- [ ] **Step 5: Verify**

Run: `cd apps/web-ui && bunx vitest run lib/agent/memory/ && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep "memory-nodes.ts" || echo "no errors in memory-nodes.ts"`
Expected: all memory tests PASS; `no errors in memory-nodes.ts`.

- [ ] **Step 6: Commit**

```bash
git add apps/web-ui/lib/agent/memory-nodes.ts apps/web-ui/env.ts .env.example
git commit -m "feat(memory): memorySaveNode reconciles via LLM judge (MEMORY_RECONCILE_ENABLED)"
```

---

## Task 5: Memory-module — hide superseded + provenance

**Files:**
- Modify: `apps/web-ui/lib/db/repositories/agent-memory/interface.ts` (record fields)
- Modify: `apps/web-ui/lib/db/repositories/agent-memory/postgres.ts` (filter + mapping)
- Modify: `apps/web-ui/lib/db/repositories/agent-memory/postgres.test.ts`
- Modify: `apps/web-ui/lib/queries/agent-memories.ts` (`MemoryRow`)
- Modify: `apps/web-ui/components/memory/memory-detail-dialog.tsx`

**Interfaces:**
- Produces: `AgentMemoryRecord`/`MemoryRow` gain `supersededById: string | null; supersededAt: string | null;`.

- [ ] **Step 1: Write the failing test**

In `postgres.test.ts`: add `supersededById: null, supersededAt: null,` to the `makeRow` defaults, then add:

```typescript
    it('listByTenant excludes superseded rows', async () => {
        const repo = new AgentMemoryPostgresRepository();
        await repo.listByTenant({ tenantId: 't1' });
        const arg = mockPrisma.agentMemory.findMany.mock.calls[0][0];
        expect(arg.where.supersededById).toBeNull();
    });

    it('getById still returns superseded rows with provenance fields', async () => {
        mockPrisma.agentMemory.findFirst.mockResolvedValueOnce(
            makeRow({ supersededById: 'mem-2', supersededAt: new Date('2026-07-01T00:00:00Z') }),
        );
        const repo = new AgentMemoryPostgresRepository();
        const rec = await repo.getById('t1', 'mem-1');
        expect(rec?.supersededById).toBe('mem-2');
        expect(rec?.supersededAt).toBe('2026-07-01T00:00:00.000Z');
    });
```

Run: `cd apps/web-ui && bunx vitest run lib/db/repositories/agent-memory/postgres.test.ts`
Expected: FAIL (where has no `supersededById`; record lacks the fields).

- [ ] **Step 2: Implement**

`interface.ts` — in `AgentMemoryRecord`, after `expiresAt: string;` add:

```typescript
    supersededById: string | null;
    supersededAt: string | null;
```

`postgres.ts` — `MemoryRow` type gains `supersededById: string | null; supersededAt: Date | null;`; `toRecord` returns them:

```typescript
        supersededById: row.supersededById,
        supersededAt: row.supersededAt ? row.supersededAt.toISOString() : null,
```

`listByTenant` base where becomes:

```typescript
        const where: Record<string, unknown> = { tenantId: filters.tenantId, supersededById: null };
```

(`getById`/`deleteById` unchanged — direct fetch still reaches superseded rows.)

`lib/queries/agent-memories.ts` — `MemoryRow` gains:

```typescript
    supersededById: string | null;
    supersededAt: string | null;
```

`memory-detail-dialog.tsx` — after the `Expires` Row (line ~47), add:

```tsx
                        {memory.supersededAt ? (
                            <Row
                                label="Superseded"
                                value={
                                    <span className="text-destructive">
                                        {new Date(memory.supersededAt).toLocaleString()} — replaced by a newer memory
                                    </span>
                                }
                            />
                        ) : null}
```

- [ ] **Step 3: Run tests to verify pass**

Run: `cd apps/web-ui && bunx vitest run lib/db/repositories/agent-memory/postgres.test.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 4: Typecheck touched UI files**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "agent-memory|agent-memories|memory-detail-dialog" || echo "no errors"`
Expected: `no errors`.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/db/repositories/agent-memory/ apps/web-ui/lib/queries/agent-memories.ts apps/web-ui/components/memory/memory-detail-dialog.tsx
git commit -m "feat(memory): hide superseded memories from list + provenance in detail"
```

---

## Task 6: Full verification + docs

**Files:**
- Modify: `CLAUDE.md` (Agent Architecture key-modules table)

- [ ] **Step 1: Full memory + repo suites**

Run: `cd apps/web-ui && bunx vitest run lib/agent/memory/ lib/db/repositories/agent-memory/`
Expected: all PASS.

- [ ] **Step 2: Typecheck all touched files (only pre-existing baseline errors allowed)**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "memory/|memory-nodes|persistence.ts|agent-memories|memory-detail" | grep -v -E "persistence.ts\((56|146|147)," || echo "no new errors"`
Expected: `no new errors`.

- [ ] **Step 3: CLAUDE.md**

In the "Key shared modules" table (after the `memory/working-memory.ts` row), add:

```markdown
| `memory/reconcile.ts` | Save-time conflict resolution: batched LLM judge (ADD/UPDATE/SUPERSEDE/REINFORCE/NOOP) applied via MemoryService with an auditable supersede trail. Gated by `MEMORY_RECONCILE_ENABLED`. |
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(memory): document reconcile module"
```

---

## Self-Review (completed against the spec)

- **Spec §A (pipeline, fast path, batched judge, apply, failure containment, gate):** Task 3 (pipeline + tests) + Task 4 (gate + wiring). ✅
- **Spec §B (partial unique index + 3 upsert-site ripples + remember returns id):** Task 1, atomic commit. ✅
- **Spec §C (recall id+distance; update/supersede/reinforce):** Task 2. ✅
- **Spec §D (hide superseded, record fields, provenance line):** Task 5. ✅
- **Spec §E (env flag + constants):** Tasks 3 (constants) + 4 (flag, .env.example). ✅
- **Testing section:** action-apply/fallback/no-LLM tests (Task 3), primitives (Tasks 1–2), migration verify incl. coexistence (Task 1 Step 8), repo exclusion (Task 5). ✅
- **Type consistency:** `remember → Promise<string>`, `MemoryHit.id/distance?`, `ReconcileDecision`, `updateMany({ where: { id, tenantId } })` used identically across tasks. ✅
- **No placeholders:** every code step carries full code; commands carry expected output. ✅
