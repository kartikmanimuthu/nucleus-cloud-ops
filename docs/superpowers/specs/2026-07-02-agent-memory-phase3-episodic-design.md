# Agent Memory Phase 3 — Episodic Memory (Capture + Replay)

**Status:** Approved design, ready for implementation planning
**Date:** 2026-07-02
**Branch:** `agent-memory` (continues PR #55; Phases 0–2 already landed)
**Roadmap:** Phase 3 of 5 (Phase 4 procedural + deep-agent unification remain)

---

## Problem

The agent learns *facts* (Phase 2 keeps them accurate) but forgets *experiences*. At END of every run, the knowledge of how the run actually went — what was asked, what approach was taken, which tool calls worked, what failed and why — evaporates. When the agent later faces a similar incident or task, it re-derives the approach from scratch instead of replaying a past experience as a few-shot example (the Hermes "experience replay" pattern).

Phase 0 laid the scaffolding deliberately: `MemoryKind.EPISODIC`, `EpisodicValue { context, reasoning, action, outcome }`, `sourceThreadId`, and kind-filtered `recall`. Nothing populates or consumes it. `ReflectionState` already carries the raw material (`taskDescription`, `plan`, `toolResults` with error flags, `errors`, `reflection`, `iterationCount`, `isComplete`).

## Goal

**Capture** one distilled cognitive snapshot per qualifying run and **replay** the 1–2 most similar past episodes at task start, formatted as structured experience alongside (but distinct from) semantic facts.

### Decisions locked during design

- **Capture policy:** only runs that executed tools (deterministic pre-filter — no LLM cost for chat-only turns); the distiller LLM may still return `SKIP` for routine runs; **failures are captured** (outcome states success/failure and why).
- **Approach: zero-wiring composition.** Capture and replay live entirely in `memory-nodes.ts` + a new `episode.ts`; the replay is composed into the **existing `memoryContext` string**, so fast/planning agents and their 5 prompt sites are untouched.
- **One episode per thread, refreshed:** key `thread-<threadId>`, upserted via the Phase 2 live-unique index. Store stays bounded; a thread's episode always reflects its latest state. (Episode-per-run append rejected: unbounded growth, needs pruning — YAGNI.)
- **Episodes bypass the reconcile judge:** they are historical records with no contradiction semantics; straight `remember`.
- **Minimal UI:** `'episodes'` category + a sensible list-column fallback; no episode-browser.
- **Same branch:** PR #55 grows.

### Non-goals

- Procedural memory / Skills bridge (Phase 4).
- Episode pruning, decay, or cross-thread episode merging.
- A dedicated episode-browser UI.
- Deep-agent (still deferred).
- Changing semantic recall behavior (the `kinds: ['SEMANTIC']` filter added below is a no-op today — only semantic rows exist — but keeps episodes out of the facts list going forward).

---

## Current State (grounding)

- `apps/web-ui/lib/agent/memory-nodes.ts` — `memoryRecallNode`: single `searchMemory(tenantId, userId, [], query, 10)` (all kinds) → LLM relevance filter → `memoryContext` string injected as `## Relevant Context from Memory` in all agent prompts. `memorySaveNode` (has `runtimeConfig` → `thread_id` since Phase 2): extraction → `reconcileMemories` (SEMANTIC) behind `MEMORY_RECONCILE_ENABLED`.
- `apps/web-ui/lib/agent/memory/types.ts` — `EpisodicValue { context, reasoning, action, outcome }`, `MemoryHit { id, namespace, key, value, kind, distance? }`.
- `apps/web-ui/lib/agent/memory/memory-service.ts` — `recall({ kinds, limit, ... })` returns distance on vector hits; `remember({ kind, namespace, key, sourceThreadId, ... })` upserts live rows (partial unique index).
- `apps/web-ui/lib/agent/agent-shared.ts` — `ReflectionState` fields available in `memorySaveNode`'s state: `taskDescription`, `plan` (PlanStep[]), `toolResults` (ToolResultEntry[]: toolName/output/isError/iterationIndex), `errors`, `reflection`, `iterationCount`, `isComplete`, `messages`.
- `apps/web-ui/lib/agent-memory/category.ts` — `KNOWN_CATEGORIES = ['infra', 'user', 'patterns', 'errors']`; namespace prefix → category; unknown → `'other'`.
- Repo `toRecord` (`repositories/agent-memory/postgres.ts`): `fact: asString(value.fact) ?? ''` — episodic values have no `.fact`, so the list column would render empty.
- Precedents: env-flag accessors reading `process.env`, non-fatal LLM steps, `compressToolOutput` for transcript compression, per-phase spec/plan/SDD flow.

---

## Design

### A. Capture — new `apps/web-ui/lib/agent/memory/episode.ts`

```typescript
export function episodicMemoryEnabled(): boolean;   // EPISODIC_MEMORY_ENABLED, default true ('false'/'0' disable)

export interface CaptureEpisodeParams {
    tenantId: string;
    userId: string;
    threadId: string;
    distillerModel: BaseChatModel;      // the reflector model, passed in
    taskDescription: string;
    plan: Array<{ step: string; status: string }>;
    toolResults: Array<{ toolName: string; output: string; isError: boolean }>;
    errors: string[];
    reflection: string;
    isComplete: boolean;
    iterationCount: number;
}
export async function captureEpisode(p: CaptureEpisodeParams): Promise<boolean>;  // true = saved
```

`captureEpisode` (never throws; returns false on skip/failure):
1. Builds a distiller prompt from the run summary (tool outputs compressed via `compressToolOutput`, capped transcript).
2. Distiller returns strict JSON `{ "context": ..., "reasoning": ..., "action": ..., "outcome": ... }` — or the literal `SKIP` when the run was routine/unremarkable. The prompt requires `outcome` to state success or failure **and why**; failed runs are explicitly worth capturing.
3. Validates all four fields are non-empty strings; anything else → no save, `false`.
4. Saves via `getMemoryService().remember({ tenantId, userId, kind: 'EPISODIC', namespace: ['episodes'], key: 'thread-' + threadId, value, sourceThreadId: threadId })` — the live-unique index makes repeat captures on the same thread a refresh, not a duplicate.

**Call site** — `memorySaveNode`, after the existing reconcile/save block (independent of it):

```
if (episodicMemoryEnabled() && threadId && toolResults.length > 0) → captureEpisode(...)
```

Chat-only turns (no tools) never invoke the distiller. Capture failure/SKIP is logged and never blocks END.

### B. Replay — `memoryRecallNode` rework

Replace the single untyped `searchMemory` with two typed recalls via `getMemoryService()`:

1. **Semantic:** `recall({ kinds: ['SEMANTIC'], limit: 10, query })` → existing LLM relevance filter, unchanged.
2. **Episodic** (only when `episodicMemoryEnabled()`): `recall({ kinds: ['EPISODIC'], limit: EPISODE_RECALL_LIMIT (2), query })` → keep hits with `distance !== undefined && distance <= EPISODE_DISTANCE_THRESHOLD (0.65)` (looser than reconcile's 0.55 — an *analogous* experience is useful even when not near-identical). **No second LLM call.** Flag off → this step is skipped entirely (facts-only, byte-for-byte Phase 2 behavior).

`memoryContext` becomes a composed string:

```
### Known facts
<filtered fact lines — existing format>

### Past experience (similar previous sessions)
**Situation:** <context>
**Approach:** <reasoning>
**Actions taken:** <action>
**Outcome:** <outcome>
```

Formatting lives in a pure exported helper `formatEpisodesSection(episodes: EpisodicValue[]): string` in `episode.ts` (returns `''` for empty input). When only one section has content, only that section renders; when both are empty, `memoryContext` stays `''` (existing downstream behavior preserved). Since the composed string flows through the existing `memoryContext` channel, **zero changes to fast-agent.ts / planning-agent.ts**.

Failure containment: episodic recall failure degrades to facts-only (log + continue); the recall node never throws (existing contract).

### C. Memory-module UI (minimal)

- `apps/web-ui/lib/agent-memory/category.ts`: add `'episodes'` to `KNOWN_CATEGORIES` and the `MemoryCategory` type — list badge + multi-select filter work automatically (both are driven by the constant).
- Repo `toRecord`: `fact: asString(value.fact) ?? asString(value.outcome) ?? ''` — episodic rows show their outcome (their most informative one-liner) in the list's fact column. `source` stays null for episodes; detail dialog already renders the full raw value JSON.

### D. Configuration

| Env var | Default | Meaning |
|---------|---------|---------|
| `EPISODIC_MEMORY_ENABLED` | `true` | off → no capture and no episodic recall (facts-only, byte-for-byte Phase 2 behavior) |

Module constants (not env): `EPISODE_RECALL_LIMIT = 2`, `EPISODE_DISTANCE_THRESHOLD = 0.65`.

---

## Files Touched

| File | Change |
|------|--------|
| `apps/web-ui/lib/agent/memory/episode.ts` | **new** — flag accessor, distiller prompt, `captureEpisode`, `formatEpisodesSection`, constants |
| `apps/web-ui/lib/agent/memory/episode.test.ts` | **new** — capture gating/validation + formatting tests |
| `apps/web-ui/lib/agent/memory-nodes.ts` | recall: two typed recalls + composed memoryContext; save: episode capture call |
| `apps/web-ui/env.ts` | `EPISODIC_MEMORY_ENABLED` |
| `.env.example` | document the flag |
| `apps/web-ui/lib/agent-memory/category.ts` | `'episodes'` category |
| `apps/web-ui/lib/db/repositories/agent-memory/postgres.ts` (+test) | fact-column fallback to `value.outcome` |
| `CLAUDE.md` | one table row for episode.ts |

## Testing

- **episode.ts (Vitest, fake distiller + mocked getMemoryService):** captures and saves with correct key/namespace/kind; distiller `SKIP` → no save, returns false; invalid/partial JSON → no save, non-fatal; distiller throw → non-fatal false; flag off → short-circuits before the LLM; `formatEpisodesSection` renders all four fields and returns `''` on empty.
- **memory-nodes recall composition:** the composed-context logic is exercised through `formatEpisodesSection` + a small pure `composeMemoryContext(factsSection, episodesSection)` helper (also in episode.ts, tested for the four empty/non-empty combinations); the node itself stays typecheck-verified (no existing node test harness).
- **Repo test:** episodic-value row maps `fact` → outcome string; category `'episodes'` derived from namespace.
- **Manual smoke (deferred to user, needs live provider):** run a tool-using session, confirm `🧠 [EPISODE]` capture log + a row in the Memory module under category `episodes`; start a similar new thread and confirm the `### Past experience` block appears in the recall log.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Episode noise from trivial runs | tools-required pre-filter + distiller SKIP veto |
| Stale episode misleads on a repurposed thread | one-per-thread refresh means the episode always reflects the thread's latest state |
| Extra LLM call in run tail | only tool-using runs; single call; non-fatal; flag to disable |
| Irrelevant episode injected (no LLM filter on replay) | limit 2 + distance gate 0.65; structured format makes irrelevance cheap for the agent to ignore |
| `memoryContext` grows | facts already LLM-filtered; episodes capped at 2 compact blocks |

## Open Questions

None blocking. `EPISODE_DISTANCE_THRESHOLD = 0.65` is an initial guess — tune from recall logs alongside the reconcile threshold.
