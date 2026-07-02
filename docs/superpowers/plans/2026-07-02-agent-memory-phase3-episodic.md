# Agent Memory Phase 3 — Episodic Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture one distilled cognitive snapshot (context/reasoning/action/outcome) per tool-using run and replay the 1–2 most similar past episodes as structured few-shot experience at task start.

**Architecture:** Zero-wiring composition — a new `episode.ts` holds capture (distiller LLM with SKIP veto, one episode per thread refreshed via the Phase 2 live-unique upsert, bypassing the reconcile judge) and pure replay formatters. `memoryRecallNode` runs two typed recalls (semantic → existing LLM filter; episodic → distance-gated, no LLM) and composes both into the **existing `memoryContext` string** — fast/planning agents are untouched. `memorySaveNode` calls `captureEpisode` after the reconcile block, gated on tools-used + threadId + flag.

**Tech Stack:** TypeScript 5, LangGraph JS, PostgreSQL + pgvector (via existing MemoryService), Vitest.

## Global Constraints

- **Non-fatal everywhere:** `captureEpisode` never throws (returns boolean); episodic recall failure degrades to facts-only; capture failure/SKIP never blocks END.
- **Feature gate:** `EPISODIC_MEMORY_ENABLED` read from `process.env` (accessor pattern of `working-memory.ts`/`reconcile.ts`); default true; `'false'`/`'0'` disable BOTH capture and episodic recall. Off = byte-for-byte Phase 2 behavior.
- **Episodes bypass the reconcile judge** — straight `remember({ kind: 'EPISODIC', namespace: ['episodes'], key: 'thread-<threadId>', sourceThreadId: threadId })`.
- **Distiller model:** the node's existing `reflectorModel`, passed in — never instantiate a model.
- **Facts-only output shape unchanged:** when no episodes render, `memoryContext` must be byte-identical to today's (no added headers) — `composeMemoryContext` guarantees this.
- **Constants:** `EPISODE_RECALL_LIMIT = 2`, `EPISODE_DISTANCE_THRESHOLD = 0.65` (module constants, not env).
- **Style:** named exports, 4-space indent in `lib/` files, `@/` alias cross-dir.
- **Known tsc baseline (do not fix/count):** `persistence.ts(57)`, `persistence.test.ts(68)`, fast/planning-agent store→BaseStore, `agent-shared.ts:530-531`.
- **Deep-agent untouched.**

---

## File Structure

| File | Responsibility |
|------|----------------|
| `apps/web-ui/lib/agent/memory/episode.ts` | **new** — flag accessor, constants, distiller prompt, `captureEpisode`, `formatEpisodesSection`, `composeMemoryContext` |
| `apps/web-ui/lib/agent/memory/episode.test.ts` | **new** — capture gating/validation + formatting tests |
| `apps/web-ui/lib/agent/memory-nodes.ts` | recall: two typed recalls + composed context; save: capture call |
| `apps/web-ui/env.ts` + `.env.example` | `EPISODIC_MEMORY_ENABLED` |
| `apps/web-ui/lib/agent-memory/category.ts` | `'episodes'` category |
| `apps/web-ui/lib/db/repositories/agent-memory/postgres.ts` (+test) | list fact-column falls back to `value.outcome` |
| `CLAUDE.md` | one table row for episode.ts |

## Interfaces (locked — every task must match)

```typescript
// episode.ts
export const EPISODE_RECALL_LIMIT = 2;
export const EPISODE_DISTANCE_THRESHOLD = 0.65;
export function episodicMemoryEnabled(): boolean;
export interface CaptureEpisodeParams {
    tenantId: string;
    userId: string;
    threadId: string;
    distillerModel: BaseChatModel;
    taskDescription: string;
    plan: Array<{ step: string; status: string }>;
    toolResults: Array<{ toolName: string; output: string; isError: boolean }>;
    errors: string[];
    reflection: string;
    isComplete: boolean;
    iterationCount: number;
}
export async function captureEpisode(p: CaptureEpisodeParams): Promise<boolean>;   // true = saved
export function formatEpisodesSection(episodes: EpisodicValue[]): string;          // '' for []
export function composeMemoryContext(factsSection: string, episodesSection: string): string;
```

`EpisodicValue` (exists in `types.ts`): `{ context: string; reasoning: string; action: string; outcome: string }`.
`ReflectionState.plan` is `PlanStep[]` (`{ step: string; status: 'pending' | 'in_progress' | 'completed' | 'failed' }`) — assignable to `Array<{ step: string; status: string }>`.

---

## Task 1: episode.ts — capture + replay formatters

**Files:**
- Create: `apps/web-ui/lib/agent/memory/episode.ts`
- Create: `apps/web-ui/lib/agent/memory/episode.test.ts`

**Interfaces:**
- Consumes: `getMemoryService()` (`remember` returns `Promise<string>`); `compressToolOutput(content, maxChars)` from `./working-memory`; `EpisodicValue` from `./types`.
- Produces: everything in the Interfaces section above.

- [ ] **Step 1: Write the failing tests**

Create `apps/web-ui/lib/agent/memory/episode.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./memory-service', () => ({ getMemoryService: vi.fn() }));

import { getMemoryService } from './memory-service';
import {
    captureEpisode, formatEpisodesSection, composeMemoryContext, episodicMemoryEnabled,
} from './episode';
import type { EpisodicValue } from './types';

const mockSvc = { remember: vi.fn() };

const goodEpisode: EpisodicValue = {
    context: 'ECS service stuck in DRAINING',
    reasoning: 'cycle the tasks via force-new-deployment',
    action: 'aws ecs update-service --force-new-deployment',
    outcome: 'SUCCEEDED — service returned to steady state',
};

const distillerReturning = (content: string) =>
    ({ invoke: vi.fn().mockResolvedValue({ content }) }) as any;

const baseParams = (overrides: Record<string, unknown> = {}) => ({
    tenantId: 't1', userId: 'u1', threadId: 'th-9',
    distillerModel: distillerReturning(JSON.stringify(goodEpisode)),
    taskDescription: 'restart stuck ECS service',
    plan: [{ step: 'find service', status: 'completed' }],
    toolResults: [{ toolName: 'execute_command', output: 'service restarted', isError: false }],
    errors: [], reflection: 'looks good', isComplete: true, iterationCount: 3,
    ...overrides,
});

beforeEach(() => {
    vi.clearAllMocks();
    mockSvc.remember.mockResolvedValue('ep-row-id');
    vi.mocked(getMemoryService).mockReturnValue(mockSvc as any);
});
afterEach(() => { delete process.env.EPISODIC_MEMORY_ENABLED; });

describe('episodicMemoryEnabled', () => {
    it('defaults true; false/0 disable', () => {
        expect(episodicMemoryEnabled()).toBe(true);
        process.env.EPISODIC_MEMORY_ENABLED = 'false';
        expect(episodicMemoryEnabled()).toBe(false);
    });
});

describe('captureEpisode', () => {
    it('distills and saves an EPISODIC memory keyed by thread', async () => {
        const saved = await captureEpisode(baseParams() as any);
        expect(saved).toBe(true);
        expect(mockSvc.remember).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 't1', userId: 'u1', kind: 'EPISODIC',
            namespace: ['episodes'], key: 'thread-th-9', sourceThreadId: 'th-9',
            value: expect.objectContaining({ outcome: goodEpisode.outcome }),
        }));
    });

    it('SKIP → no save, returns false', async () => {
        const saved = await captureEpisode(baseParams({ distillerModel: distillerReturning('SKIP') }) as any);
        expect(saved).toBe(false);
        expect(mockSvc.remember).not.toHaveBeenCalled();
    });

    it('invalid distiller output (missing outcome) → no save, false', async () => {
        const bad = JSON.stringify({ context: 'c', reasoning: 'r', action: 'a' });
        const saved = await captureEpisode(baseParams({ distillerModel: distillerReturning(bad) }) as any);
        expect(saved).toBe(false);
        expect(mockSvc.remember).not.toHaveBeenCalled();
    });

    it('distiller throwing → false, does not throw', async () => {
        const boom = { invoke: vi.fn().mockRejectedValue(new Error('llm down')) } as any;
        const saved = await captureEpisode(baseParams({ distillerModel: boom }) as any);
        expect(saved).toBe(false);
    });

    it('flag off → short-circuits before invoking the distiller', async () => {
        process.env.EPISODIC_MEMORY_ENABLED = 'false';
        const distiller = distillerReturning(JSON.stringify(goodEpisode));
        const saved = await captureEpisode(baseParams({ distillerModel: distiller }) as any);
        expect(saved).toBe(false);
        expect(distiller.invoke).not.toHaveBeenCalled();
    });
});

describe('formatEpisodesSection', () => {
    it("returns '' for empty input", () => {
        expect(formatEpisodesSection([])).toBe('');
    });
    it('renders all four labeled fields', () => {
        const s = formatEpisodesSection([goodEpisode]);
        expect(s).toContain('### Past experience');
        expect(s).toContain(`**Situation:** ${goodEpisode.context}`);
        expect(s).toContain(`**Approach:** ${goodEpisode.reasoning}`);
        expect(s).toContain(`**Actions taken:** ${goodEpisode.action}`);
        expect(s).toContain(`**Outcome:** ${goodEpisode.outcome}`);
    });
});

describe('composeMemoryContext', () => {
    it('facts only → bare facts (legacy shape, no headers added)', () => {
        expect(composeMemoryContext('- [a/b] fact', '')).toBe('- [a/b] fact');
    });
    it('episodes only → episodes section as-is', () => {
        expect(composeMemoryContext('', '### Past experience\nX')).toBe('### Past experience\nX');
    });
    it('both → facts under a Known facts header, then episodes', () => {
        const s = composeMemoryContext('- [a/b] fact', '### Past experience\nX');
        expect(s).toBe('### Known facts\n- [a/b] fact\n\n### Past experience\nX');
    });
    it("both empty → ''", () => {
        expect(composeMemoryContext('', '')).toBe('');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web-ui && bunx vitest run lib/agent/memory/episode.test.ts`
Expected: FAIL — `Cannot find module './episode'`.

- [ ] **Step 3: Implement `episode.ts`**

```typescript
/**
 * episode.ts — episodic memory: capture + replay formatting (Phase 3).
 *
 * Capture: distill one cognitive snapshot (context/reasoning/action/outcome)
 * per tool-using run; the distiller may SKIP routine runs; failures are
 * first-class ("what didn't work" is the most valuable experience). One
 * episode per thread (key `thread-<threadId>`), refreshed via the live-unique
 * upsert. Episodes bypass the reconcile judge — they are historical records.
 * Replay: pure formatters that compose episodes into the memoryContext string.
 * Never throws.
 */

import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { getMemoryService } from './memory-service';
import { compressToolOutput } from './working-memory';
import type { EpisodicValue } from './types';

export const EPISODE_RECALL_LIMIT = 2;
// Looser than reconcile's 0.55 — an ANALOGOUS past experience is useful even
// when not near-identical. Initial guess — tune from recall logs.
export const EPISODE_DISTANCE_THRESHOLD = 0.65;

export function episodicMemoryEnabled(): boolean {
    const v = process.env.EPISODIC_MEMORY_ENABLED?.toLowerCase();
    return !(v === 'false' || v === '0');
}

export interface CaptureEpisodeParams {
    tenantId: string;
    userId: string;
    threadId: string;
    distillerModel: BaseChatModel;
    taskDescription: string;
    plan: Array<{ step: string; status: string }>;
    toolResults: Array<{ toolName: string; output: string; isError: boolean }>;
    errors: string[];
    reflection: string;
    isComplete: boolean;
    iterationCount: number;
}

function isNonEmptyString(v: unknown): v is string {
    return typeof v === 'string' && v.trim().length > 0;
}

const DISTILLER_SYSTEM = new SystemMessage(
    `You distill a completed agent run into ONE reusable episode for future few-shot recall.
Return ONLY a JSON object with exactly these four non-empty string fields:
{"context": "...", "reasoning": "...", "action": "...", "outcome": "..."}
- context: the task/situation the agent faced (generalized; drop ephemeral IDs unless essential).
- reasoning: the approach taken and why.
- action: the key tool calls / steps actually executed.
- outcome: whether it SUCCEEDED or FAILED, and why. Failures are valuable — capture what didn't work.
If the run was routine or unremarkable (simple lookups, trivial queries), return exactly: SKIP`,
);

export async function captureEpisode(p: CaptureEpisodeParams): Promise<boolean> {
    if (!episodicMemoryEnabled()) return false;
    try {
        const toolSummary = p.toolResults
            .map((t) => `- ${t.toolName} [${t.isError ? 'ERROR' : 'OK'}]: ${compressToolOutput(t.output, 400)}`)
            .join('\n');
        const planSummary = p.plan.length
            ? p.plan.map((s, i) => `${i + 1}. [${s.status}] ${s.step}`).join('\n')
            : '(no explicit plan)';

        const input = new HumanMessage(
            `**Task:** ${compressToolOutput(p.taskDescription || '(unknown)', 1000)}\n\n` +
            `**Plan:**\n${planSummary}\n\n` +
            `**Tool executions:**\n${compressToolOutput(toolSummary, 4000)}\n\n` +
            `**Errors:** ${p.errors.length ? p.errors.join('; ') : '(none)'}\n\n` +
            `**Reviewer reflection:** ${compressToolOutput(p.reflection || '(none)', 800)}\n\n` +
            `**Completed:** ${p.isComplete} after ${p.iterationCount} iterations.\n\n` +
            `Distill the episode now.`,
        );

        const resp = await p.distillerModel.invoke([DISTILLER_SYSTEM, input]);
        const content = typeof resp.content === 'string' ? resp.content : JSON.stringify(resp.content);
        if (content.trim() === 'SKIP') {
            console.log('🧠 [EPISODE] Distiller skipped — routine run');
            return false;
        }
        const match = content.match(/\{[\s\S]*\}/);
        if (!match) {
            console.warn('🧠 [EPISODE] No JSON object in distiller output — not saved');
            return false;
        }
        const parsed = JSON.parse(match[0]) as Partial<EpisodicValue>;
        if (!isNonEmptyString(parsed.context) || !isNonEmptyString(parsed.reasoning)
            || !isNonEmptyString(parsed.action) || !isNonEmptyString(parsed.outcome)) {
            console.warn('🧠 [EPISODE] Distiller output invalid — not saved');
            return false;
        }
        const value: EpisodicValue = {
            context: parsed.context, reasoning: parsed.reasoning,
            action: parsed.action, outcome: parsed.outcome,
        };
        await getMemoryService().remember({
            tenantId: p.tenantId, userId: p.userId, kind: 'EPISODIC',
            namespace: ['episodes'], key: `thread-${p.threadId}`,
            value: value as unknown as Record<string, unknown>,
            sourceThreadId: p.threadId,
        });
        console.log(`🧠 [EPISODE] Captured episode for thread ${p.threadId}`);
        return true;
    } catch (err: any) {
        console.warn(`🧠 [EPISODE] Capture failed (non-fatal): ${err?.message ?? err}`);
        return false;
    }
}

/** Render episodes as few-shot experience blocks; '' for empty input. */
export function formatEpisodesSection(episodes: EpisodicValue[]): string {
    if (!episodes.length) return '';
    const blocks = episodes.map((e) =>
        `**Situation:** ${e.context}\n**Approach:** ${e.reasoning}\n**Actions taken:** ${e.action}\n**Outcome:** ${e.outcome}`,
    ).join('\n\n---\n\n');
    return `### Past experience (similar previous sessions)\n${blocks}`;
}

/**
 * Compose memoryContext from facts + episodes. Facts-only returns the bare
 * facts string (byte-identical to pre-Phase-3 behavior); the "Known facts"
 * header appears only when episodes are also present.
 */
export function composeMemoryContext(factsSection: string, episodesSection: string): string {
    const facts = factsSection.trim();
    const episodes = episodesSection.trim();
    if (facts && episodes) return `### Known facts\n${facts}\n\n${episodes}`;
    if (facts) return facts;
    if (episodes) return episodes;
    return '';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web-ui && bunx vitest run lib/agent/memory/episode.test.ts`
Expected: PASS (all 12).

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/agent/memory/episode.ts apps/web-ui/lib/agent/memory/episode.test.ts
git commit -m "feat(memory): episodic capture (distiller + SKIP veto) and replay formatters"
```

---

## Task 2: Wire capture + replay into memory-nodes + env flag

**Files:**
- Modify: `apps/web-ui/lib/agent/memory-nodes.ts` (imports; recall node body :26-107; save node tail :223-228)
- Modify: `apps/web-ui/env.ts` (feature-flags block, after `MEMORY_RECONCILE_ENABLED`)
- Modify: `.env.example` (after the `MEMORY_RECONCILE_ENABLED=true` block)

**Interfaces:**
- Consumes: everything from Task 1; `getMemoryService()` (`recall({ kinds, limit, query, tenantId, userId })` → hits with `value`, `distance?`); existing node deps (`reflectorModel`, `tenantId`, `userId`); `runtimeConfig?.configurable?.thread_id` (already on the save node).

- [ ] **Step 1: env.ts + .env.example**

In `apps/web-ui/env.ts`, after `MEMORY_RECONCILE_ENABLED: z.string().optional(),` add:

```typescript
        EPISODIC_MEMORY_ENABLED: z.string().optional(),
```

In `.env.example`, after the `MEMORY_RECONCILE_ENABLED=true` line add:

```
# Episodic memory (Phase 3) — capture one distilled episode per tool-using run and
# replay similar past episodes as few-shot experience at task start.
EPISODIC_MEMORY_ENABLED=true
```

- [ ] **Step 2: memory-nodes.ts imports**

Replace `import { searchMemory, saveMemory } from "./persistence";` with:

```typescript
import { saveMemory } from "./persistence";
import { getMemoryService } from "./memory/memory-service";
import {
    captureEpisode, episodicMemoryEnabled, formatEpisodesSection, composeMemoryContext,
    EPISODE_RECALL_LIMIT, EPISODE_DISTANCE_THRESHOLD,
} from "./memory/episode";
```

and extend the type-only import:

```typescript
import type { ExtractedFact, EpisodicValue } from "./memory/types";
```

- [ ] **Step 3: Rework `memoryRecallNode` (two typed recalls + composition)**

Replace the ENTIRE body of the returned `memoryRecallNode` function — from the `let rawResults: ...` line (currently :45) through the final `return { memoryContext: relevantMemories };` (currently :106) — with:

```typescript
        // ── Semantic facts → existing LLM relevance filter ──────────────────
        let factsSection = "";
        try {
            const hits = await getMemoryService().recall({
                tenantId, userId, query, kinds: ["SEMANTIC"], limit: 10,
            });
            if (hits.length > 0) {
                console.log(`[MemoryRecall] Found ${hits.length} raw facts, filtering for relevance...`);
                const memorySummary = hits.map((m, i) =>
                    `${i + 1}. [${m.namespace}/${m.key}] ${JSON.stringify(m.value)}`
                ).join("\n");
                try {
                    const filterPrompt = new SystemMessage(
                        `You are a relevance filter. Given a user task and a list of memories from previous sessions, return ONLY the memories that are directly relevant to the current task.

Return a markdown list of relevant memories, each on its own line with the format:
- [namespace/key] One-line summary of the relevant fact

If no memories are relevant, return exactly: NONE`
                    );
                    const filterInput = new HumanMessage({
                        content: `**User Task:** ${truncateOutput(query, 2000)}

**Available Memories:**
${memorySummary}

Return only the relevant memories.`
                    });
                    const response = await reflectorModel.invoke([filterPrompt, filterInput]);
                    const content = typeof response.content === "string"
                        ? response.content
                        : JSON.stringify(response.content);
                    factsSection = (content.trim() === "NONE") ? "" : content.trim();
                } catch (err: any) {
                    console.warn(`[MemoryRecall] Relevance filter failed: ${err?.message ?? err}`);
                    factsSection = hits.slice(0, 5).map(m =>
                        `- [${m.namespace}/${m.key}] ${JSON.stringify(m.value)}`
                    ).join("\n");
                }
            }
        } catch (err: any) {
            console.warn(`[MemoryRecall] Semantic search failed: ${err?.message ?? err}`);
        }

        // ── Episodic few-shot replay — distance-gated, no LLM filter ────────
        let episodesSection = "";
        if (episodicMemoryEnabled()) {
            try {
                const eps = await getMemoryService().recall({
                    tenantId, userId, query, kinds: ["EPISODIC"], limit: EPISODE_RECALL_LIMIT,
                });
                const near = eps.filter(e => e.distance !== undefined && e.distance <= EPISODE_DISTANCE_THRESHOLD);
                if (near.length > 0) {
                    console.log(`🧠 [MEMORY RECALL] Replaying ${near.length} past episode(s)`);
                    episodesSection = formatEpisodesSection(near.map(e => e.value as unknown as EpisodicValue));
                }
            } catch (err: any) {
                console.warn(`[MemoryRecall] Episodic search failed: ${err?.message ?? err}`);
            }
        }

        const memoryContext = composeMemoryContext(factsSection, episodesSection);
        if (memoryContext) {
            console.log(`🧠 [MEMORY RECALL] Injecting relevant memories into context`);
        } else {
            console.log("[MemoryRecall] Nothing relevant found");
        }
        return { memoryContext };
```

(The guard clauses above it — store/tenantId/userId check, lastHuman extraction, `query`, the `🧠 [MEMORY RECALL] Searching...` log — stay exactly as they are.)

- [ ] **Step 4: Episode capture in `memorySaveNode`**

Immediately BEFORE the final `return {};` of `memorySaveNode` (after the extraction `try/catch` block closes at :225), add:

```typescript
        // ── Episodic capture — independent of fact extraction; never blocks END ──
        const { plan, toolResults, errors, reflection, isComplete, iterationCount } = state;
        const threadIdForEpisode = runtimeConfig?.configurable?.thread_id as string | undefined;
        if (episodicMemoryEnabled() && threadIdForEpisode && toolResults.length > 0) {
            await captureEpisode({
                tenantId, userId, threadId: threadIdForEpisode,
                distillerModel: reflectorModel,
                taskDescription, plan, toolResults, errors, reflection, isComplete, iterationCount,
            });
        }
```

- [ ] **Step 5: Verify**

Run: `cd apps/web-ui && bunx vitest run lib/agent/memory/ && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "^lib/agent/memory-nodes" || echo "no errors in memory-nodes.ts"`
Expected: all memory tests PASS (45 = 33 + 12 new); `no errors in memory-nodes.ts`.

- [ ] **Step 6: Commit**

```bash
git add apps/web-ui/lib/agent/memory-nodes.ts apps/web-ui/env.ts .env.example
git commit -m "feat(memory): episodic capture + few-shot replay wired into memory nodes"
```

---

## Task 3: Memory-module — episodes category + list fallback

**Files:**
- Modify: `apps/web-ui/lib/agent-memory/category.ts:1-5`
- Modify: `apps/web-ui/lib/db/repositories/agent-memory/postgres.ts` (`toRecord` fact mapping)
- Modify: `apps/web-ui/lib/db/repositories/agent-memory/postgres.test.ts`

**Interfaces:**
- Produces: `MemoryCategory` includes `'episodes'`; episodic rows list their `outcome` in the fact column.

- [ ] **Step 1: Write the failing test**

Append to the `describe('AgentMemoryPostgresRepository', ...)` block in `postgres.test.ts`:

```typescript
    it('maps episodic rows: category from namespace, fact falls back to outcome', async () => {
        mockPrisma.agentMemory.findFirst.mockResolvedValueOnce(makeRow({
            namespace: 'episodes',
            key: 'thread-th-9',
            kind: 'EPISODIC',
            value: { context: 'c', reasoning: 'r', action: 'a', outcome: 'SUCCEEDED — cycled tasks' },
        }));
        const repo = new AgentMemoryPostgresRepository();
        const rec = await repo.getById('t1', 'mem-1');
        expect(rec?.category).toBe('episodes');
        expect(rec?.fact).toBe('SUCCEEDED — cycled tasks');
    });
```

Run: `cd apps/web-ui && bunx vitest run lib/db/repositories/agent-memory/postgres.test.ts`
Expected: FAIL — category is `'other'` and fact is `''`.

- [ ] **Step 2: Implement**

`category.ts` — extend the type and constant (update the stale "four" comment too):

```typescript
/** UI bucket derived from an AgentMemory namespace's first path segment. */
export type MemoryCategory = 'infra' | 'user' | 'patterns' | 'errors' | 'episodes' | 'other';

/** The agent-written namespace prefixes, in the order the UI shows them. */
export const KNOWN_CATEGORIES: MemoryCategory[] = ['infra', 'user', 'patterns', 'errors', 'episodes'];
```

`postgres.ts` — in `toRecord`, change the fact mapping line to:

```typescript
        fact: asString(value.fact) ?? asString(value.outcome) ?? '',
```

- [ ] **Step 3: Run tests to verify pass**

Run: `cd apps/web-ui && bunx vitest run lib/db/repositories/agent-memory/postgres.test.ts`
Expected: PASS (all existing + 1 new).

- [ ] **Step 4: Typecheck the UI surface**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "^(lib/agent-memory/|lib/db/repositories/agent-memory/|components/memory/|lib/queries/agent-memories)" || echo "no errors"`
Expected: `no errors`. (The category union is consumed by the memory client component's filter chips — driven by `KNOWN_CATEGORIES`, so no component edits are needed; the typecheck confirms it.)

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/agent-memory/category.ts apps/web-ui/lib/db/repositories/agent-memory/postgres.ts apps/web-ui/lib/db/repositories/agent-memory/postgres.test.ts
git commit -m "feat(memory): episodes category + outcome fallback in Memory module"
```

---

## Task 4: Full verification + docs

**Files:**
- Modify: `CLAUDE.md` (Agent Architecture key-modules table, after the `memory/reconcile.ts` row)

- [ ] **Step 1: Full memory + repo suites**

Run: `cd apps/web-ui && bunx vitest run lib/agent/memory/ lib/db/repositories/agent-memory/`
Expected: all PASS (≥ 60 tests).

- [ ] **Step 2: Typecheck all touched files (exact-path grep; only pre-existing baseline allowed)**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "^(lib/agent/memory/|lib/agent/memory-nodes|lib/agent-memory/|lib/db/repositories/agent-memory/)" || echo "no new errors"`
Expected: `no new errors`.

- [ ] **Step 3: CLAUDE.md**

After the `memory/reconcile.ts` table row, add:

```markdown
| `memory/episode.ts` | Episodic memory: one distilled episode (context/reasoning/action/outcome) per tool-using run, replayed as few-shot experience via memoryContext. Gated by `EPISODIC_MEMORY_ENABLED`. |
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(memory): document episodic memory module"
```

---

## Self-Review (completed against the spec)

- **Spec §A (capture: pre-filter, distiller, SKIP, validation, thread-keyed upsert, judge bypass, non-fatal):** Task 1 (`captureEpisode` + 5 tests) + Task 2 Step 4 (call-site gating `flag && threadId && toolResults.length > 0`). ✅
- **Spec §B (replay: two typed recalls, distance gate 0.65, no second LLM, composed memoryContext, flag-gated episodic step, facts-only byte-identical):** Task 1 (`formatEpisodesSection`/`composeMemoryContext` + tests incl. legacy-shape assertion) + Task 2 Step 3. ✅
- **Spec §C (UI: episodes category + outcome fallback):** Task 3. ✅
- **Spec §D (env flag + constants):** Task 1 (accessor + constants) + Task 2 Step 1. ✅
- **Testing section:** capture gating/validation (Task 1), composition combinations (Task 1), repo mapping (Task 3); manual smoke deferred to user per spec. ✅
- **Type consistency:** `CaptureEpisodeParams`, `EpisodicValue`, `composeMemoryContext(factsSection, episodesSection)`, `EPISODE_*` constants used identically across Tasks 1–2. `PlanStep.status` union assignable to `string` — verified. ✅
- **No placeholders:** every code step carries complete code; commands carry expected output. ✅
