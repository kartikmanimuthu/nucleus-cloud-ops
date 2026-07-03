# Agent Memory Phase 2 — Semantic Conflict Resolution

**Status:** Approved design, ready for implementation planning
**Date:** 2026-07-02
**Branch:** `agent-memory` (continues PR #55; Phase 0+1 already landed on this branch)
**Roadmap:** Phase 2 of 5 (see `2026-07-01-agent-memory-foundation-working-memory-design.md` for the roadmap; Phases 3–4 + deep-agent unification remain)

---

## Problem

Phase 0 built the read side of supersede (`recall` filters `"supersededById" IS NULL`) but the write side is still naive. When `memory_save` extracts facts at the end of a run:

- Same `(tenantId, namespace, key)` → **silent overwrite** (`ON CONFLICT DO UPDATE`), no audit trail.
- Different key but semantically identical or contradicting fact → **duplicates accumulate forever**; recall returns both the stale and the fresh fact and the agent must guess.
- The only dedup today is a prompt instruction in the extractor ("do NOT re-save facts that already exist") — unenforced.
- `lastAccessedAt`/`accessCount` exist but nothing refreshes TTL when a fact is re-confirmed, so persistently-true facts still expire at 90 days.

For long-lived autonomous agents this is the "accuracy over time" gap: the store degrades as it grows.

## Goal

A Mem0-style **inline reconciliation pipeline** at save time: *extract → retrieve similar → judge → apply with audit trail*. After Phase 2, the store never knowingly holds a contradiction, duplicates reinforce instead of accumulate, and every displacement is auditable via `supersededById`.

### Decisions locked during design

- **Inline at save time** (in the graph tail, after the user-visible answer) — not a background sweep.
- **Auto-supersede with audit trail** on contradiction — new fact wins; old row marked, never deleted.
- **Minimal UI**: hide superseded rows from the Memory-module list + show provenance in the detail dialog.
- **Same branch**: work continues on `agent-memory`; PR #55 grows.

### Non-goals

- Episodic capture/replay (Phase 3), procedural memory (Phase 4).
- Background reconciliation sweep (revisit only if inline proves insufficient).
- Full history UI (show-superseded toggle, supersede-chain view).
- Deep-agent reconciliation — its `save_memory` tool keeps blind-upsert semantics via `PostgresMemoryStore.batch()` (one mechanical SQL edit required, see §C, but no behavior change).
- Re-ranking recall by `accessCount`/recency (decay/reinforcement *scoring* is future work; Phase 2 only maintains the signals).

---

## Current State (grounding)

- `apps/web-ui/lib/agent/memory-nodes.ts` — `memorySaveNode`: reflector LLM extracts a JSON array of `{namespace[], key, value:{fact,source,confidence}}`, filters to high/medium confidence, loops `saveMemory(...)`.
- `apps/web-ui/lib/agent/persistence.ts` — `saveMemory` delegates to `MemoryService.remember` (kind `SEMANTIC`); `PostgresMemoryStore.batch()` still has its own raw upsert (deep-agent path).
- `apps/web-ui/lib/agent/memory/memory-service.ts` — `remember` (raw upsert with embedding, `ON CONFLICT ("tenantId","namespace","key") DO UPDATE`; ORM `upsert` fallback when no embedding), `recall` (pgvector `<=>`, filters superseded, updates access stats; returns `{namespace,key,value,kind}` — **no id, no distance**), working-memory get/put.
- `libs/prisma/schema.prisma` — `AgentMemory` has `@@unique([tenantId, namespace, key])`, plus Phase 0 scaffolding: `kind`, `sourceThreadId`, `supersededById`, `supersededAt`, `lastAccessedAt`, `accessCount`.
- `apps/web-ui/lib/db/repositories/agent-memory/` — `listByTenant` does **not** filter superseded rows (they'd show in the UI today).
- Precedents: feature gating via env flag read from `process.env` (`working-memory.ts`), non-fatal LLM/parse failure with fallback, batched-JSON judge prompts, `.superpowers/sdd/` execution flow.

---

## Design

### A. Reconcile pipeline — new `apps/web-ui/lib/agent/memory/reconcile.ts`

`memorySaveNode` stops calling `saveMemory` directly. After extraction+confidence filtering it calls:

```typescript
reconcileMemories(params: {
    tenantId: string;
    userId: string;
    facts: ExtractedFact[];          // { namespace: string[]; key: string; value: SemanticValue }
    judgeModel: BaseChatModel;       // the reflector model, passed in (provider-only)
    sourceThreadId?: string;
}): Promise<ReconcileSummary>        // counts per action, for logging
```

Pipeline per invocation:

1. **Neighbor fetch.** For each fact, `MemoryService.recall` top-K (K=5, module constant `RECONCILE_TOP_K`) similar live memories, now returning `id` and `distance`. A fact whose nearest neighbor is farther than `RECONCILE_DISTANCE_THRESHOLD` (module constant, cosine distance, initial value 0.55 — tune empirically) is treated as having no neighbors.
2. **Fast path.** Facts with no neighbors → **ADD** immediately; no LLM call. (Fresh tenants never pay judge latency.)
3. **Batched judge.** All facts *with* neighbors go to **one** LLM call. Input: per fact, the new fact + its neighbors `{id, namespace, key, fact, updatedAt}`. Output: strict JSON array of decisions:
   - `{ factIndex, action: "ADD" }` — novel despite similarity.
   - `{ factIndex, action: "UPDATE", targetId, mergedValue }` — same fact, refined/enriched; judge supplies the merged `SemanticValue`.
   - `{ factIndex, action: "SUPERSEDE", targetId }` — **explicit contradiction only** (mutually exclusive claims), never mere similarity. New fact wins.
   - `{ factIndex, action: "REINFORCE", targetId }` — semantically the same fact; nothing new.
   - `{ factIndex, action: "NOOP" }` — ephemeral/worthless; drop.
4. **Apply**, via MemoryService primitives:
   - ADD → `remember(...)` (returns new id).
   - UPDATE → `update(tenantId, targetId, mergedValue)` — value replaced in place, embedding recomputed, `updatedAt`/`expiresAt` refreshed; key/row unchanged.
   - SUPERSEDE → `remember(...)` the new fact (returns `newId`), then `supersede(tenantId, targetId, newId)` — sets `supersededById = newId`, `supersededAt = NOW()` on the old row. Old row never deleted (TTL cleans eventually); recall already filters it.
   - REINFORCE → `reinforce(tenantId, targetId)` — `expiresAt = NOW() + 90d`, `accessCount + 1`, `lastAccessedAt = NOW()`. (Deliberate overload of `accessCount` as a general "proved useful/true again" signal.)
   - NOOP → skip.
5. **Failure containment.** Judge call failure, JSON parse failure, or an unrecognized/invalid decision (bad `targetId`, missing `mergedValue`) → the affected fact(s) fall back to **ADD** (today's behavior). Per-fact apply errors are caught and logged; one bad fact never blocks the rest. `reconcileMemories` itself never throws.
6. **Gate.** `MEMORY_RECONCILE_ENABLED` env flag (read from `process.env`, same pattern as `working-memory.ts`; default **true**). Off → `memorySaveNode` uses the legacy direct-save loop, byte-for-byte.

Scoping: reconciliation is **tenant-wide**, matching `recall` (the store is effectively tenant-shared; a user's new fact may supersede another user's stale one within the same tenant).

Layering: `MemoryService` stays a pure data layer (no LLM dependency); `reconcile.ts` holds the policy, judge prompt, and orchestration.

### B. Schema — partial unique index (the one migration)

`@@unique([tenantId, namespace, key])` breaks supersede in the **common case**: a contradicted fact usually re-extracts under the *same key* (e.g. `prod-cluster-region`: us-east-1 → us-west-2), and inserting the winning row would collide with the superseded loser. Fix:

- **Drop** the full unique constraint.
- **Add** (raw SQL in the migration) a **partial unique index**:
  ```sql
  CREATE UNIQUE INDEX "agent_memories_live_tenant_ns_key"
    ON "agent_memories" ("tenantId", "namespace", "key")
    WHERE "supersededById" IS NULL;
  ```
  Only *live* rows contend for a key; superseded history rows keep their original key.
- Prisma schema: replace `@@unique([tenantId, namespace, key])` with `@@index([tenantId, namespace, key])` (lookup performance; the partial unique lives only in SQL — Prisma cannot express it).

**Ripples (all required, all small):**

1. `MemoryService.remember` raw path: conflict target becomes
   `ON CONFLICT ("tenantId","namespace","key") WHERE "supersededById" IS NULL DO UPDATE ...`
   (Postgres matches this to the partial index.)
2. `MemoryService.remember` ORM fallback: Prisma `upsert` targeted the now-removed compound unique — replace with *find live row* (`findFirst` where tenant/ns/key + `supersededById: null`) then `update` by id or `create`. (Benign race: two concurrent saves of the same new key could both pass `findFirst`; the partial unique index makes one `create` fail — catch the unique-violation and retry once as an update. Raw path is immune via ON CONFLICT.)
3. `PostgresMemoryStore.batch()` raw upsert (deep-agent path): same 1-line conflict-target edit. Behavior unchanged (still blind upsert, no reconcile) — deep-agent remains out of scope semantically.
4. `remember` now **returns the row id** (raw path: `RETURNING id`; fallback: id from update/create) — required by SUPERSEDE.

Migration is additive/non-destructive for data (constraint swap only; no rows touched). Regenerate **both** Prisma clients afterward (dual-generator gotcha).

### C. MemoryService additions (data primitives)

```typescript
// MemoryHit gains: id: string; distance?: number  (distance only on vector-search hits)
remember(m: RememberParams): Promise<string>                       // now returns row id
update(tenantId: string, id: string, value: Record<string, unknown>): Promise<void>   // re-embeds, refreshes updatedAt/expiresAt
supersede(tenantId: string, oldId: string, newId: string): Promise<void>
reinforce(tenantId: string, id: string): Promise<void>
```

All tenant-scoped in every statement (raw SQL binds `tenantId` explicitly; `$executeRaw` is not tenant-intercepted). `update`'s re-embed failure is non-fatal (keeps old embedding, still updates value).

### D. Memory-module UI (minimal)

- `listByTenant` `where` gains `supersededById: null` — stale facts vanish from the table.
- `AgentMemoryRecord` gains `supersededById: string | null`, `supersededAt: string | null`; `getById` still returns superseded rows (direct fetch).
- `memory-detail-dialog.tsx`: when `supersededAt` is present, render a small provenance line ("Superseded on <date>"). No other UI work.

### E. Configuration

| Env var | Default | Meaning |
|---------|---------|---------|
| `MEMORY_RECONCILE_ENABLED` | `true` | off → legacy direct-save loop in `memorySaveNode` |

Module constants (not env): `RECONCILE_TOP_K = 5`, `RECONCILE_DISTANCE_THRESHOLD = 0.55`.

---

## Files Touched

| File | Change |
|------|--------|
| `libs/prisma/schema.prisma` + migration | drop compound unique → `@@index` + raw-SQL partial unique index |
| `apps/web-ui/lib/agent/memory/types.ts` | `MemoryHit` gains `id`/`distance?`; `ExtractedFact`, decision types |
| `apps/web-ui/lib/agent/memory/memory-service.ts` | `remember` returns id + partial-index conflict target + ORM fallback rework; new `update`/`supersede`/`reinforce`; recall returns id+distance |
| `apps/web-ui/lib/agent/memory/reconcile.ts` | **new** — pipeline, judge prompt, apply, gate |
| `apps/web-ui/lib/agent/memory-nodes.ts` | `memorySaveNode` save-loop → `reconcileMemories` (legacy loop behind the flag) |
| `apps/web-ui/lib/agent/persistence.ts` | `PostgresMemoryStore.batch()` conflict-target edit (1 line) |
| `apps/web-ui/lib/db/repositories/agent-memory/{interface,postgres}.ts` | hide superseded in list; expose supersede fields |
| `apps/web-ui/components/memory/memory-detail-dialog.tsx` | provenance line |
| `.env.example` | document the flag |

## Testing

- **reconcile.ts (Vitest, fake judge + mocked MemoryService):** each action applies the right primitive with the right args; no-neighbor facts skip the LLM entirely; judge throw / bad JSON / bad targetId → ADD fallback; per-fact apply error doesn't block siblings; flag off → legacy path (no reconcile import executed).
- **memory-service.ts:** `remember` returns id (both raw and fallback paths); `supersede` sets both fields tenant-scoped; `reinforce` refreshes TTL + bumps count; fallback create-race retry.
- **Migration verify (live DB):** partial index exists; inserting a duplicate *live* key fails; a superseded row + same-key live row coexist.
- **Repo:** superseded rows excluded from `listByTenant`; still returned by `getById`.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Hallucinated "new fact" displaces a correct old one | Judge instructed: SUPERSEDE requires explicit mutual exclusivity, never similarity; audit trail (`supersededById`) makes displacement inspectable/recoverable |
| Judge latency in the run tail | One batched call; fast-path skips LLM when no neighbors; gated by flag |
| Partial-index migration breaks existing upserts | All three upsert sites updated in the same phase + migration-verify step; flag-off path exercises the same updated SQL (legacy loop still calls `remember`) |
| ORM-fallback race on concurrent same-key creates | Partial unique index is the backstop; catch unique-violation → retry as update |
| Double embedding per fact (recall query + remember insert) | Accepted for simplicity; noted as future optimization (pass embedding through) |

## Open Questions

None blocking. `RECONCILE_DISTANCE_THRESHOLD` is an initial guess — tune after observing real distances in logs.
