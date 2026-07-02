# Agent Memory Phase 4 — Procedural Memory + Skills Bridge

**Status:** Approved design (bridge depth chosen autonomously — see Decisions; user to confirm at spec review)
**Date:** 2026-07-02
**Branch:** `agent-memory` (continues PR #55; Phases 0–3 already landed)
**Roadmap:** Phase 4 of 5 — the final memory layer (deep-agent unification remains as a separate effort)

---

## Problem

The agent now keeps facts accurate (Phase 2) and replays experiences (Phase 3), but it cannot **learn how to behave**. Operating rules it discovers the hard way — "always paginate AWS CLI list calls in this tenant", "check deployment state before mutating service X", "this user wants tables, not prose" — are at best captured as semantic facts and surfaced as trivia, not imperatives. And the roadmap's promise — mature rules feeding the DB-backed **Skills module** — is unbuilt: `MemoryKind.PROCEDURAL` and `ProceduralValue { instruction, trigger, evidence }` are declared with zero consumers.

The Skills module (mapped on this branch) gives us strong rails:
- `Skill` model: `source: 'user' | 'system'`, `sourceRunId`, `isEnabled`, unique `(tenantId, slug)` — **no draft/pending state**; a saved skill is live.
- **Distill precedent:** `POST /api/skills/distill` returns a draft JSON that pre-fills `SkillFormDialog`; *nothing persists until the human saves* (`useCreateSkill` → `POST /api/skills`, RBAC `create Skill`). This is the codebase's established "AI proposes → human approves" pattern.
- Exactly **one skill is active per run** (`selectedSkill`, singular) — learned rules cannot ride the skill slot and need their own injection path.

## Goal

1. **Capture** operating rules as `PROCEDURAL` memories during the existing save-time extraction, reconciled by the existing judge (rules can be contradicted, refined, and reinforced exactly like facts).
2. **Inject** the most relevant learned rules at task start as a `### Operating rules (learned)` section — same zero-wiring composition as Phase 3.
3. **Bridge**: a human-approved **"Promote to skill"** flow — procedural rows in the Memory module open the existing `SkillFormDialog` pre-filled from the rule; the human reviews, picks the tier, and saves through the existing API.

### Decisions locked during design

- **Bridge depth: human-approved promotion** (chosen autonomously when the scoping question timed out; rationale: reuses the distill flow's proven pattern, no schema change, no threshold machinery, and instruction content never goes live without review). Alternatives — auto-created disabled skills (list pollution, unreviewed content one toggle from live) and deferring the bridge (breaks the roadmap promise) — rejected. **User may override at spec review.**
- **Capture source: the existing extraction call** — one LLM call still; the extraction prompt gains an "operating rules" category emitting procedural-shaped items. No separate mining pass (YAGNI).
- **Rules ride the reconcile pipeline** — `reconcileMemories` becomes kind-aware (a rule reconciles against other rules; REINFORCE = the rule proved out again; SUPERSEDE = the rule changed).
- **Injection: similarity recall, no LLM filter** (like episodes) — limit 3, distance ≤ 0.65 (shared threshold value with episodes for one fewer knob).
- **Same branch:** PR #55 grows.

### Non-goals

- Auto-promotion, maturity thresholds, or promotion nudges ("this rule was reinforced 5×") — the promote action is available on every procedural row; human judgment decides.
- Multi-skill activation, skill content editing from the memory side, or any `Skill` schema change.
- Rule decay/expiry beyond the existing 90-day TTL + REINFORCE refresh.
- Deep-agent (still deferred).

---

## Current State (grounding)

- `apps/web-ui/lib/agent/memory/types.ts` — `ProceduralValue { instruction, trigger, evidence }` (dormant); `ExtractedFact { namespace, key, value: SemanticValue }` (no kind field); `MemoryHit` carries `kind`.
- `apps/web-ui/lib/agent/memory-nodes.ts` — `memorySaveNode`: extraction prompt has four categories, all semantic-shaped; `toSave` filter checks `value.confidence`; reconcile call maps to `ExtractedFact[]`. `memoryRecallNode`: semantic recall (LLM filter) + episodic recall (distance-gated), composed via `composeMemoryContext(facts, episodes)`.
- `apps/web-ui/lib/agent/memory/reconcile.ts` — `reconcileMemories` hardcodes `kind: 'SEMANTIC'` in its `add`/SUPERSEDE `remember` calls and `kinds: ['SEMANTIC']` in neighbor recall.
- `apps/web-ui/lib/agent/memory/episode.ts` — `composeMemoryContext(factsSection, episodesSection)` with exact-shape tests (facts-only bare; header only when both).
- Memory-module: `AgentMemoryRecord.kind` exists (Phase 0), but the client `MemoryRow` (`lib/queries/agent-memories.ts`) does **not** expose `kind`. `memory-client-component.tsx` has row actions (view/delete); `SkillFormDialog` accepts `initialDraft` and is already reused by the distill flow; `useCreateSkill` posts to `/api/skills` with RBAC.
- Env-flag + constants precedents: `MEMORY_RECONCILE_ENABLED`, `EPISODIC_MEMORY_ENABLED`, `EPISODE_*` constants.

---

## Design

### A. Capture — extraction emits procedural items

`ProceduralValue` gains `confidence?: 'high' | 'medium'` (the extraction confidence gate applies to rules too). `ExtractedFact` gains `kind?: MemoryKind` (absent = `'SEMANTIC'`, so every existing call site is unchanged) and its `value` widens to `SemanticValue | ProceduralValue`.

The extraction prompt in `memorySaveNode` gains a fifth category (only when `proceduralMemoryEnabled()`):

```
- Operating rules → kind: "PROCEDURAL", namespace: ["procedures", "<domain>"]
  A rule for HOW the agent should behave in this environment, learned from this run.
  Shape: { "kind": "PROCEDURAL", "namespace": ["procedures", "aws-cli"], "key": "paginate-list-calls",
           "value": { "instruction": "Always paginate list/describe calls", "trigger": "any AWS CLI list operation",
                      "evidence": "run truncated results at 50 items and missed the target resource", "confidence": "high" } }
  Extract a rule ONLY from a correction, a failure the run recovered from, or an explicit user preference about behavior.
```

The `toSave` filter becomes shape-aware via a pure helper `isValidExtractedItem(item)` (lives in `procedural.ts`, unit-tested): semantic items require non-empty `fact` + high/medium `confidence`; procedural items require non-empty `instruction`/`trigger`/`evidence` + high/medium `confidence`. Invalid items are dropped (logged).

### B. Reconcile becomes kind-aware

In `reconcileMemories` (small, mechanical changes):
- Neighbor recall: `kinds: [fact.kind ?? 'SEMANTIC']` — a rule reconciles only against rules.
- `add` and SUPERSEDE `remember` calls: `kind: fact.kind ?? 'SEMANTIC'`.
- Judge system prompt: one added line — "Items may be facts or operating rules; the same actions apply (a rule that changed = SUPERSEDE; the same rule re-learned = REINFORCE)."

Semantics fall out for free: a rule that keeps proving out gets REINFORCE (TTL refresh + `accessCount++` — `accessCount` becomes the rule-maturity signal the UI can sort by later); a changed rule gets an auditable SUPERSEDE.

### C. Inject — third section in the recall composition

New tiny module `apps/web-ui/lib/agent/memory/procedural.ts`:

```typescript
export const PROCEDURE_RECALL_LIMIT = 3;
export const PROCEDURE_DISTANCE_THRESHOLD = 0.65;   // shared value with episodes — one knob
export function proceduralMemoryEnabled(): boolean;  // PROCEDURAL_MEMORY_ENABLED, default true
export function formatProceduresSection(rules: ProceduralValue[]): string;
// renders: "### Operating rules (learned)\n- When <trigger>: <instruction>" per rule; '' for []
```

`memoryRecallNode` gains a third recall (between facts and episodes, only when `proceduralMemoryEnabled()`): `recall({ kinds: ['PROCEDURAL'], limit: 3, query })`, distance-gated, **no LLM filter**, with a field-validity filter (all three fields non-empty — the belt-and-suspenders the Phase 3 review suggested for episodes, applied to rules from day one).

`composeMemoryContext` gains an optional third parameter — `composeMemoryContext(factsSection, episodesSection, proceduresSection = '')` — output order: **facts → rules → episodes** (imperatives before illustrations). Exact-shape contract preserved: all existing two-arg behaviors byte-identical; the `### Known facts` header appears when facts coexist with either other section; single-section output stays bare.

### D. Skills bridge — "Promote to skill" (human-approved)

- `MemoryRow` (client type in `lib/queries/agent-memories.ts`) gains `kind: MemoryKind` (the API already returns it — repo record has carried it since Phase 0).
- New pure helper `apps/web-ui/lib/agent-memory/promote.ts`:
  ```typescript
  buildSkillDraftFromMemory(row: MemoryRow): SkillDraft | null   // null for non-procedural rows
  // name  = humanized key ("paginate-list-calls" → "Paginate List Calls")
  // description = trigger
  // tier  = 'read-only'   (safest default; human changes it in the dialog)
  // content = markdown: "## Rule\n<instruction>\n\n## When it applies\n<trigger>\n\n## Why (evidence)\n<evidence>\n\n_Learned by the agent; promoted from procedural memory._"
  ```
  (`SkillDraft` is the existing shape `SkillFormDialog` accepts as `initialDraft`.)
- `memory-client-component.tsx`: rows with `kind === 'PROCEDURAL'` get a **Promote to skill** row action; it opens the existing `SkillFormDialog` with `initialDraft = buildSkillDraftFromMemory(row)`. On save, `sourceRunId` is set to the memory's `sourceThreadId` when present (provenance, mirroring how the distill flow passes its `threadId`). Save goes through the existing `useCreateSkill` → `POST /api/skills` (RBAC `create Skill` server-side). **Nothing persists without the human clicking Save** — exactly the distill pattern.
- `MemoryRow` also gains `sourceThreadId: string | null` (repo record + client type + `toRecord` mapping — one field, needed for provenance).

### E. Configuration

| Env var | Default | Meaning |
|---------|---------|---------|
| `PROCEDURAL_MEMORY_ENABLED` | `true` | off → extraction prompt reverts to the Phase 3 four-category version, no PROCEDURAL recall section; Promote action still shown for any pre-existing procedural rows |

Constants (module, not env): `PROCEDURE_RECALL_LIMIT = 3`, `PROCEDURE_DISTANCE_THRESHOLD = 0.65`.

---

## Files Touched

| File | Change |
|------|--------|
| `apps/web-ui/lib/agent/memory/types.ts` | `ProceduralValue.confidence?`; `ExtractedFact.kind?` + value union |
| `apps/web-ui/lib/agent/memory/procedural.ts` | **new** — flag, constants, `formatProceduresSection`, `isValidExtractedItem` |
| `apps/web-ui/lib/agent/memory/procedural.test.ts` | **new** |
| `apps/web-ui/lib/agent/memory/reconcile.ts` (+test) | kind threading (neighbor recall, add/supersede remember, judge prompt line) |
| `apps/web-ui/lib/agent/memory/episode.ts` (+test) | `composeMemoryContext` optional third param |
| `apps/web-ui/lib/agent/memory-nodes.ts` | extraction 5th category + shape-aware filter; third recall section |
| `apps/web-ui/env.ts` + `.env.example` | `PROCEDURAL_MEMORY_ENABLED` |
| `apps/web-ui/lib/db/repositories/agent-memory/{interface,postgres}.ts` (+test) | expose `sourceThreadId` on the record |
| `apps/web-ui/lib/queries/agent-memories.ts` | `MemoryRow` gains `kind`, `sourceThreadId` |
| `apps/web-ui/lib/agent-memory/promote.ts` (+test) | **new** — `buildSkillDraftFromMemory` |
| `apps/web-ui/components/memory/memory-client-component.tsx` | Promote row action + `SkillFormDialog` wiring |
| `CLAUDE.md` | one table row |

## Testing

- **procedural.ts:** flag accessor; `formatProceduresSection` rendering + `''` for empty.
- **reconcile.ts:** procedural fact → neighbor recall called with `kinds: ['PROCEDURAL']`; `remember` called with `kind: 'PROCEDURAL'`; semantic default unchanged (existing 13 tests untouched).
- **episode.ts:** three-arg `composeMemoryContext` combinations; ALL existing two-arg assertions unchanged (byte-shape contract).
- **memory-nodes filter logic:** exercised via a pure `isValidExtractedItem(item)` helper (in `procedural.ts`, testable) used by the `toSave` filter.
- **promote.ts:** draft mapping for a procedural row; `null` for semantic/episodic rows.
- **Repo:** `sourceThreadId` mapped through.
- **Manual smoke (deferred, needs live provider):** teach the agent a behavioral correction, confirm a `procedures/*` row appears; new similar task shows `### Operating rules (learned)`; Promote opens the pre-filled dialog and Save creates the skill.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Extraction over-produces rules (every run "learns" something) | prompt restricts to corrections/recovered failures/explicit preferences + confidence gate; reconcile dedupes via REINFORCE |
| A wrong rule steers the agent | rules are similarity-recalled (only surface on matching triggers), auditable in the Memory module, deletable, supersedable; promotion to always-on skill requires human review |
| composeMemoryContext regression | optional third param + all existing exact-shape tests must pass unchanged |
| Cross-domain UI import (memory component → skills dialog) | both are client components in the same app; the distill flow already crosses this boundary (chat component → skills dialog) |

## Open Questions

- **Bridge depth** was chosen autonomously (human-approved promotion) — confirm or redirect at spec review.
- `PROCEDURE_DISTANCE_THRESHOLD = 0.65` shared with episodes — revisit only if rule recall proves too eager/shy in logs.
