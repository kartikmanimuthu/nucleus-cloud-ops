# Agent Memory Refactor — Phase 0 (Foundation) + Phase 1 (Working Memory)

**Status:** Approved design, ready for implementation planning
**Date:** 2026-07-01
**Branch:** `agent-memory`
**Scope:** Phases 0 and 1 of a larger 5-phase memory roadmap (see "Roadmap Context")

---

## Problem

The current agent memory system is a **single-layer semantic store**. It works, but it cannot support autonomous agents that run for long hours, and it implements only one of the three cognitive-memory pillars (semantic facts). Concretely:

1. **No in-session survival.** Mid-loop, each agent node assembles context with `getRecentMessages(messages, 20)` — a naive last-20-message slice (`fast-agent.ts:108`). On a long run, everything older is *silently dropped*, nothing is summarized, and large tool outputs sit full-size in the window. A multi-hour run will lose its early context and/or overflow the model's context window. **This is the single biggest blocker for autonomous long runs.**
2. **Only semantic memory exists.** No episodic (experience replay) or procedural (self-improving instructions) layers. Procedural knowledge lives in a *separate* DB-backed Skills module, disconnected from the memory loop.
3. **No conflict resolution.** `PostgresMemoryStore.batch()` upserts on `(tenantId, namespace, key)` with `ON CONFLICT DO UPDATE` (`persistence.ts:139`), so a "conflicting" fact blindly overwrites the old one — no supersede, no audit trail, no contradiction detection.
4. **No vector index.** Similarity search is a raw `ORDER BY embedding <=> $vec` (`persistence.ts:175`) against `agent_memories` with **no HNSW/IVFFlat index** — a sequential scan that degrades past ~10k memories/tenant.

## Goal

Refactor the memory system into a proper multi-layer cognitive architecture, built **natively in TypeScript** on the existing Postgres + pgvector + repository-factory foundation (no LangMem — Python-only; no Mem0-JS dependency). This spec covers the two foundational phases:

- **Phase 0 — Foundation:** typed multi-layer schema, vector index, and a single typed retrieval/write service that all later layers extend.
- **Phase 1 — Working memory:** in-session compaction + budget-aware context assembly so agents survive long runs.

### Non-goals (explicitly deferred to later cycles)

- **Deep-agent unification** — the deep agent keeps its separate MongoDB store + explicit memory tools untouched in this cycle.
- **Semantic conflict-resolution *logic*** (dedup/contradiction/supersede) — Phase 2.
- **Episodic *capture logic*** (experience replay) — Phase 3.
- **Procedural memory + Skills bridge** — Phase 4.

Phase 0 lays the *columns and interfaces* these later phases need; it does not implement their logic.

---

## Roadmap Context

This is the first spec in a 5-phase effort (approved sequencing):

| Phase | Deliverable | Status |
|-------|-------------|--------|
| **0** | Foundation: typed schema, HNSW index, `MemoryService`, one substrate | **this spec** |
| **1** | Working memory: compaction + budget-aware assembly (unblocks long runs) | **this spec** |
| 2 | Semantic + conflict resolution (dedup / contradiction / supersede) | later |
| 3 | Episodic: `Episode` capture + few-shot replay | later |
| 4 | Procedural: learned instructions bridged into the Skills module | later |

Each later phase gets its own spec → plan → build cycle. Design decisions locked for this cycle: **native TS build**, **defer deep-agent**, **spec Phase 0+1 together** (they are tightly coupled — working memory needs the foundation's service layer).

---

## Current State (grounding)

Key files and behaviors this refactor builds on:

- **`libs/prisma/schema.prisma`** — `AgentMemory` model (~line 494): `{ id, tenantId, userId, namespace, key, value Json, embedding Unsupported("vector(1024)")?, createdAt, updatedAt, expiresAt }`, unique `(tenantId, namespace, key)`, indexes on `(tenantId, userId)` and `expiresAt`, 90-day TTL. Maps to table `agent_memories`.
- **`apps/web-ui/lib/agent/persistence.ts`** — `PostgresMemoryStore.batch()` handles put (upsert + embed) and search (pgvector `<=>` with recency-text fallback). Exposes loose helpers `saveMemory(...)` / `searchMemory(...)`. Also holds `PostgresSaver` checkpointer + `PostgresChatHistory`. Singletons via `globalThis`.
- **`apps/web-ui/lib/agent/memory-nodes.ts`** — `createMemoryRecallNode` (semantic search top-10 → LLM relevance filter → `memoryContext` string) and `createMemorySaveNode` (reflector LLM extracts JSON facts → save). Note: recall queries by `tenantId` only (empty namespace prefix), not `userId`.
- **`apps/web-ui/lib/agent/fast-agent.ts`** / **`planning-agent.ts`** — graph: `START → memory_recall → agent → (tools|reflect|finalize) → memory_save → END`. Agent node builds the system prompt fresh per iteration and injects `memoryContext` as a `## Relevant Context from Memory` section. Context window = `getRecentMessages(messages, 20)`.
- **`apps/web-ui/lib/agent/agent-shared.ts`** — `ReflectionState` (fields incl. `messages`, `memoryContext`, `iterationCount`, `toolResults`), `graphState` channels, `sanitizeMessagesForBedrock`, re-exports `getCheckpointer`/`getStore`.
- **`apps/web-ui/lib/agent/embeddings-factory.ts`** — `getTenantEmbeddings(tenantId)`, fixed **1024-dim** (provider-only; no Bedrock fallback).
- **Memory module UI** — `app/api/agent-memories/*`, `components/memory/*`, repository at `lib/db/repositories/agent-memory/`, category taxonomy in `lib/agent-memory/category.ts` (namespace-prefix → infra/user/patterns/errors/other). RBAC subject `Memory`.

---

## Phase 0 — Foundation

### A. Schema evolution

Evolve `AgentMemory` into a single long-term store with a `kind` discriminator, rather than table-per-layer. Rationale: one vector index, one retrieval path, and the Memory UI already lists this table. **All changes are additive/non-breaking.**

Add to `AgentMemory`:

| Field | Type | Purpose |
|-------|------|---------|
| `kind` | enum `MemoryKind { SEMANTIC, EPISODIC, PROCEDURAL }`, default `SEMANTIC` | layer discriminator; existing rows backfill to `SEMANTIC` |
| `sourceThreadId` | `String?` | provenance — which run created this memory |
| `supersededById` | `String?` (self-relation) | Phase 2 conflict resolution marks stale facts instead of overwriting |
| `supersededAt` | `DateTime?` | when it was superseded |
| `lastAccessedAt` | `DateTime?` | reinforcement/decay signal |
| `accessCount` | `Int @default(0)` | reinforcement/decay signal |

Add index `@@index([tenantId, kind])`. Keep existing unique `(tenantId, namespace, key)`, TTL, and the `value Json` column. TypeScript discriminated-union types over `value` live in `lib/agent/memory/types.ts`:

- `SEMANTIC` → `{ fact: string; source: string; confidence: "high" | "medium" }`
- `EPISODIC` → `{ context: string; reasoning: string; action: string; outcome: string }` *(populated in Phase 3)*
- `PROCEDURAL` → `{ instruction: string; trigger: string; evidence: string }` *(populated in Phase 4)*

New model **`AgentWorkingMemory`** (thread-scoped, mutable, **no embedding** — it is the live context, not semantically searched):

```prisma
model AgentWorkingMemory {
  id             String   @id @default(cuid())
  tenantId       String
  threadId       String
  runningSummary String   @db.Text          // rolling NL summary of the run so far
  scratchpad     Json                        // { openGoals, keyFindings, resourceIds, pendingSteps }
  tokenCount     Int      @default(0)         // last estimated window size
  turnCount      Int      @default(0)         // turns folded into summary
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  expiresAt      DateTime                     // TTL aligned with checkpoint retention

  @@unique([tenantId, threadId])
  @@index([expiresAt])
  @@map("agent_working_memory")
}
```

### B. pgvector HNSW index

Prisma's `Unsupported("vector(1024)")` cannot declare an index, so add it via raw SQL in the migration (the `pgvector/pgvector:pg16` image supports HNSW):

```sql
CREATE INDEX IF NOT EXISTS agent_memories_embedding_hnsw
  ON agent_memories USING hnsw (embedding vector_cosine_ops);
```

`vector_cosine_ops` matches the existing `<=>` cosine-distance queries in `persistence.ts`. Migration also backfills `kind = 'SEMANTIC'` for existing rows (the enum default handles new rows; existing NULLs get a one-time `UPDATE`). Volume is low (young feature), so the index build is cheap.

### C. `MemoryService` (typed retrieval/write layer)

New `apps/web-ui/lib/agent/memory/memory-service.ts`, following the repository-factory convention. It becomes the single entry point for all long-term + working memory, collapsing the loose string-based helpers and the raw SQL currently inline in `PostgresMemoryStore`.

Interface (illustrative):

```typescript
interface RecallParams {
  tenantId: string;
  userId: string;
  query: string;
  kinds?: MemoryKind[];          // filter by layer; default all
  namespacePrefix?: string[];
  limit?: number;
}

interface MemoryService {
  recall(p: RecallParams): Promise<MemoryHit[]>;   // pgvector search + updates lastAccessedAt/accessCount
  remember(m: RememberParams): Promise<void>;       // upsert + embed via getTenantEmbeddings
  getWorkingMemory(tenantId: string, threadId: string): Promise<WorkingMemory | null>;
  putWorkingMemory(wm: WorkingMemorySnapshot): Promise<void>;   // upsert on (tenantId, threadId)
}
```

`recall` records access stats (`lastAccessedAt`, `accessCount++`) on returned rows — cheap signal for later decay/reinforcement. Multi-tenant scoping is enforced in every query (raw SQL paths manually scope `tenantId`, per the `$executeRaw`-not-intercepted gotcha).

**Compatibility shim:** `PostgresMemoryStore.batch()` stays in `persistence.ts` but delegates to `MemoryService`, so the deep-agent's `save_memory`/`search_memory` tools keep working with zero changes. `memory-nodes.ts` recall/save switch to calling `MemoryService` directly (typed, kind-aware) instead of the string helpers.

---

## Phase 1 — Working Memory

### D. Compaction

A new **`compact`** node runs before the agent node when the estimated window token count exceeds `WORKING_MEMORY_TOKEN_BUDGET`. Token estimation reuses the existing `chars/4` heuristic. On trigger it:

1. Selects the older turns about to be evicted from the verbatim window.
2. Folds them into `runningSummary` via the **reflector model** (provider-only, cheaper than main): `summary' = summarize(summary + evictedTurns)`. Summarization is instructed to **never drop a recorded goal or an unresolved error** (monotonicity — see testing).
3. Compresses oversized tool-result content (keep head+tail, insert `"… full output elided …"`).
4. Updates the structured `scratchpad`: `{ openGoals[], keyFindings[], resourceIds[], pendingSteps[] }`.
5. Persists the snapshot (see F).

### E. Budget-aware context assembly

Replace the `getRecentMessages(messages, 20)` call sites with a `assembleContext(...)` helper that builds the model input as:

```
[ systemPrompt ]
[ ## Working Memory : runningSummary + scratchpad ]   (only when non-empty)
[ ## Relevant Context from Memory : memoryContext ]    (existing recall output)
[ last-K verbatim turns that fit remaining budget ]    (K = WORKING_MEMORY_KEEP_RECENT)
```

The agent always sees a compact, faithful view regardless of run length. `sanitizeMessagesForBedrock` still runs on the verbatim tail to preserve tool_call/tool_result adjacency.

### F. Storage model (approved: checkpoint-live + table snapshot)

- **Source of truth during a run:** working memory lives in the checkpointed `ReflectionState` (new fields `runningSummary`, `scratchpad`). LangGraph's `PostgresSaver` already persists this per-thread across interrupts/resumes — zero extra plumbing mid-run.
- **Durable mirror:** at each compaction, `compact` calls `MemoryService.putWorkingMemory(...)` to snapshot into `AgentWorkingMemory`. This gives durable, inspectable state (and a hook for the Memory UI later) without a DB write every turn — only on compaction.

### G. Configuration

Feature-gated like `RIGHT_SIZING_ENABLED`:

| Env var | Default | Meaning |
|---------|---------|---------|
| `WORKING_MEMORY_ENABLED` | `true` | master gate for the compaction node |
| `WORKING_MEMORY_TOKEN_BUDGET` | `60000` | window token budget that triggers compaction |
| `WORKING_MEMORY_KEEP_RECENT` | `8` | verbatim turns kept after the summary |

When `WORKING_MEMORY_ENABLED=false`, the `compact` node is a pass-through and assembly falls back to the current last-N behavior — safe rollback with no schema removal.

---

## Files Touched

| File | Change |
|------|--------|
| `libs/prisma/schema.prisma` | `MemoryKind` enum + new `AgentMemory` columns + `AgentWorkingMemory` model |
| migration (`libs/prisma/migrations/...`) | additive columns, `AgentWorkingMemory` table, raw-SQL HNSW index, `kind` backfill |
| `apps/web-ui/lib/agent/memory/types.ts` | **new** — `MemoryKind`, per-kind value unions, WM types |
| `apps/web-ui/lib/agent/memory/memory-service.ts` | **new** — typed recall/remember + working-memory get/put |
| `apps/web-ui/lib/agent/memory/working-memory.ts` | **new** — compaction (summary folding, tool-log compression) + `assembleContext` |
| `apps/web-ui/lib/agent/persistence.ts` | `PostgresMemoryStore.batch()` delegates to `MemoryService`; init unchanged |
| `apps/web-ui/lib/agent/memory-nodes.ts` | recall/save use `MemoryService` (typed, kind-aware); export `createCompactNode` factory |
| `apps/web-ui/lib/agent/agent-shared.ts` | `ReflectionState` + `graphState` channels gain `runningSummary`/`scratchpad`; house `assembleContext` |
| `apps/web-ui/lib/agent/fast-agent.ts` | add `compact` node + budget-aware assembly; wire WM deps |
| `apps/web-ui/lib/agent/planning-agent.ts` | same wiring as fast-agent |
| `apps/web-ui/lib/db/repositories/agent-memory/*` | extend repo/interface for `kind` + working-memory (keeps Memory UI working) |
| **deep-agent** | **untouched** (deferred) |

---

## Testing

- **Vitest (web-ui):**
  - `MemoryService.recall/remember` — kind filtering, tenant scoping, access-stat increment.
  - `working-memory` — summary folding (`summary'` contains prior goals), tool-log compression (head+tail preserved), `assembleContext` output ordering.
- **fast-check property tests** (pattern already used under `tests/agent-ops/`):
  - **Budget invariant:** for arbitrary message histories, `assembleContext(...)` estimated tokens ≤ `WORKING_MEMORY_TOKEN_BUDGET`.
  - **Monotonicity:** any goal/unresolved-error present before compaction is still represented after (in summary or scratchpad).
- **Migration verify:** assert HNSW index exists (`pg_indexes`) and no `agent_memories.kind` is NULL post-migration.
- **Manual smoke:** run a long fast-agent session locally, confirm compaction fires past the budget and the summary is injected (`🧠` logs).
- No new E2E in this cycle (a long-run smoke can be added when Phase 1 lands).

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Summarization latency/cost on every compaction | Threshold-triggered (not every turn); uses the cheaper reflector model; gated by env |
| Summary loses critical state | Monotonicity property test + explicit "never drop goals/errors" instruction |
| HNSW build on existing data | Table volume is low; `CREATE INDEX IF NOT EXISTS`; can be `CONCURRENTLY` if needed |
| Delegation shim breaks deep-agent tools | `PostgresMemoryStore.batch()` signature preserved; contract test on put/search |
| Migration on live data | All additive; `kind` defaults + one-time backfill; no drops |

---

## Open Questions

None blocking. Deferred design work (conflict resolution, episodic capture, procedural/Skills bridge) is scoped into Phases 2–4, each with its own spec.
