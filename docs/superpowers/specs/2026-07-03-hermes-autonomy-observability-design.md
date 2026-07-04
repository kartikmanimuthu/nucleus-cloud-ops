# Hermes Autonomy + Memory Observability

**Status:** Approved design (user directive to implement; recommended option adopted on AskUserQuestion timeout — all four features, read-only tier lock. Reversible decisions flagged in §Decisions.)
**Date:** 2026-07-03
**Branch:** `agent-memory` (continues PR #55; memory Phases 0–4 already landed)

---

## Problem / Intent

The user's goal: a **fully autonomous, Hermes-style maturing system**. The memory stack (Phases 0–4) learns facts, episodes, and rules — but three gaps keep the loop from closing autonomously, and the execution is opaque:

1. **Skill canonization is human-gated** (Promote-to-skill dialog). Hermes writes its own skills.
2. **Chat skill selection is manual** (dropdown, one skill). Hermes discovers skills dynamically by metadata match.
3. **Agent Ops — the autonomous path — has no automatic memory at all.** Exploration confirmed its executor graphs wire only optional `save_memory`/`search_memory` *tools*; no recall node, no save node, no reconcile, no episodes. Autonomous runs neither learn nor would they trigger skill creation.
4. **Observability:** memory execution can't be followed — recall logs don't show which hits were filtered or why; reconcile logs only counts, not per-fact verdicts; nothing shows what was injected into the prompt.

## Goal

Close the loop — **run → rules → skills → auto-selected in future runs** — on both execution paths, with console logs detailed enough to watch every step.

### Decisions locked during design

- **Auto-created skills are `isEnabled: true` on creation** (user-specified — full Hermes). Veto model: per-skill disable/delete in the Skills UI, or `AUTO_SKILL_CREATION_ENABLED=false` globally.
- **Auto-created skills are always `tier: 'read-only'`** — tier gates agent privileges (mutation/approval-gated); self-escalation is the one form of autonomy deliberately withheld. A human raises the tier manually if warranted. *(Reversible if the user overrides at review.)*
- **Agent Ops memory wiring included (feature D)** — without it the autonomous path cannot mature, defeating the stated intent. *(Reversible: it is an isolated feature; skipping it removes one plan task-group.)*
- **`source: 'system'` flags auto-created skills** — the Skills UI already renders a System/User badge column, so the user's "flagged as system-generated" requirement needs no UI work.
- **Observability logs are always-on** at summary level (matches the codebase's existing verbose console style); full injected-content dumps behind `MEMORY_LOG_VERBOSE` (default **true** — the user explicitly wants to see them; set false to quiet).

### Non-goals

- Multi-skill activation per run (still exactly one active skill).
- Auto-raising skill tiers; auto-editing or auto-deleting existing skills.
- Working-memory compaction (`prepareContext`) in Agent Ops — follow-up.
- Deep-agent (dropped from scope by user decision 2026-07-03).

---

## Current State (grounding — all verified this cycle)

- **Agent Ops** (`lib/agent-ops/executor-graphs.ts` + `executor-state.ts`): own parallel `ReflectionState`/`graphState` (fields: messages, taskDescription, plan, errors, reflection, iterationCount, nextAction, isComplete, toolResults, evaluation, clarificationQuestion, approvalStatus, pendingToolApprovals — **no memory fields**). Graph: `START → evaluator → {clarify | plan | generate | end}` … `final → END`. Has `reflectorModel` from `createAgentModels` (line 64). Evaluator picks `skillId` via strict-JSON prompt over `loadSkills()`; `loadAllSkillContent()` preloads a `skillContentMap`.
- **Chat route** (`app/api/chat/route.ts`): `selectedSkill` arrives `undefined` when none picked (UI maps "none" → null → `|| undefined` on the wire), normalized to `null` at `graphConfig` (line 148). The user's message text and a `resolvedModel` (`ResolvedModelConfig`) are both available **before** graph creation (lines 40, 120–139) — `createAgentModels(resolvedModel).reflector` is ready for a cheap selection call.
- **`getSkillSummaries(tenantId)`** (`lib/skill-service.ts:39`): returns a formatted string (`Available Skills:\n- slug: Name - description`); currently unused in production code.
- **Skill repo** (`repositories/skill/`): `SkillCreateInput` all-required `{slug, name, description, tier, content, source, isEnabled, createdBy, sourceRunId}`; duplicate slug raises Prisma P2002 (unique `(tenantId, slug)`); `slugify` exported from skill-service.
- **Skills UI** (`components/skills/skills-client.tsx:82-89`): Source column with System/User badge already exists.
- **`MemoryService.update(tenantId, id, value)`** replaces the whole value JSON (re-embeds; non-fatal fallback) — stamping a marker requires read-merge-write.
- **Memory nodes** (`lib/agent/memory-nodes.ts`): typed against agent-shared's `ReflectionState`; recall composes facts/rules/episodes into `memoryContext`; save runs extraction → reconcile → episode capture.
- **Reconcile** (`memory/reconcile.ts`): logs only summary counts today.

---

## Design

### A. Memory observability logs

Structured, greppable console logs at every lifecycle stage. Summary lines always; full content behind `MEMORY_LOG_VERBOSE` (env accessor in a new `lib/agent/memory/log.ts`, default true).

**Recall (`memoryRecallNode`):**
- Per layer, one line per hit with distance and verdict:
  - `🧠 [RECALL:facts] 8 hits → LLM filter kept 3 (prod-cluster-region, deploy-window, vpc-peering); dropped 5`
  - `🧠 [RECALL:rules] paginate-list-calls d=0.31 kept | verify-state-first d=0.71 dropped (> 0.65 gate)`
  - `🧠 [RECALL:episodes] thread-abc d=0.42 ✓ replayed`
- Injection summary: `🧠 [RECALL] memoryContext assembled: facts(3) rules(1) episodes(1), 1,482 chars`
- Verbose: the full composed `memoryContext` block printed once.

**Save (`memorySaveNode` + `reconcile.ts`):**
- Extraction: `🧠 [SAVE] Extracted 4 items: 3 SEMANTIC, 1 PROCEDURAL (dropped 1: low confidence)` with per-item keys.
- **Per-fact judge verdicts** (new, in `reconcile.ts` apply loop): `🧠 [JUDGE] prod-cluster-region → SUPERSEDE (displaced <id>)`, `… → REINFORCE (<id>, accessCount now visible on next recall)`, `… → ADD (no near neighbors, fast-path)` including fast-path ADDs and fallback ADDs (with reason: judge-error/invalid-decision).
- Episode + auto-skill logs (episode already logs; auto-skill in §C).

### B. Auto skill selection in chat (progressive disclosure)

New `lib/agent/auto-skill-select.ts`:

```typescript
export function autoSkillSelectionEnabled(): boolean;   // AUTO_SKILL_SELECTION_ENABLED, default true
export async function autoSelectSkill(params: {
    tenantId: string;
    message: string;                 // latest user message text
    model: ResolvedModelConfig;      // route's already-resolved model
}): Promise<{ slug: string; reasoning: string } | null>;
```

- Uses `createAgentModels(model).reflector` + `getSkillSummaries(tenantId)` with a strict-JSON prompt (`{"skillId": string | null, "reasoning": string}` — mirror of the Agent Ops evaluator contract, selection-only). Returns null on NONE, parse failure, LLM error, or empty catalog (all logged; never throws).
- **Hook (chat route, pre-graph):** when `!selectedSkill && mode !== 'deep' && autoSkillSelectionEnabled()`: call it with the latest message; on a hit, set `graphConfig.selectedSkill = slug`. Log `🎯 [SKILL AUTO-SELECT] matched 'cost-analyser' — <reasoning>` or `… no match (agent runs with skill catalog only)`.
- Runs on every no-skill message (a skill can change mid-thread as topics shift); one small reflector call of added latency, only when no skill is picked.
- **Catalog fallback:** `buildEffectiveSkillSection` gains an optional `skillCatalog` param — when no skill is active, the generic fallback block appends the `getSkillSummaries()` string (fetched at graph creation, chat agents only) so the agent always knows what skills exist ("load all available skills dynamically" — metadata always visible, one body loaded on match).
- Validation: the returned slug must exist in the tenant's enabled skills (`getSkillById`); unknown slug → treated as no-match (logged).

### C. Autonomous skill creation (full Hermes)

New `lib/agent/memory/skill-autogen.ts`:

```typescript
export function autoSkillCreationEnabled(): boolean;    // AUTO_SKILL_CREATION_ENABLED, default true
export function autoSkillMaturityThreshold(): number;   // AUTO_SKILL_MATURITY_THRESHOLD, default 3
export async function autoCreateSkillsFromMaturedRules(params: {
    tenantId: string;
    threadId?: string;               // provenance → sourceRunId
}): Promise<number>;                 // count created; never throws
```

Pipeline (called at the tail of `memorySaveNode`, after episode capture, when `PROCEDURAL_MEMORY_ENABLED` and creation flag on):
1. Query live procedural memories (`kind='PROCEDURAL'`, `supersededById IS NULL`) with `accessCount >= threshold` and **no `promotedSkillSlug` marker** in their value (tenant-scoped raw query or repo call; capped LIMIT 5 per run).
2. For each candidate: derive `slug = slugify(key)`; if a Skill with that slug already exists (any enabled state) → stamp the marker and skip (idempotence + disable-as-veto).
3. Otherwise create via `getSkillRepository().create(tenantId, {...})`:
   - `name` humanized from key, `description` = trigger, `content` = structured markdown from instruction/trigger/evidence (server-side builder mirroring `buildSkillDraftFromMemory`, marked *"Auto-generated by the agent from a matured procedural rule."*),
   - `source: 'system'`, `isEnabled: true` (user decision), `tier: 'read-only'` (locked), `createdBy: null`, `sourceRunId: threadId ?? memory.sourceThreadId`.
   - P2002 race → treat as exists (stamp + skip).
4. Stamp the memory: read current value, merge `{ promotedSkillSlug: slug }`, `MemoryService.update(...)` (re-embed is acceptable; marker survives skill deletion, so deleted skills never resurrect).
5. Log `🎯 [AUTO-SKILL] Rule 'paginate-list-calls' matured (accessCount=4) → created skill 'paginate-list-calls' (system, enabled, read-only)`.

The loop closes: matured rules become enabled skills → the auto-selector (B) and Agent Ops evaluator can pick them on the very next run.

### D. Agent Ops memory wiring

1. **Widen the shared node factories:** in `memory-nodes.ts`, type `memoryRecallNode`/`memorySaveNode` against a minimal structural interface (new, exported from `lib/agent/memory/types.ts`):
   ```typescript
   export interface MemoryNodeState {
       messages: BaseMessage[];
       taskDescription: string;
       plan: Array<{ step: string; status: string }>;
       toolResults: Array<{ toolName: string; output: string; isError: boolean; iterationIndex: number }>;
       errors: string[];
       reflection: string;
       iterationCount: number;
       isComplete: boolean;
       memoryContext: string;
   }
   ```
   Both agent-shared's and executor-state's `ReflectionState` satisfy it structurally (after 2 below). Chat agents unaffected.
2. **Executor state:** add `memoryContext: string` field + channel (reducer `(x,y) => y || x`, default `''`) to `lib/agent-ops/executor-state.ts`.
3. **Executor graph:** `START → memory_recall → evaluator`; `final → memory_save → END`. Runs ending at clarify/approval gates skip save (only completed runs learn — matches chat behavior where interrupted runs also skip). Deps: the file's existing `reflectorModel`, `tenantId`, `userId`, `store` (already imported via `getMemoryStore`).
4. **Prompt injection:** `getDynamicContext()` (and `reflectNode`'s prompt) append a `## Relevant Context from Memory\n${memoryContext}` section when non-empty — the same fragment shape the chat agents use.
5. Auto-skill creation (§C) runs inside the shared `memorySaveNode`, so Agent Ops gets it automatically.

### E. Configuration summary

| Env var | Default | Meaning |
|---|---|---|
| `MEMORY_LOG_VERBOSE` | `true` | full memoryContext + prompt-section dumps; summary lines are always on |
| `AUTO_SKILL_SELECTION_ENABLED` | `true` | chat auto-picks a skill when none selected |
| `AUTO_SKILL_CREATION_ENABLED` | `true` | matured rules auto-become enabled system skills |
| `AUTO_SKILL_MATURITY_THRESHOLD` | `3` | accessCount needed before a rule promotes |

---

## Files Touched

| File | Change |
|---|---|
| `lib/agent/memory/log.ts` (+test) | **new** — `memoryLogVerbose()` accessor + small log helpers |
| `lib/agent/memory-nodes.ts` | detailed recall/save logs; `MemoryNodeState` typing; auto-skill call at save tail |
| `lib/agent/memory/reconcile.ts` (+test) | per-fact verdict logs (incl. fallback reasons) |
| `lib/agent/auto-skill-select.ts` (+test) | **new** — feature B |
| `app/api/chat/route.ts` | pre-graph auto-selection hook |
| `lib/agent/prompt-templates.ts` | `buildEffectiveSkillSection` optional `skillCatalog` param |
| `lib/agent/fast-agent.ts`, `planning-agent.ts` | fetch catalog when no skill; pass to skill section |
| `lib/agent/memory/skill-autogen.ts` (+test) | **new** — feature C |
| `lib/agent/memory/types.ts` | `MemoryNodeState` |
| `lib/agent-ops/executor-state.ts` | `memoryContext` field + channel |
| `lib/agent-ops/executor-graphs.ts` | memory_recall/memory_save nodes + prompt injection |
| `env.ts` + `.env.example` | the four vars |
| `CLAUDE.md` | module rows |

## Testing

- **auto-select:** match → slug; NONE → null; parse garbage → null; unknown slug → null; flag off → skipped without LLM call.
- **skill-autogen:** matured unmarked rule → repo.create called with `{source:'system', isEnabled:true, tier:'read-only'}` + marker stamped; already-marked → skipped; existing slug → marker stamped, no create; P2002 → treated as exists; below threshold → untouched; flag off → no-op; never throws.
- **reconcile logs:** per-verdict lines emitted (spy on console) for each action + fallback.
- **MemoryNodeState:** compile-time — both state types assignable (tsc is the test).
- **Existing suites must stay green** (89 currently) — especially memory-nodes behavior unchanged apart from logging/auto-skill tail.
- **Manual E2E (the user's verification pass):** (1) no-skill chat message → `🎯 [SKILL AUTO-SELECT]` log + skill section in prompt (LLM_AUDIT); (2) teach a rule, repeat similar tasks 3× → watch REINFORCE verdicts → `🎯 [AUTO-SKILL] created` → System-badged enabled skill in UI → next no-skill chat auto-selects it; (3) trigger an Agent Ops event → `🧠 [RECALL]`/`[SAVE]` logs in the autonomous run.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Auto-selection latency on every no-skill message | reflector model (small/cheap); skipped entirely when a skill is selected or flag off |
| Wrong skill auto-selected | logged with reasoning; user can pin a skill manually (manual always wins); flag off |
| Skill sprawl from auto-creation | maturity threshold (rules must survive reconcile + prove out ≥3×); LIMIT 5/run; disable-as-veto is permanent (marker) |
| Auto-skill privilege escalation | tier locked to read-only at creation — code, not prompt, enforces it |
| Agent Ops graph regression | memory nodes are additive (new nodes/edges); non-fatal by contract; state field additive |
| Log noise | summary lines compact; full dumps behind `MEMORY_LOG_VERBOSE=false` |

## Open Questions

None blocking. User may override at review: the read-only tier lock (§C) and inclusion of D.
