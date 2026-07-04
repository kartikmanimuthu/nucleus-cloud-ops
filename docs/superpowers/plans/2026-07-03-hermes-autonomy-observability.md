# Hermes Autonomy + Memory Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the autonomous maturation loop — detailed memory-lifecycle logs, auto skill selection in chat, autonomous creation of enabled system skills from matured rules, and memory wiring for the Agent Ops path.

**Architecture:** Observability is additive logging in the existing recall/save/reconcile paths (`MEMORY_LOG_VERBOSE` gates full dumps). Auto-selection is one reflector-model call in the chat route pre-graph (reusing the already-resolved model) over `getSkillSummaries()`, with a skill-catalog fallback injected via `buildEffectiveSkillSection`. Auto-creation is a tail step in the shared `memorySaveNode`: matured procedural rules (`accessCount ≥ threshold`, unmarked) become `source:'system'`, `isEnabled:true`, `tier:'read-only'` skills, tombstoned via a `promotedSkillSlug` marker in the memory value. Agent Ops gains the shared memory nodes by widening their state typing to a minimal structural `MemoryNodeState` and adding a `memoryContext` channel to executor-state.

**Tech Stack:** TypeScript 5, LangGraph JS, existing MemoryService/skill repository, Vitest.

## Global Constraints

- **Never-throws:** `autoSelectSkill` and `autoCreateSkillsFromMaturedRules` return null/0 on any failure with a `console.warn` — a broken autonomy feature must never break a run.
- **Flags (process.env accessor pattern, default true unless noted):** `MEMORY_LOG_VERBOSE`, `AUTO_SKILL_SELECTION_ENABLED`, `AUTO_SKILL_CREATION_ENABLED`, `AUTO_SKILL_MATURITY_THRESHOLD` (numeric, default 3).
- **Tier lock:** auto-created skills are ALWAYS `tier: 'read-only'` — enforced in code, never derived from rule content.
- **Manual wins:** auto-selection runs only when `selectedSkill` is falsy; an explicit user pick is never overridden.
- **Idempotence/veto:** existing slug (even disabled) blocks re-creation AND stamps the marker; deleted skills never resurrect (marker persists in the memory value).
- **Multi-tenant:** the maturity query is raw SQL — bind `tenantId` explicitly; skill creation goes through `getSkillRepository()` (tenant-scoped).
- **Log style:** `🧠 [RECALL:*]` / `🧠 [SAVE]` / `🧠 [JUDGE]` / `🎯 [SKILL AUTO-SELECT]` / `🎯 [AUTO-SKILL]` prefixes; summary lines always on; full content dumps only when `memoryLogVerbose()`.
- **Style:** named exports; 4-space indent in `lib/`; `@/` alias.
- **Known tsc baseline (do not fix/count):** `persistence.ts(57)`, `persistence.test.ts(68)`, fast/planning-agent store→BaseStore, `agent-shared.ts:530-531`.
- **Existing suites must stay green** (89 tests across `lib/agent/memory/`, `lib/db/repositories/agent-memory/`, `lib/agent-memory/`).

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/agent/memory/log.ts` (+test) | **new** — `memoryLogVerbose()` |
| `lib/agent/memory-nodes.ts` | detailed recall/save logs; nodes retyped to `MemoryNodeState`; auto-skill tail call |
| `lib/agent/memory/reconcile.ts` (+test) | per-fact `🧠 [JUDGE]` verdict logs |
| `lib/agent/memory/types.ts` | `MemoryNodeState` |
| `lib/agent/auto-skill-select.ts` (+test) | **new** — feature B |
| `app/api/chat/route.ts` | pre-graph auto-selection hook |
| `lib/agent/prompt-templates.ts` | `buildEffectiveSkillSection` third param `skillCatalog` |
| `lib/agent/fast-agent.ts`, `planning-agent.ts` | fetch catalog when no skill selected |
| `lib/agent/memory/skill-autogen.ts` (+test) | **new** — feature C |
| `lib/agent-ops/executor-state.ts` | `memoryContext` field + channel |
| `lib/agent-ops/executor-graphs.ts` | memory nodes + edges + prompt injection |
| `env.ts` + `.env.example` | four vars |
| `CLAUDE.md` | module rows |

## Interfaces (locked)

```typescript
// log.ts
export function memoryLogVerbose(): boolean;

// types.ts
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

// auto-skill-select.ts
export function autoSkillSelectionEnabled(): boolean;
export async function autoSelectSkill(params: {
    tenantId: string; message: string; model: ResolvedModelConfig;
}): Promise<{ slug: string; reasoning: string } | null>;

// skill-autogen.ts
export function autoSkillCreationEnabled(): boolean;
export function autoSkillMaturityThreshold(): number;
export async function autoCreateSkillsFromMaturedRules(params: {
    tenantId: string; threadId?: string;
}): Promise<number>;

// prompt-templates.ts
export function buildEffectiveSkillSection(
    selectedSkill?: string | null, skillContent?: string | null, skillCatalog?: string | null,
): string;
```

---

## Task 1: Observability — log.ts, env vars, recall/save/judge logs

**Files:**
- Create: `apps/web-ui/lib/agent/memory/log.ts` + `log.test.ts`
- Modify: `apps/web-ui/lib/agent/memory-nodes.ts` (recall + save log lines only)
- Modify: `apps/web-ui/lib/agent/memory/reconcile.ts` + `reconcile.test.ts`
- Modify: `apps/web-ui/env.ts` (all four vars) + `.env.example`

**Interfaces:**
- Produces: `memoryLogVerbose()`; `🧠 [JUDGE]` per-fact verdict lines.

- [ ] **Step 1: env plumbing**

`env.ts` — after `PROCEDURAL_MEMORY_ENABLED` add:

```typescript
        MEMORY_LOG_VERBOSE: z.string().optional(),
        AUTO_SKILL_SELECTION_ENABLED: z.string().optional(),
        AUTO_SKILL_CREATION_ENABLED: z.string().optional(),
        AUTO_SKILL_MATURITY_THRESHOLD: z.string().optional(),
```

`.env.example` — after the `PROCEDURAL_MEMORY_ENABLED=true` block add:

```
# Hermes autonomy + observability
# MEMORY_LOG_VERBOSE: print full injected memoryContext blocks (summary lines are always on).
# AUTO_SKILL_SELECTION_ENABLED: chat auto-picks a skill when none selected.
# AUTO_SKILL_CREATION_ENABLED: matured procedural rules auto-become enabled system skills (read-only tier).
# AUTO_SKILL_MATURITY_THRESHOLD: accessCount a rule needs before promoting.
MEMORY_LOG_VERBOSE=true
AUTO_SKILL_SELECTION_ENABLED=true
AUTO_SKILL_CREATION_ENABLED=true
AUTO_SKILL_MATURITY_THRESHOLD=3
```

- [ ] **Step 2: Write failing log.ts test**

Create `apps/web-ui/lib/agent/memory/log.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { memoryLogVerbose } from './log';

afterEach(() => { delete process.env.MEMORY_LOG_VERBOSE; });

describe('memoryLogVerbose', () => {
    it('defaults true; false/0 disable', () => {
        expect(memoryLogVerbose()).toBe(true);
        process.env.MEMORY_LOG_VERBOSE = 'false';
        expect(memoryLogVerbose()).toBe(false);
        process.env.MEMORY_LOG_VERBOSE = '0';
        expect(memoryLogVerbose()).toBe(false);
    });
});
```

Run: `cd apps/web-ui && bunx vitest run lib/agent/memory/log.test.ts` — FAIL (module not found).

- [ ] **Step 3: Implement log.ts**

```typescript
/** Memory observability: summary log lines are always on; full content dumps are gated here. */
export function memoryLogVerbose(): boolean {
    const v = process.env.MEMORY_LOG_VERBOSE?.toLowerCase();
    return !(v === 'false' || v === '0');
}
```

Run the test — PASS.

- [ ] **Step 4: Write failing reconcile verdict-log tests**

Append to `reconcile.test.ts` (uses existing helpers):

```typescript
describe('judge verdict logging', () => {
    it('logs a SUPERSEDE verdict line with the displaced id', async () => {
        const spy = vi.spyOn(console, 'log');
        mockSvc.recall.mockResolvedValue([neighbor('old-1')]);
        const judge = judgeReturning([{ factIndex: 0, action: 'SUPERSEDE', targetId: 'old-1' }]);
        await reconcileMemories({ ...base, facts: [fact('k1')], judgeModel: judge });
        expect(spy.mock.calls.some(c => String(c[0]).includes('[JUDGE]') && String(c[0]).includes('SUPERSEDE') && String(c[0]).includes('old-1'))).toBe(true);
        spy.mockRestore();
    });

    it('logs fast-path ADD when no near neighbors', async () => {
        const spy = vi.spyOn(console, 'log');
        mockSvc.recall.mockResolvedValue([]);
        await reconcileMemories({ ...base, facts: [fact('k1')], judgeModel: judgeReturning([]) });
        expect(spy.mock.calls.some(c => String(c[0]).includes('[JUDGE]') && String(c[0]).includes('ADD (no near neighbors)'))).toBe(true);
        spy.mockRestore();
    });

    it('logs fallback ADD when the judge returns no decision for a fact', async () => {
        const spy = vi.spyOn(console, 'log');
        mockSvc.recall.mockResolvedValue([neighbor('old-1')]);
        await reconcileMemories({ ...base, facts: [fact('k1')], judgeModel: judgeReturning([]) });
        expect(spy.mock.calls.some(c => String(c[0]).includes('[JUDGE]') && String(c[0]).includes('ADD (fallback'))).toBe(true);
        spy.mockRestore();
    });
});
```

Run: `bunx vitest run lib/agent/memory/reconcile.test.ts` — the three new tests FAIL.

- [ ] **Step 5: Implement reconcile verdict logs**

In `reconcile.ts`:

1. Fast-path (the no-neighbors `add` in the neighbor-fetch loop) — before `await add(fact);` add:
```typescript
            console.log(`🧠 [JUDGE] ${fact.key}: ADD (no near neighbors)`);
```
2. Neighbor context — where `withNeighbors.push(...)` happens, add:
```typescript
            console.log(`🧠 [JUDGE] ${fact.key}: ${neighbors.length} neighbor(s) — ${neighbors.map(n => `${n.key}(d=${n.distance?.toFixed(2)})`).join(', ')}`);
```
3. Apply loop — in the `!d || !isValidDecision(d, item)` branch, before `await add(item.fact);`:
```typescript
                console.log(`🧠 [JUDGE] ${item.fact.key}: ADD (fallback — ${!d ? 'no decision returned' : 'invalid decision'})`);
```
4. Per action case, add one line each before the operation:
```typescript
                case 'ADD':    console.log(`🧠 [JUDGE] ${item.fact.key}: ADD (novel despite neighbors)`); ...
                case 'UPDATE': console.log(`🧠 [JUDGE] ${item.fact.key}: UPDATE → ${d.targetId}`); ...
                case 'SUPERSEDE': console.log(`🧠 [JUDGE] ${item.fact.key}: SUPERSEDE → displacing ${d.targetId}`); ...
                case 'REINFORCE': console.log(`🧠 [JUDGE] ${item.fact.key}: REINFORCE → ${d.targetId} (TTL refreshed)`); ...
                case 'NOOP':   console.log(`🧠 [JUDGE] ${item.fact.key}: NOOP (dropped)`); ...
```

Run reconcile tests — ALL pass (16 existing + 3 new = 19).

- [ ] **Step 6: Recall/save detail logs in memory-nodes.ts**

Import: `import { memoryLogVerbose } from "./memory/log";`

**Facts block** — after `const hits = await getMemoryService().recall({...})`, replace the existing `Found N raw facts` log with:

```typescript
                console.log(`🧠 [RECALL:facts] ${hits.length} hit(s): ${hits.map(h => `${h.key}${h.distance !== undefined ? `(d=${h.distance.toFixed(2)})` : ''}`).join(', ') || '(none)'}`);
```

and after the relevance filter resolves `factsSection` (both the kept and NONE outcomes), add:

```typescript
                    console.log(`🧠 [RECALL:facts] LLM filter ${factsSection ? `kept:\n${factsSection}` : 'kept none (NONE)'}`);
```

**Rules block** — replace the current `Applying N learned operating rule(s)` log with per-hit verdicts (before the `near` filter, iterate all hits):

```typescript
                rules.forEach(r => {
                    const d = r.distance;
                    const kept = d !== undefined && d <= PROCEDURE_DISTANCE_THRESHOLD;
                    console.log(`🧠 [RECALL:rules] ${r.key} d=${d?.toFixed(2) ?? 'n/a'} ${kept ? 'kept' : `dropped (> ${PROCEDURE_DISTANCE_THRESHOLD} gate)`}`);
                });
```

**Episodes block** — same pattern with `EPISODE_DISTANCE_THRESHOLD`:

```typescript
                eps.forEach(e => {
                    const d = e.distance;
                    const kept = d !== undefined && d <= EPISODE_DISTANCE_THRESHOLD;
                    console.log(`🧠 [RECALL:episodes] ${e.key} d=${d?.toFixed(2) ?? 'n/a'} ${kept ? 'replayed' : `dropped (> ${EPISODE_DISTANCE_THRESHOLD} gate)`}`);
                });
```

**Injection summary** — replace the final `Injecting relevant memories into context` log with:

```typescript
        if (memoryContext) {
            console.log(`🧠 [RECALL] memoryContext assembled: facts(${factsSection ? 'yes' : 'no'}) rules(${proceduresSection ? 'yes' : 'no'}) episodes(${episodesSection ? 'yes' : 'no'}), ${memoryContext.length} chars`);
            if (memoryLogVerbose()) {
                console.log(`🧠 [RECALL] Injected into system prompt:\n────────\n${memoryContext}\n────────`);
            }
        } else {
            console.log("[MemoryRecall] Nothing relevant found");
        }
```

**Save extraction** — after the `toSave` filter, add:

```typescript
            const kinds = toSave.map(m => `${m.key}[${m.kind === 'PROCEDURAL' ? 'PROCEDURAL' : 'SEMANTIC'}]`).join(', ');
            console.log(`🧠 [SAVE] Extracted ${toSave.length} item(s): ${kinds || '(none)'}`);
```

- [ ] **Step 7: Verify + commit**

Run: `cd apps/web-ui && bunx vitest run lib/agent/memory/ && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "^lib/agent/memory" || echo "clean"`
Expected: all PASS (existing + new); `clean`.

```bash
git add apps/web-ui/lib/agent/memory/log.ts apps/web-ui/lib/agent/memory/log.test.ts apps/web-ui/lib/agent/memory-nodes.ts apps/web-ui/lib/agent/memory/reconcile.ts apps/web-ui/lib/agent/memory/reconcile.test.ts apps/web-ui/env.ts .env.example
git commit -m "feat(memory): lifecycle observability — per-hit recall verdicts, per-fact judge logs, verbose injection dumps"
```

---

## Task 2: MemoryNodeState — widen the shared node typing

**Files:**
- Modify: `apps/web-ui/lib/agent/memory/types.ts` (add `MemoryNodeState`)
- Modify: `apps/web-ui/lib/agent/memory-nodes.ts` (retype both node functions)

**Interfaces:**
- Produces: `MemoryNodeState` (exact shape in Interfaces section); node factories accept any state satisfying it.

- [ ] **Step 1: types.ts**

Append (needs `import type { BaseMessage } from '@langchain/core/messages';` at top):

```typescript
/**
 * Minimal structural state the shared memory nodes need. Both the chat agents'
 * ReflectionState (agent-shared.ts) and Agent Ops' ReflectionState
 * (agent-ops/executor-state.ts, once it carries memoryContext) satisfy this.
 */
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

- [ ] **Step 2: Retype the nodes**

In `memory-nodes.ts`: replace the `ReflectionState` import from `./agent-shared` with `truncateOutput` only (keep it), import `MemoryNodeState` from `./memory/types`, and change both signatures:

```typescript
    return async function memoryRecallNode(state: MemoryNodeState): Promise<{ memoryContext: string }> {
```
```typescript
    return async function memorySaveNode(state: MemoryNodeState, runtimeConfig?: any): Promise<Record<string, never>> {
```

(The recall node's returns already only ever produce `{ memoryContext }`; the save node returns `{}` — adjust the early-return `return { memoryContext: "" }` sites to match, they already do.)

- [ ] **Step 3: Verify (compile is the test)**

Run: `cd apps/web-ui && bunx vitest run lib/agent/memory/ && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "^(lib/agent/memory-nodes|lib/agent/fast-agent|lib/agent/planning-agent)" || echo "clean"`
Expected: suites PASS; `clean` — proving the chat agents still typecheck against the widened nodes.

- [ ] **Step 4: Commit**

```bash
git add apps/web-ui/lib/agent/memory/types.ts apps/web-ui/lib/agent/memory-nodes.ts
git commit -m "refactor(memory): memory nodes accept minimal structural state (MemoryNodeState)"
```

---

## Task 3: Auto skill selection in chat + catalog fallback

**Files:**
- Create: `apps/web-ui/lib/agent/auto-skill-select.ts` + `auto-skill-select.test.ts`
- Modify: `apps/web-ui/app/api/chat/route.ts:141-152`
- Modify: `apps/web-ui/lib/agent/prompt-templates.ts` (`buildEffectiveSkillSection`)
- Modify: `apps/web-ui/lib/agent/fast-agent.ts` + `planning-agent.ts` (catalog fetch)

**Interfaces:**
- Consumes: `getSkillSummaries`/`getSkillById` from `@/lib/skill-service`; `createAgentModels` from `./model-factory`; `ResolvedModelConfig` from `./agent-shared`.
- Produces: `autoSelectSkill` / `autoSkillSelectionEnabled` (Interfaces section).

- [ ] **Step 1: Write the failing tests**

Create `apps/web-ui/lib/agent/auto-skill-select.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/skill-service', () => ({
    getSkillSummaries: vi.fn(),
    getSkillById: vi.fn(),
}));
vi.mock('./model-factory', () => ({ createAgentModels: vi.fn() }));

import { getSkillSummaries, getSkillById } from '@/lib/skill-service';
import { createAgentModels } from './model-factory';
import { autoSelectSkill, autoSkillSelectionEnabled } from './auto-skill-select';

const reflectorReturning = (content: string) => ({ reflector: { invoke: vi.fn().mockResolvedValue({ content }) } });
const base = { tenantId: 't1', message: 'analyse our EC2 costs', model: {} as any };

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSkillSummaries).mockResolvedValue('Available Skills:\n- cost-analyser: Cost Analyser - analyses spend');
    vi.mocked(getSkillById).mockResolvedValue({ id: 'cost-analyser', name: 'Cost Analyser', description: 'analyses spend', tier: 'read-only' } as any);
});
afterEach(() => { delete process.env.AUTO_SKILL_SELECTION_ENABLED; });

describe('autoSkillSelectionEnabled', () => {
    it('defaults true; false disables', () => {
        expect(autoSkillSelectionEnabled()).toBe(true);
        process.env.AUTO_SKILL_SELECTION_ENABLED = 'false';
        expect(autoSkillSelectionEnabled()).toBe(false);
    });
});

describe('autoSelectSkill', () => {
    it('matches a skill and returns slug + reasoning', async () => {
        vi.mocked(createAgentModels).mockReturnValue(reflectorReturning('{"skillId": "cost-analyser", "reasoning": "cost question"}') as any);
        const res = await autoSelectSkill(base);
        expect(res).toEqual({ slug: 'cost-analyser', reasoning: 'cost question' });
    });

    it('returns null when the model answers null', async () => {
        vi.mocked(createAgentModels).mockReturnValue(reflectorReturning('{"skillId": null, "reasoning": "generic"}') as any);
        expect(await autoSelectSkill(base)).toBeNull();
    });

    it('returns null on unparseable output', async () => {
        vi.mocked(createAgentModels).mockReturnValue(reflectorReturning('sure, use the cost skill!') as any);
        expect(await autoSelectSkill(base)).toBeNull();
    });

    it('returns null for a hallucinated slug not in the tenant catalog', async () => {
        vi.mocked(getSkillById).mockResolvedValue(null);
        vi.mocked(createAgentModels).mockReturnValue(reflectorReturning('{"skillId": "made-up", "reasoning": "x"}') as any);
        expect(await autoSelectSkill(base)).toBeNull();
    });

    it('returns null when no skills exist, without an LLM call', async () => {
        vi.mocked(getSkillSummaries).mockResolvedValue('No specialized skills available.');
        const models = reflectorReturning('{}');
        vi.mocked(createAgentModels).mockReturnValue(models as any);
        expect(await autoSelectSkill(base)).toBeNull();
        expect(models.reflector.invoke).not.toHaveBeenCalled();
    });

    it('flag off → null without any calls', async () => {
        process.env.AUTO_SKILL_SELECTION_ENABLED = 'false';
        expect(await autoSelectSkill(base)).toBeNull();
        expect(createAgentModels).not.toHaveBeenCalled();
    });

    it('LLM throwing → null, does not throw', async () => {
        vi.mocked(createAgentModels).mockReturnValue({ reflector: { invoke: vi.fn().mockRejectedValue(new Error('down')) } } as any);
        expect(await autoSelectSkill(base)).toBeNull();
    });
});
```

Run: `bunx vitest run lib/agent/auto-skill-select.test.ts` — FAIL (module not found).

- [ ] **Step 2: Implement `auto-skill-select.ts`**

```typescript
/**
 * auto-skill-select.ts — Hermes-style progressive disclosure for chat.
 * When the user hasn't picked a skill, one cheap reflector-model call matches
 * the message against the tenant's skill catalog and picks a slug (or none).
 * Manual selection always wins; this runs only for unselected messages.
 * Never throws.
 */

import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import type { ResolvedModelConfig } from './agent-shared';
import { createAgentModels } from './model-factory';
import { getSkillSummaries, getSkillById } from '@/lib/skill-service';

export function autoSkillSelectionEnabled(): boolean {
    const v = process.env.AUTO_SKILL_SELECTION_ENABLED?.toLowerCase();
    return !(v === 'false' || v === '0');
}

export async function autoSelectSkill(params: {
    tenantId: string;
    message: string;
    model: ResolvedModelConfig;
}): Promise<{ slug: string; reasoning: string } | null> {
    if (!autoSkillSelectionEnabled()) return null;
    try {
        const catalog = await getSkillSummaries(params.tenantId);
        if (catalog.startsWith('No specialized skills')) return null;

        const { reflector } = createAgentModels(params.model);
        const sys = new SystemMessage(
            `You select the single most relevant skill for a user request, or none.\n\n${catalog}\n\n` +
            `Return ONLY a JSON object: {"skillId": "<slug>" | null, "reasoning": "<one short line>"}\n` +
            `Rules: pick a skill ONLY when the request clearly matches its description. When in doubt, return null.`,
        );
        const resp = await reflector.invoke([sys, new HumanMessage(params.message.slice(0, 4000))]);
        const content = typeof resp.content === 'string' ? resp.content : JSON.stringify(resp.content);
        const match = content.match(/\{[\s\S]*\}/);
        if (!match) return null;
        const parsed = JSON.parse(match[0]) as { skillId?: string | null; reasoning?: string };
        if (!parsed.skillId) {
            console.log('🎯 [SKILL AUTO-SELECT] No skill matched — agent runs with the skill catalog only');
            return null;
        }
        const skill = await getSkillById(params.tenantId, parsed.skillId);
        if (!skill) {
            console.warn(`🎯 [SKILL AUTO-SELECT] Model returned unknown skill '${parsed.skillId}' — ignoring`);
            return null;
        }
        console.log(`🎯 [SKILL AUTO-SELECT] Matched '${parsed.skillId}' — ${parsed.reasoning ?? '(no reasoning)'}`);
        return { slug: parsed.skillId, reasoning: parsed.reasoning ?? '' };
    } catch (err: any) {
        console.warn(`🎯 [SKILL AUTO-SELECT] Failed (non-fatal): ${err?.message ?? err}`);
        return null;
    }
}
```

Run the tests — ALL 8 pass.

- [ ] **Step 3: Chat route hook**

In `app/api/chat/route.ts`, add import `import { autoSelectSkill } from '@/lib/agent/auto-skill-select';`. Directly before the `const graphConfig = {` block (line ~141), insert:

```typescript
        // Hermes-style disclosure: when no skill is picked, one cheap reflector call
        // matches the message against the skill catalog. Manual selection always wins.
        let effectiveSkill: string | null = selectedSkill || null;
        if (!effectiveSkill && mode !== 'deep') {
            const lastMsg = messages[messages.length - 1];
            const lastUserText = typeof lastMsg?.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg?.content ?? '');
            const auto = await autoSelectSkill({ tenantId: resolvedTenantId, message: lastUserText, model: resolvedModel });
            if (auto) effectiveSkill = auto.slug;
        }
```

and change the graphConfig line `selectedSkill: selectedSkill || null,` to:

```typescript
            selectedSkill: effectiveSkill,  // user pick, or auto-selected (Hermes disclosure), or null
```

- [ ] **Step 4: Catalog fallback in the skill section**

`prompt-templates.ts` — extend `buildEffectiveSkillSection` with a third param and append the catalog to the generic fallback block:

```typescript
export function buildEffectiveSkillSection(
    selectedSkill?: string | null,
    skillContent?: string | null,
    skillCatalog?: string | null,
): string {
```

and change the final `return` template's closing so the catalog is appended when provided — after the `**Safety:** ...` line, before the closing backtick:

```typescript
${skillCatalog ? `\n${skillCatalog}\nIf one of these skills clearly fits the task, follow its documented intent.\n` : ''}
```

`fast-agent.ts` — where `effectiveSkillSection` is built (after the skillContent pre-fetch), replace with:

```typescript
    const skillCatalog = !selectedSkill && tenantId ? await getSkillSummaries(tenantId).catch(() => null) : null;
    const effectiveSkillSection = buildEffectiveSkillSection(selectedSkill, skillContent || null, skillCatalog);
```

(add `getSkillSummaries` to the existing `@/lib/skill-service` import). Make the same two-line change in `planning-agent.ts`.

- [ ] **Step 5: Verify + commit**

Run: `cd apps/web-ui && bunx vitest run lib/agent/ && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "^(lib/agent/auto-skill-select|lib/agent/prompt-templates|lib/agent/fast-agent|lib/agent/planning-agent|app/api/chat)" || echo "clean"`
Expected: suites PASS; `clean`.

```bash
git add apps/web-ui/lib/agent/auto-skill-select.ts apps/web-ui/lib/agent/auto-skill-select.test.ts apps/web-ui/app/api/chat/route.ts apps/web-ui/lib/agent/prompt-templates.ts apps/web-ui/lib/agent/fast-agent.ts apps/web-ui/lib/agent/planning-agent.ts
git commit -m "feat(skills): auto-selection in chat via reflector catalog match + skill-catalog fallback"
```

---

## Task 4: Autonomous skill creation from matured rules

**Files:**
- Create: `apps/web-ui/lib/agent/memory/skill-autogen.ts` + `skill-autogen.test.ts`
- Modify: `apps/web-ui/lib/agent/memory-nodes.ts` (save-node tail call)

**Interfaces:**
- Consumes: `getPrismaClient` (`@/lib/db/pg-config`), `getSkillRepository` (`@/lib/db/repository-factory` — `getBySlug`/`create`), `slugify` (`@/lib/skill-service`), `getMemoryService`.
- Produces: `autoCreateSkillsFromMaturedRules` / flags (Interfaces section).

- [ ] **Step 1: Write the failing tests**

Create `apps/web-ui/lib/agent/memory/skill-autogen.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockQueryRaw = vi.fn();
vi.mock('@/lib/db/pg-config', () => ({ getPrismaClient: () => ({ $queryRaw: mockQueryRaw }) }));
vi.mock('@/lib/db/repository-factory', () => ({ getSkillRepository: vi.fn() }));
vi.mock('./memory-service', () => ({ getMemoryService: vi.fn() }));

import { getSkillRepository } from '@/lib/db/repository-factory';
import { getMemoryService } from './memory-service';
import { autoCreateSkillsFromMaturedRules, autoSkillCreationEnabled, autoSkillMaturityThreshold } from './skill-autogen';

const mockRepo = { getBySlug: vi.fn(), create: vi.fn() };
const mockSvc = { update: vi.fn().mockResolvedValue(undefined) };

const candidate = (overrides: Record<string, unknown> = {}) => ({
    id: 'mem-1', key: 'paginate-list-calls',
    value: { instruction: 'Always paginate list calls', trigger: 'any list op', evidence: 'missed items', confidence: 'high' },
    sourceThreadId: 'th-1', accessCount: 4,
    ...overrides,
});

beforeEach(() => {
    vi.clearAllMocks();
    mockQueryRaw.mockResolvedValue([candidate()]);
    mockRepo.getBySlug.mockResolvedValue(null);
    mockRepo.create.mockResolvedValue({ id: 's1' });
    mockSvc.update.mockResolvedValue(undefined);
    vi.mocked(getSkillRepository).mockReturnValue(mockRepo as any);
    vi.mocked(getMemoryService).mockReturnValue(mockSvc as any);
});
afterEach(() => {
    delete process.env.AUTO_SKILL_CREATION_ENABLED;
    delete process.env.AUTO_SKILL_MATURITY_THRESHOLD;
});

describe('flags', () => {
    it('creation defaults true; threshold defaults 3 with env override', () => {
        expect(autoSkillCreationEnabled()).toBe(true);
        expect(autoSkillMaturityThreshold()).toBe(3);
        process.env.AUTO_SKILL_MATURITY_THRESHOLD = '5';
        expect(autoSkillMaturityThreshold()).toBe(5);
    });
});

describe('autoCreateSkillsFromMaturedRules', () => {
    it('creates an enabled, read-only, system skill and stamps the memory', async () => {
        const n = await autoCreateSkillsFromMaturedRules({ tenantId: 't1', threadId: 'th-run' });
        expect(n).toBe(1);
        expect(mockRepo.create).toHaveBeenCalledWith('t1', expect.objectContaining({
            slug: 'paginate-list-calls',
            source: 'system',
            isEnabled: true,
            tier: 'read-only',
            sourceRunId: 'th-run',
        }));
        expect(mockSvc.update).toHaveBeenCalledWith('t1', 'mem-1', expect.objectContaining({ promotedSkillSlug: 'paginate-list-calls' }));
    });

    it('existing slug → stamps marker, does not create (disable-as-veto)', async () => {
        mockRepo.getBySlug.mockResolvedValue({ id: 's-existing', isEnabled: false });
        const n = await autoCreateSkillsFromMaturedRules({ tenantId: 't1' });
        expect(n).toBe(0);
        expect(mockRepo.create).not.toHaveBeenCalled();
        expect(mockSvc.update).toHaveBeenCalled();
    });

    it('P2002 race → treated as exists, still stamps, does not throw', async () => {
        mockRepo.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
        const n = await autoCreateSkillsFromMaturedRules({ tenantId: 't1' });
        expect(n).toBe(0);
        expect(mockSvc.update).toHaveBeenCalled();
    });

    it('rule missing instruction/trigger → skipped entirely', async () => {
        mockQueryRaw.mockResolvedValue([candidate({ value: { evidence: 'e', confidence: 'high' } })]);
        const n = await autoCreateSkillsFromMaturedRules({ tenantId: 't1' });
        expect(n).toBe(0);
        expect(mockRepo.create).not.toHaveBeenCalled();
        expect(mockSvc.update).not.toHaveBeenCalled();
    });

    it('no candidates → 0, repo untouched', async () => {
        mockQueryRaw.mockResolvedValue([]);
        expect(await autoCreateSkillsFromMaturedRules({ tenantId: 't1' })).toBe(0);
        expect(getSkillRepository).not.toHaveBeenCalled();
    });

    it('flag off → 0 without querying', async () => {
        process.env.AUTO_SKILL_CREATION_ENABLED = 'false';
        expect(await autoCreateSkillsFromMaturedRules({ tenantId: 't1' })).toBe(0);
        expect(mockQueryRaw).not.toHaveBeenCalled();
    });

    it('query throwing → 0, does not throw', async () => {
        mockQueryRaw.mockRejectedValue(new Error('db down'));
        expect(await autoCreateSkillsFromMaturedRules({ tenantId: 't1' })).toBe(0);
    });
});
```

Run: `bunx vitest run lib/agent/memory/skill-autogen.test.ts` — FAIL (module not found).

- [ ] **Step 2: Implement `skill-autogen.ts`**

```typescript
/**
 * skill-autogen.ts — full-Hermes autonomous skill creation (Phase: autonomy).
 *
 * Procedural rules that keep proving out (accessCount >= threshold across
 * reconcile REINFORCEs and recalls) auto-become ENABLED skills, flagged
 * source:'system'. Tier is LOCKED to 'read-only' — privilege escalation is
 * the one autonomy deliberately withheld; a human raises the tier manually.
 * Veto: disable/delete the skill in the UI (the promotedSkillSlug marker
 * stamped into the memory prevents resurrection), or turn the flag off.
 * Never throws.
 */

import { getPrismaClient } from '@/lib/db/pg-config';
import { getSkillRepository } from '@/lib/db/repository-factory';
import { slugify } from '@/lib/skill-service';
import { getMemoryService } from './memory-service';

export function autoSkillCreationEnabled(): boolean {
    const v = process.env.AUTO_SKILL_CREATION_ENABLED?.toLowerCase();
    return !(v === 'false' || v === '0');
}

export function autoSkillMaturityThreshold(): number {
    const n = Number(process.env.AUTO_SKILL_MATURITY_THRESHOLD);
    return Number.isFinite(n) && n > 0 ? n : 3;
}

const MAX_PROMOTIONS_PER_RUN = 5;

function humanize(key: string): string {
    return key.split(/[-_]+/).filter(Boolean).map((w) => (w[0]?.toUpperCase() ?? '') + w.slice(1)).join(' ');
}

export async function autoCreateSkillsFromMaturedRules(params: {
    tenantId: string;
    threadId?: string;
}): Promise<number> {
    if (!autoSkillCreationEnabled()) return 0;
    let created = 0;
    try {
        const prisma = getPrismaClient();
        const threshold = autoSkillMaturityThreshold();
        // Raw SQL is NOT tenant-intercepted — tenantId bound explicitly.
        const candidates = await prisma.$queryRaw<Array<{
            id: string; key: string; value: Record<string, unknown>;
            sourceThreadId: string | null; accessCount: number;
        }>>`
            SELECT "id","key","value","sourceThreadId","accessCount"
            FROM agent_memories
            WHERE "tenantId" = ${params.tenantId}
              AND "kind" = 'PROCEDURAL'
              AND "supersededById" IS NULL
              AND "accessCount" >= ${threshold}
              AND ("value"->>'promotedSkillSlug') IS NULL
            ORDER BY "accessCount" DESC
            LIMIT ${MAX_PROMOTIONS_PER_RUN}
        `;
        if (!candidates.length) return 0;

        const repo = getSkillRepository();
        const svc = getMemoryService();
        for (const c of candidates) {
            try {
                const v = c.value as { instruction?: string; trigger?: string; evidence?: string };
                if (!v?.instruction || !v?.trigger) continue;
                const slug = slugify(c.key);
                if (!slug) continue;
                const stamp = () => svc.update(params.tenantId, c.id, { ...c.value, promotedSkillSlug: slug });

                const existing = await repo.getBySlug(params.tenantId, slug);
                if (existing) {
                    console.log(`🎯 [AUTO-SKILL] Rule '${c.key}' matured but skill '${slug}' already exists — marking promoted`);
                    await stamp();
                    continue;
                }
                try {
                    await repo.create(params.tenantId, {
                        slug,
                        name: humanize(c.key),
                        description: v.trigger,
                        tier: 'read-only',
                        content:
                            `## Rule\n${v.instruction}\n\n` +
                            `## When it applies\n${v.trigger}\n\n` +
                            `## Why (evidence)\n${v.evidence || '(not recorded)'}\n\n` +
                            `_Auto-generated by the agent from a matured procedural rule (accessCount ${c.accessCount})._`,
                        source: 'system',
                        isEnabled: true,
                        createdBy: null,
                        sourceRunId: params.threadId ?? c.sourceThreadId,
                    });
                    created++;
                    console.log(`🎯 [AUTO-SKILL] Rule '${c.key}' matured (accessCount=${c.accessCount}) → created skill '${slug}' (system, enabled, read-only)`);
                } catch (err) {
                    if ((err as { code?: string })?.code !== 'P2002') throw err;
                    console.log(`🎯 [AUTO-SKILL] Skill '${slug}' created concurrently — marking promoted`);
                }
                await stamp();
            } catch (err: any) {
                console.warn(`🎯 [AUTO-SKILL] Promotion failed for '${c.key}' (non-fatal): ${err?.message ?? err}`);
            }
        }
    } catch (err: any) {
        console.warn(`🎯 [AUTO-SKILL] Maturity check failed (non-fatal): ${err?.message ?? err}`);
    }
    return created;
}
```

Run the tests — ALL 9 pass.

- [ ] **Step 3: Save-node tail call**

In `memory-nodes.ts`, import `{ autoCreateSkillsFromMaturedRules }` from `./memory/skill-autogen` and, in `memorySaveNode`, after the episode-capture block and before the final `return {};`, add:

```typescript
        // Autonomous skill creation — matured rules become enabled system skills (full Hermes).
        if (proceduralMemoryEnabled()) {
            await autoCreateSkillsFromMaturedRules({ tenantId, threadId: threadIdForEpisode });
        }
```

- [ ] **Step 4: Verify + commit**

Run: `cd apps/web-ui && bunx vitest run lib/agent/memory/ && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "^lib/agent/memory" || echo "clean"`
Expected: all PASS; `clean`.

```bash
git add apps/web-ui/lib/agent/memory/skill-autogen.ts apps/web-ui/lib/agent/memory/skill-autogen.test.ts apps/web-ui/lib/agent/memory-nodes.ts
git commit -m "feat(skills): autonomous skill creation from matured procedural rules (system, enabled, read-only)"
```

---

## Task 5: Agent Ops memory wiring

**Files:**
- Modify: `apps/web-ui/lib/agent-ops/executor-state.ts` (field + channel)
- Modify: `apps/web-ui/lib/agent-ops/executor-graphs.ts` (nodes, edges, prompt injection)

**Interfaces:**
- Consumes: `createMemoryRecallNode`/`createMemorySaveNode` (now `MemoryNodeState`-typed) from `@/lib/agent/memory-nodes`.

- [ ] **Step 1: executor-state**

In the `ReflectionState` interface, after `toolResults: ToolResultEntry[];` add:

```typescript
    memoryContext: string; // Formatted memories injected by the shared memory_recall node
```

In `graphState`, add the channel:

```typescript
    memoryContext: {
        reducer: (x: string, y: string) => y || x,
        default: () => "",
    },
```

- [ ] **Step 2: executor-graphs — nodes + deps**

Add import: `import { createMemoryRecallNode, createMemorySaveNode } from "@/lib/agent/memory-nodes";`

After the models block (line ~64), add:

```typescript
    // ── Shared long-term memory nodes (recall before evaluation, save after final) ──
    const memoryDeps = { reflectorModel, tenantId, userId, store: store ?? null };
    const memoryRecallNode = createMemoryRecallNode(memoryDeps);
    const memorySaveNode = createMemorySaveNode(memoryDeps);
```

- [ ] **Step 3: Graph edges**

In the graph construction: add the two nodes and rewire START/final:

```typescript
        .addNode("memory_recall", memoryRecallNode)
        .addNode("memory_save", memorySaveNode)
```

change `.addEdge(START, "evaluator")` to:

```typescript
        .addEdge(START, "memory_recall")
        .addEdge("memory_recall", "evaluator")
```

and `.addEdge("final", END);` to:

```typescript
        .addEdge("final", "memory_save")
        .addEdge("memory_save", END);
```

(Clarify/approval-gate terminations still go straight to END — interrupted/clarifying runs don't learn, matching chat behavior.)

- [ ] **Step 4: Prompt injection**

Change `getDynamicContext` to accept and render memory:

```typescript
    function getDynamicContext(evaluation: RequestEvaluation | null, memoryContext = '') {
        ...
        const memorySection = memoryContext ? `\n## Relevant Context from Memory\n${memoryContext}\n` : '';
        ...
        return { skillSection, accountContext, mutationInstruction, mcpInstructions, memorySection };
    }
```

Then update every `getDynamicContext(...)` call site (grep — expected in `planNode`, `generateNode`, `reviseNode`, `finalNode`, `reflectNode` region) to pass `state.memoryContext` and add `${memorySection}` into the corresponding system-prompt template right after `${skillSection}`. Verify with: `grep -n "getDynamicContext(" apps/web-ui/lib/agent-ops/executor-graphs.ts` — every call site must pass the second arg.

- [ ] **Step 5: Verify + commit**

Run: `cd apps/web-ui && bunx vitest run lib/agent/memory/ lib/agent-ops/ 2>/dev/null; bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "^lib/agent-ops/" || echo "clean"`
Expected: memory suites PASS (agent-ops may have no tests — that's fine); `clean` for agent-ops files.

```bash
git add apps/web-ui/lib/agent-ops/executor-state.ts apps/web-ui/lib/agent-ops/executor-graphs.ts
git commit -m "feat(agent-ops): wire shared memory recall/save into the autonomous executor graph"
```

---

## Task 6: Full verification + docs

**Files:**
- Modify: `CLAUDE.md` (module rows)

- [ ] **Step 1: Full suites**

Run: `cd apps/web-ui && bunx vitest run lib/agent/ lib/db/repositories/agent-memory/ lib/agent-memory/`
Expected: all PASS (89 prior + ~20 new).

- [ ] **Step 2: Exact-path typecheck**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "^(lib/agent/memory/|lib/agent/memory-nodes|lib/agent/auto-skill-select|lib/agent/prompt-templates|lib/agent/fast-agent|lib/agent/planning-agent|lib/agent-ops/|app/api/chat/)" | grep -v "store: PostgresMemoryStore" || echo "no new errors"`
Expected: `no new errors` (fast/planning store→BaseStore baseline excluded).

- [ ] **Step 3: CLAUDE.md**

After the `memory/procedural.ts` row, add:

```markdown
| `memory/skill-autogen.ts` | Full-Hermes autonomy: matured procedural rules (accessCount ≥ `AUTO_SKILL_MATURITY_THRESHOLD`) auto-become enabled `source:'system'` skills, tier locked read-only. Gated by `AUTO_SKILL_CREATION_ENABLED`. |
| `auto-skill-select.ts` | Chat auto-picks a skill via a reflector catalog match when none selected (`AUTO_SKILL_SELECTION_ENABLED`); no-skill runs see the skill catalog. Agent Ops executor graphs also wire the shared memory recall/save nodes. |
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document Hermes autonomy modules"
```

---

## Self-Review (completed against the spec)

- **Spec §A (observability: per-hit recall verdicts, filter outcomes, injection summary + verbose dump, per-fact judge verdicts incl. fallback reasons, extraction detail):** Task 1. ✅
- **Spec §B (auto-select: evaluator-pattern reflector call, strict JSON, unknown-slug guard, flag, catalog fallback in skill section, manual-wins, deep-mode excluded):** Task 3. ✅
- **Spec §C (auto-create: maturity query with marker filter, slug idempotence, P2002, enabled/system/read-only, stamp-before-continue, LIMIT 5, save-node tail):** Task 4. ✅
- **Spec §D (MemoryNodeState, executor memoryContext channel, START→recall→evaluator, final→save→END, prompt injection):** Tasks 2 + 5. ✅
- **Spec §E (four env vars + .env.example):** Task 1. ✅
- **Type consistency:** `MemoryNodeState`, `autoSelectSkill` return `{slug, reasoning} | null`, `autoCreateSkillsFromMaturedRules → number`, `buildEffectiveSkillSection(selected, content, catalog?)` used identically across tasks; `SkillCreateInput` all-required fields supplied. ✅
- **No placeholders:** all code steps complete; Task 5 Step 4's call-site sweep carries an explicit grep verification. ✅
