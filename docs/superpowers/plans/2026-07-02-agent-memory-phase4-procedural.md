# Agent Memory Phase 4 — Procedural Memory + Skills Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agent learns operating rules (`PROCEDURAL` memories) from corrections/failures/preferences, applies the most relevant ones as an `### Operating rules (learned)` prompt section, and matured rules can be promoted — with human review — into full DB-backed Skills.

**Architecture:** Capture rides the existing extraction LLM call (a fifth, flag-gated category emitting `{instruction, trigger, evidence, confidence}` items) and the existing reconcile pipeline made kind-aware (rules dedupe/supersede/reinforce against rules). Injection is a third distance-gated recall composed into the existing `memoryContext` (facts → rules → episodes; zero agent-file changes). The Skills bridge reuses the distill flow's pattern verbatim: a "Promote to skill" action on procedural rows pre-fills the existing `SkillFormDialog`; nothing persists until the human saves via the RBAC-enforced `POST /api/skills`.

**Tech Stack:** TypeScript 5, LangGraph JS, existing MemoryService (pgvector), React 19 + TanStack Query (UI task), Vitest.

## Global Constraints

- **Feature gate:** `PROCEDURAL_MEMORY_ENABLED` (process.env accessor pattern; default true; `'false'`/`'0'` disable). Off → extraction prompt reverts to the Phase 3 four-category text and no procedural recall section.
- **Kind-aware reconcile defaults:** `fact.kind ?? 'SEMANTIC'` everywhere — absent kind must behave byte-identically to Phase 3 (existing 13 reconcile tests must pass unchanged).
- **`composeMemoryContext` exact-shape contract:** all existing two-arg behaviors byte-identical (facts-only bare; header only with company); new third param defaults `''`. Output order: facts → procedures → episodes.
- **Legacy (reconcile-off) save loop stays semantic-only:** procedural items are skipped with a log when `MEMORY_RECONCILE_ENABLED=false` — rules are a new feature that rides reconcile; the off-switch remains a clean rollback to old behavior.
- **Promotion is human-approved only:** no DB write from the memory side; the existing `SkillFormDialog` → `useCreateSkill` → `POST /api/skills` path (RBAC `create Skill`) is the only persistence route. `sourceRunId` carries the memory's `sourceThreadId` for provenance.
- **Non-fatal:** procedural recall failure degrades to facts+episodes; invalid extracted items are dropped, never crash the node.
- **Style:** named exports; 4-space indent in `lib/`, 2-space in `components/` (match surrounding); `@/` alias.
- **Known tsc baseline (do not fix/count):** `persistence.ts(57)`, `persistence.test.ts(68)`, fast/planning-agent store→BaseStore, `agent-shared.ts:530-531`.
- **Deep-agent untouched.**

---

## File Structure

| File | Responsibility |
|------|----------------|
| `apps/web-ui/lib/agent/memory/types.ts` | `ProceduralValue.confidence?`; `ExtractedFact.kind?` + value union |
| `apps/web-ui/lib/agent/memory/procedural.ts` (+test) | **new** — flag, constants, `formatProceduresSection`, `isValidExtractedItem` |
| `apps/web-ui/lib/agent/memory/episode.ts` (+test) | `composeMemoryContext` gains optional third param |
| `apps/web-ui/lib/agent/memory/reconcile.ts` (+test) | kind threading |
| `apps/web-ui/lib/agent/memory-nodes.ts` | extraction 5th category + shape-aware filter; third recall section |
| `apps/web-ui/env.ts` + `.env.example` | `PROCEDURAL_MEMORY_ENABLED` |
| `apps/web-ui/lib/db/repositories/agent-memory/{interface,postgres}.ts` (+test) | expose `sourceThreadId` |
| `apps/web-ui/lib/queries/agent-memories.ts` | `MemoryRow` gains `kind`, `sourceThreadId` |
| `apps/web-ui/lib/agent-memory/promote.ts` (+test) | **new** — `buildSkillDraftFromMemory` |
| `apps/web-ui/components/memory/memory-client-component.tsx` | Promote action + `SkillFormDialog` wiring |
| `CLAUDE.md` | one table row |

## Interfaces (locked — every task must match)

```typescript
// types.ts changes
export interface ProceduralValue { instruction: string; trigger: string; evidence: string; confidence?: 'high' | 'medium'; }
export interface ExtractedFact {
    kind?: MemoryKind;                      // absent = 'SEMANTIC'
    namespace: string[];
    key: string;
    value: SemanticValue | ProceduralValue;
}

// procedural.ts
export const PROCEDURE_RECALL_LIMIT = 3;
export const PROCEDURE_DISTANCE_THRESHOLD = 0.65;
export function proceduralMemoryEnabled(): boolean;
export function formatProceduresSection(rules: ProceduralValue[]): string;   // '' for []
export function isValidExtractedItem(item: { kind?: string; value?: Record<string, unknown> }): boolean;

// episode.ts
export function composeMemoryContext(factsSection: string, episodesSection: string, proceduresSection?: string): string;

// promote.ts (client-safe, pure)
export interface SkillDraft { name: string; description: string; tier: string; content: string; }
export function buildSkillDraftFromMemory(row: MemoryRow): SkillDraft | null;  // null unless kind==='PROCEDURAL' with instruction+trigger

// MemoryRow (lib/queries/agent-memories.ts) gains:
kind: MemoryKind;
sourceThreadId: string | null;

// AgentMemoryRecord (repo interface) gains:
sourceThreadId: string | null;
```

`SkillFormDialog` (existing, reused as-is): props `{ open, onOpenChange, initialDraft?: { name; description; tier; content } | null, sourceRunId?: string | null }` — create-mode submit posts via `useCreateSkill` with `sourceRunId`.

---

## Task 1: Types, procedural.ts core, composeMemoryContext third param

**Files:**
- Modify: `apps/web-ui/lib/agent/memory/types.ts` (ProceduralValue, ExtractedFact)
- Create: `apps/web-ui/lib/agent/memory/procedural.ts`
- Create: `apps/web-ui/lib/agent/memory/procedural.test.ts`
- Modify: `apps/web-ui/lib/agent/memory/episode.ts` (composeMemoryContext only)
- Modify: `apps/web-ui/lib/agent/memory/episode.test.ts` (append 3-arg tests; existing tests untouched)

**Interfaces:**
- Consumes: `ProceduralValue`/`MemoryKind` from `./types`.
- Produces: everything in the Interfaces section above.

- [ ] **Step 1: types.ts edits**

Replace the `ProceduralValue` line with:

```typescript
export interface ProceduralValue { instruction: string; trigger: string; evidence: string; confidence?: 'high' | 'medium'; }
```

Replace the `ExtractedFact` interface with:

```typescript
export interface ExtractedFact {
    /** Memory layer this item belongs to; absent = 'SEMANTIC'. */
    kind?: MemoryKind;
    namespace: string[];
    key: string;
    value: SemanticValue | ProceduralValue;
}
```

- [ ] **Step 2: Write the failing tests**

Create `apps/web-ui/lib/agent/memory/procedural.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import {
    proceduralMemoryEnabled, formatProceduresSection, isValidExtractedItem,
    PROCEDURE_RECALL_LIMIT, PROCEDURE_DISTANCE_THRESHOLD,
} from './procedural';

afterEach(() => { delete process.env.PROCEDURAL_MEMORY_ENABLED; });

describe('proceduralMemoryEnabled', () => {
    it('defaults true; false/0 disable', () => {
        expect(proceduralMemoryEnabled()).toBe(true);
        process.env.PROCEDURAL_MEMORY_ENABLED = 'false';
        expect(proceduralMemoryEnabled()).toBe(false);
    });
});

describe('constants', () => {
    it('locked values', () => {
        expect(PROCEDURE_RECALL_LIMIT).toBe(3);
        expect(PROCEDURE_DISTANCE_THRESHOLD).toBe(0.65);
    });
});

describe('formatProceduresSection', () => {
    it("returns '' for empty input", () => {
        expect(formatProceduresSection([])).toBe('');
    });
    it('renders one "- When <trigger>: <instruction>" line per rule under the header', () => {
        const s = formatProceduresSection([
            { instruction: 'Always paginate list calls', trigger: 'any AWS CLI list operation', evidence: 'e1' },
            { instruction: 'Verify state before mutation', trigger: 'any resource mutation', evidence: 'e2' },
        ]);
        expect(s).toBe(
            '### Operating rules (learned)\n' +
            '- When any AWS CLI list operation: Always paginate list calls\n' +
            '- When any resource mutation: Verify state before mutation',
        );
    });
});

describe('isValidExtractedItem', () => {
    const semantic = (v: Record<string, unknown>) => ({ value: v });
    const procedural = (v: Record<string, unknown>) => ({ kind: 'PROCEDURAL', value: v });

    it('semantic: requires non-empty fact + high/medium confidence', () => {
        expect(isValidExtractedItem(semantic({ fact: 'x', confidence: 'high' }))).toBe(true);
        expect(isValidExtractedItem(semantic({ fact: 'x', confidence: 'low' }))).toBe(false);
        expect(isValidExtractedItem(semantic({ fact: '  ', confidence: 'high' }))).toBe(false);
        expect(isValidExtractedItem(semantic({ confidence: 'high' }))).toBe(false);
    });

    it('procedural: requires non-empty instruction/trigger/evidence + high/medium confidence', () => {
        expect(isValidExtractedItem(procedural({ instruction: 'i', trigger: 't', evidence: 'e', confidence: 'medium' }))).toBe(true);
        expect(isValidExtractedItem(procedural({ instruction: 'i', trigger: 't', confidence: 'high' }))).toBe(false);
        expect(isValidExtractedItem(procedural({ instruction: 'i', trigger: 't', evidence: '', confidence: 'high' }))).toBe(false);
        expect(isValidExtractedItem(procedural({ instruction: 'i', trigger: 't', evidence: 'e', confidence: 'low' }))).toBe(false);
    });

    it('rejects missing/non-object value', () => {
        expect(isValidExtractedItem({} as any)).toBe(false);
        expect(isValidExtractedItem({ value: undefined } as any)).toBe(false);
    });
});
```

Append to `episode.test.ts` (inside or after the existing `composeMemoryContext` describe — new describe keeps it clean):

```typescript
describe('composeMemoryContext with procedures (third arg)', () => {
    it('third arg defaults empty — two-arg behavior unchanged', () => {
        expect(composeMemoryContext('- [a/b] fact', '')).toBe('- [a/b] fact');
    });
    it('all three → facts header, procedures, episodes in order', () => {
        const s = composeMemoryContext('- [a/b] fact', '### Past experience\nE', '### Operating rules (learned)\nR');
        expect(s).toBe('### Known facts\n- [a/b] fact\n\n### Operating rules (learned)\nR\n\n### Past experience\nE');
    });
    it('procedures only → section as-is', () => {
        expect(composeMemoryContext('', '', '### Operating rules (learned)\nR')).toBe('### Operating rules (learned)\nR');
    });
    it('procedures + episodes (no facts) → joined, no facts header', () => {
        expect(composeMemoryContext('', '### Past experience\nE', '### Operating rules (learned)\nR'))
            .toBe('### Operating rules (learned)\nR\n\n### Past experience\nE');
    });
    it('facts + procedures (no episodes) → facts header + procedures', () => {
        expect(composeMemoryContext('- f', '', '### Operating rules (learned)\nR'))
            .toBe('### Known facts\n- f\n\n### Operating rules (learned)\nR');
    });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/web-ui && bunx vitest run lib/agent/memory/procedural.test.ts lib/agent/memory/episode.test.ts`
Expected: procedural.test.ts FAILS (module not found); episode.test.ts new describe FAILS (third arg ignored / wrong output).

- [ ] **Step 4: Implement**

Create `apps/web-ui/lib/agent/memory/procedural.ts`:

```typescript
/**
 * procedural.ts — procedural memory (Phase 4): learned operating rules.
 *
 * Capture rides the memory-save extraction (kind: 'PROCEDURAL' items) and the
 * kind-aware reconcile pipeline. This module holds the flag, recall constants,
 * the prompt-section formatter, and the shape-aware extraction-item validator.
 */

import type { ProceduralValue } from './types';

export const PROCEDURE_RECALL_LIMIT = 3;
// Shared value with EPISODE_DISTANCE_THRESHOLD — one knob until logs say otherwise.
export const PROCEDURE_DISTANCE_THRESHOLD = 0.65;

export function proceduralMemoryEnabled(): boolean {
    const v = process.env.PROCEDURAL_MEMORY_ENABLED?.toLowerCase();
    return !(v === 'false' || v === '0');
}

function isNonEmptyString(v: unknown): v is string {
    return typeof v === 'string' && v.trim().length > 0;
}

/** Render learned rules as an imperative prompt section; '' for empty input. */
export function formatProceduresSection(rules: ProceduralValue[]): string {
    if (!rules.length) return '';
    const lines = rules.map((r) => `- When ${r.trigger}: ${r.instruction}`);
    return `### Operating rules (learned)\n${lines.join('\n')}`;
}

/**
 * Shape-aware validity check for raw extracted items (semantic or procedural).
 * Both shapes require high/medium confidence; procedural items additionally
 * require instruction/trigger/evidence, semantic items require fact.
 */
export function isValidExtractedItem(item: { kind?: string; value?: Record<string, unknown> }): boolean {
    const v = item?.value;
    if (!v || typeof v !== 'object') return false;
    if (v.confidence !== 'high' && v.confidence !== 'medium') return false;
    if (item.kind === 'PROCEDURAL') {
        return isNonEmptyString(v.instruction) && isNonEmptyString(v.trigger) && isNonEmptyString(v.evidence);
    }
    return isNonEmptyString(v.fact);
}
```

In `episode.ts`, replace `composeMemoryContext` with:

```typescript
/**
 * Compose memoryContext from facts + episodes + learned rules. Facts-only returns
 * the bare facts string (byte-identical to pre-Phase-3 behavior); the "Known facts"
 * header appears only when facts coexist with another section. Output order:
 * facts → operating rules → past experience (imperatives before illustrations).
 */
export function composeMemoryContext(factsSection: string, episodesSection: string, proceduresSection = ''): string {
    const facts = factsSection.trim();
    const episodes = episodesSection.trim();
    const procedures = proceduresSection.trim();
    const others = [procedures, episodes].filter(Boolean);
    if (facts && others.length) return [`### Known facts\n${facts}`, ...others].join('\n\n');
    if (facts) return facts;
    return others.join('\n\n');
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/web-ui && bunx vitest run lib/agent/memory/procedural.test.ts lib/agent/memory/episode.test.ts`
Expected: ALL pass — including every pre-existing episode.test.ts assertion (byte-shape contract).

- [ ] **Step 6: Commit**

```bash
git add apps/web-ui/lib/agent/memory/types.ts apps/web-ui/lib/agent/memory/procedural.ts apps/web-ui/lib/agent/memory/procedural.test.ts apps/web-ui/lib/agent/memory/episode.ts apps/web-ui/lib/agent/memory/episode.test.ts
git commit -m "feat(memory): procedural core — rule formatter, item validator, 3-section compose"
```

---

## Task 2: Kind-aware reconcile

**Files:**
- Modify: `apps/web-ui/lib/agent/memory/reconcile.ts` (neighbor recall, `add`, SUPERSEDE, judge prompt)
- Modify: `apps/web-ui/lib/agent/memory/reconcile.test.ts` (append kind tests)

**Interfaces:**
- Consumes: `ExtractedFact.kind?` (Task 1).
- Produces: reconcile threads `fact.kind ?? 'SEMANTIC'` end-to-end.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe('reconcileMemories', ...)` (helpers `fact`, `neighbor`, `judgeReturning`, `base`, `mockSvc` exist; add a procedural fixture beside `fact`):

```typescript
    const proceduralFact = (key: string): ExtractedFact => ({
        kind: 'PROCEDURAL', namespace: ['procedures', 'aws-cli'], key,
        value: { instruction: 'always paginate', trigger: 'list ops', evidence: 'missed items', confidence: 'high' } as any,
    });

    it('procedural fact → neighbors fetched with kinds PROCEDURAL and ADD saves kind PROCEDURAL', async () => {
        mockSvc.recall.mockResolvedValue([]); // no neighbors → fast-path ADD
        const judge = judgeReturning([]);
        await reconcileMemories({ ...base, facts: [proceduralFact('paginate')], judgeModel: judge });
        expect(mockSvc.recall).toHaveBeenCalledWith(expect.objectContaining({ kinds: ['PROCEDURAL'] }));
        expect(mockSvc.remember).toHaveBeenCalledWith(expect.objectContaining({ kind: 'PROCEDURAL' }));
    });

    it('procedural SUPERSEDE → new row saved with kind PROCEDURAL', async () => {
        mockSvc.recall.mockResolvedValue([neighbor('old-rule')]);
        const judge = judgeReturning([{ factIndex: 0, action: 'SUPERSEDE', targetId: 'old-rule' }]);
        await reconcileMemories({ ...base, facts: [proceduralFact('paginate')], judgeModel: judge });
        expect(mockSvc.remember).toHaveBeenCalledWith(expect.objectContaining({ kind: 'PROCEDURAL' }));
        expect(mockSvc.supersede).toHaveBeenCalledWith('t1', 'old-rule', 'new-id');
    });

    it('kind absent → SEMANTIC everywhere (legacy default)', async () => {
        mockSvc.recall.mockResolvedValue([]);
        const judge = judgeReturning([]);
        await reconcileMemories({ ...base, facts: [fact('k1')], judgeModel: judge });
        expect(mockSvc.recall).toHaveBeenCalledWith(expect.objectContaining({ kinds: ['SEMANTIC'] }));
        expect(mockSvc.remember).toHaveBeenCalledWith(expect.objectContaining({ kind: 'SEMANTIC' }));
    });
```

(Add `import type { ExtractedFact } from './types';` if not already imported in the test file.)

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web-ui && bunx vitest run lib/agent/memory/reconcile.test.ts`
Expected: the two procedural tests FAIL (`kinds: ['SEMANTIC']` / `kind: 'SEMANTIC'` received); the default test passes.

- [ ] **Step 3: Implement kind threading in `reconcile.ts`**

Three mechanical edits:

1. In the `add` closure, change `kind: 'SEMANTIC',` to:
```typescript
            kind: fact.kind ?? 'SEMANTIC',
```
2. In the neighbor-fetch loop, change `kinds: ['SEMANTIC'],` to:
```typescript
                kinds: [fact.kind ?? 'SEMANTIC'],
```
3. In the SUPERSEDE case, change the inner `remember` call's `kind: 'SEMANTIC',` to:
```typescript
                        kind: item.fact.kind ?? 'SEMANTIC',
```
4. In `JUDGE_SYSTEM`, after the `- "NOOP": ...` line, add:
```
Items may be facts or operating rules; the same actions apply (a rule that changed = SUPERSEDE; the same rule re-learned = REINFORCE).
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd apps/web-ui && bunx vitest run lib/agent/memory/reconcile.test.ts`
Expected: ALL pass (13 existing + 3 new = 16).

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/agent/memory/reconcile.ts apps/web-ui/lib/agent/memory/reconcile.test.ts
git commit -m "feat(memory): kind-aware reconcile — rules dedupe/supersede against rules"
```

---

## Task 3: memory-nodes — extraction category, shape-aware filter, third recall + env flag

**Files:**
- Modify: `apps/web-ui/lib/agent/memory-nodes.ts`
- Modify: `apps/web-ui/env.ts` (after `EPISODIC_MEMORY_ENABLED`)
- Modify: `.env.example` (after the `EPISODIC_MEMORY_ENABLED=true` block)

**Interfaces:**
- Consumes: Task 1's `proceduralMemoryEnabled`/`formatProceduresSection`/`isValidExtractedItem`/`PROCEDURE_*`; Task 2's kind-aware reconcile; existing `getMemoryService`, `composeMemoryContext`.

- [ ] **Step 1: env.ts + .env.example**

`env.ts` — after `EPISODIC_MEMORY_ENABLED: z.string().optional(),` add:

```typescript
        PROCEDURAL_MEMORY_ENABLED: z.string().optional(),
```

`.env.example` — after `EPISODIC_MEMORY_ENABLED=true` add:

```
# Procedural memory (Phase 4) — learn operating rules from corrections/failures and
# inject them as '### Operating rules (learned)'; promote matured rules to Skills (human-approved).
PROCEDURAL_MEMORY_ENABLED=true
```

- [ ] **Step 2: memory-nodes.ts imports**

Add:

```typescript
import {
    proceduralMemoryEnabled, formatProceduresSection, isValidExtractedItem,
    PROCEDURE_RECALL_LIMIT, PROCEDURE_DISTANCE_THRESHOLD,
} from "./memory/procedural";
```

and extend the type-only import to include `ProceduralValue`:

```typescript
import type { ExtractedFact, EpisodicValue, ProceduralValue } from "./memory/types";
```

- [ ] **Step 3: Recall node — third section**

In `memoryRecallNode`, between the semantic-facts block and the episodic block, insert:

```typescript
        // ── Learned operating rules — distance-gated, no LLM filter ─────────
        let proceduresSection = "";
        if (proceduralMemoryEnabled()) {
            try {
                const rules = await getMemoryService().recall({
                    tenantId, userId, query, kinds: ["PROCEDURAL"], limit: PROCEDURE_RECALL_LIMIT,
                });
                const near = rules
                    .filter(r => r.distance !== undefined && r.distance <= PROCEDURE_DISTANCE_THRESHOLD)
                    .map(r => r.value as unknown as ProceduralValue)
                    .filter(v => !!v?.instruction && !!v?.trigger);
                if (near.length > 0) {
                    console.log(`🧠 [MEMORY RECALL] Applying ${near.length} learned operating rule(s)`);
                    proceduresSection = formatProceduresSection(near);
                }
            } catch (err: any) {
                console.warn(`[MemoryRecall] Procedural search failed: ${err?.message ?? err}`);
            }
        }
```

and change the compose call to:

```typescript
        const memoryContext = composeMemoryContext(factsSection, episodesSection, proceduresSection);
```

- [ ] **Step 4: Save node — extraction category + shape-aware filter**

In the extraction `SystemMessage`, after the errors-category lines (`- Error resolutions → ...\n  Examples: ...`), insert (template-concatenation, gated):

```typescript
` + (proceduralMemoryEnabled() ? `- Operating rules → add "kind": "PROCEDURAL", namespace: ["procedures", "<domain>"]
  A rule for HOW the agent should behave in this environment, learned from this run.
  Extract a rule ONLY from a correction, a failure the run recovered from, or an explicit user preference about behavior.
  Shape: { "kind": "PROCEDURAL", "namespace": ["procedures", "aws-cli"], "key": "paginate-list-calls", "value": { "instruction": "Always paginate list/describe calls", "trigger": "any AWS CLI list operation", "evidence": "run truncated results and missed the target resource", "confidence": "high" } }
` : '') + `
```

Widen the parse type from `Array<{ namespace: string[]; key: string; value: { fact: string; source: string; confidence: string } }>` to:

```typescript
            const memories: Array<{
                kind?: string;
                namespace: string[];
                key: string;
                value: Record<string, unknown>;
            }> = JSON.parse(jsonMatch[0]);
```

Replace the confidence-only filter:

```typescript
            const toSave = memories.filter(m =>
                m.value?.confidence === "high" || m.value?.confidence === "medium"
            );
```

with:

```typescript
            const toSave = memories.filter(isValidExtractedItem);
            if (toSave.length < memories.length) {
                console.log(`[MemorySave] Dropped ${memories.length - toSave.length} invalid/low-confidence item(s)`);
            }
```

Update the reconcile mapping to thread kind:

```typescript
                    facts: toSave.map(m => ({
                        kind: m.kind === 'PROCEDURAL' ? 'PROCEDURAL' as const : undefined,
                        namespace: m.namespace, key: m.key, value: m.value,
                    })) as ExtractedFact[],
```

In the legacy (reconcile-disabled) branch, skip procedural items (rules ride reconcile; the off-switch stays a clean rollback):

```typescript
                for (const mem of toSave) {
                    if (mem.kind === 'PROCEDURAL') {
                        console.log(`   ⏭️ Skipped procedural rule ${mem.key} (reconcile disabled)`);
                        continue;
                    }
                    try {
                        await saveMemory(tenantId, userId, mem.namespace, mem.key, mem.value as Record<string, unknown>);
                        console.log(`   ✅ Saved: ${mem.namespace.join("/")}/${mem.key}`);
                    } catch (err: any) {
                        console.warn(`   ⚠️ Failed to save ${mem.key}: ${err?.message ?? err}`);
                    }
                }
```

- [ ] **Step 5: Verify**

Run: `cd apps/web-ui && bunx vitest run lib/agent/memory/ && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "^lib/agent/memory-nodes" || echo "no errors in memory-nodes.ts"`
Expected: all memory tests PASS; `no errors in memory-nodes.ts`.

- [ ] **Step 6: Commit**

```bash
git add apps/web-ui/lib/agent/memory-nodes.ts apps/web-ui/env.ts .env.example
git commit -m "feat(memory): procedural extraction + learned-rules injection in memory nodes"
```

---

## Task 4: Repo/client fields + promote helper

**Files:**
- Modify: `apps/web-ui/lib/db/repositories/agent-memory/interface.ts` (`sourceThreadId`)
- Modify: `apps/web-ui/lib/db/repositories/agent-memory/postgres.ts` (row type + mapping)
- Modify: `apps/web-ui/lib/db/repositories/agent-memory/postgres.test.ts`
- Modify: `apps/web-ui/lib/queries/agent-memories.ts` (`MemoryRow` gains `kind`, `sourceThreadId`)
- Create: `apps/web-ui/lib/agent-memory/promote.ts`
- Create: `apps/web-ui/lib/agent-memory/promote.test.ts`

**Interfaces:**
- Consumes: `MemoryKind` from `@/lib/agent/memory/types`; `MemoryRow` from `@/lib/queries/agent-memories`.
- Produces: `buildSkillDraftFromMemory(row): SkillDraft | null`; `MemoryRow.kind`/`sourceThreadId`.

- [ ] **Step 1: Write the failing tests**

`postgres.test.ts` — add `sourceThreadId: null,` to `makeRow` defaults, and append:

```typescript
    it('maps sourceThreadId through', async () => {
        mockPrisma.agentMemory.findFirst.mockResolvedValueOnce(makeRow({ sourceThreadId: 'th-42' }));
        const repo = new AgentMemoryPostgresRepository();
        const rec = await repo.getById('t1', 'mem-1');
        expect(rec?.sourceThreadId).toBe('th-42');
    });
```

Create `apps/web-ui/lib/agent-memory/promote.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildSkillDraftFromMemory } from './promote';
import type { MemoryRow } from '@/lib/queries/agent-memories';

const row = (overrides: Partial<MemoryRow> = {}): MemoryRow => ({
    id: 'm1', userId: 'u1', namespace: 'procedures/aws-cli', category: 'other' as any,
    key: 'paginate-list-calls', fact: '', source: null, confidence: null,
    value: { instruction: 'Always paginate list/describe calls', trigger: 'any AWS CLI list operation', evidence: 'missed a resource once' },
    kind: 'PROCEDURAL', sourceThreadId: 'th-42',
    supersededById: null, supersededAt: null,
    createdAt: '2026-07-02T00:00:00Z', updatedAt: '2026-07-02T00:00:00Z', expiresAt: '2026-10-01T00:00:00Z',
    ...overrides,
});

describe('buildSkillDraftFromMemory', () => {
    it('builds a draft from a procedural row', () => {
        const d = buildSkillDraftFromMemory(row());
        expect(d).not.toBeNull();
        expect(d!.name).toBe('Paginate List Calls');
        expect(d!.description).toBe('any AWS CLI list operation');
        expect(d!.tier).toBe('read-only');
        expect(d!.content).toContain('## Rule\nAlways paginate list/describe calls');
        expect(d!.content).toContain('## When it applies\nany AWS CLI list operation');
        expect(d!.content).toContain('## Why (evidence)\nmissed a resource once');
    });
    it('returns null for non-procedural rows', () => {
        expect(buildSkillDraftFromMemory(row({ kind: 'SEMANTIC' }))).toBeNull();
        expect(buildSkillDraftFromMemory(row({ kind: 'EPISODIC' }))).toBeNull();
    });
    it('returns null when instruction or trigger missing', () => {
        expect(buildSkillDraftFromMemory(row({ value: { trigger: 't' } }))).toBeNull();
        expect(buildSkillDraftFromMemory(row({ value: { instruction: 'i' } }))).toBeNull();
    });
    it('evidence missing → placeholder, still promotable', () => {
        const d = buildSkillDraftFromMemory(row({ value: { instruction: 'i', trigger: 't' } }));
        expect(d!.content).toContain('## Why (evidence)\n(not recorded)');
    });
});
```

Run: `cd apps/web-ui && bunx vitest run lib/db/repositories/agent-memory/postgres.test.ts lib/agent-memory/promote.test.ts`
Expected: FAIL — `sourceThreadId` undefined on record; promote module not found (and `MemoryRow` lacks `kind`).

- [ ] **Step 2: Implement**

`interface.ts` — after `supersededAt: string | null;` add:

```typescript
    sourceThreadId: string | null;
```

`postgres.ts` — `MemoryRow` type gains `sourceThreadId: string | null;`; `toRecord` returns `sourceThreadId: row.sourceThreadId,`.

`lib/queries/agent-memories.ts` — add `import type { MemoryKind } from '@/lib/agent/memory/types';` and add to the `MemoryRow` interface:

```typescript
    kind: MemoryKind;
    sourceThreadId: string | null;
```

Create `apps/web-ui/lib/agent-memory/promote.ts`:

```typescript
/**
 * promote.ts — procedural memory → Skill draft mapping (Phase 4 bridge).
 * Pure and client-safe; persistence happens only through the existing
 * SkillFormDialog → useCreateSkill → POST /api/skills path (human-approved).
 */

import type { MemoryRow } from '@/lib/queries/agent-memories';

export interface SkillDraft {
    name: string;
    description: string;
    tier: string;
    content: string;
}

function humanize(key: string): string {
    return key
        .split(/[-_]+/)
        .filter(Boolean)
        .map((w) => (w[0]?.toUpperCase() ?? '') + w.slice(1))
        .join(' ');
}

export function buildSkillDraftFromMemory(row: MemoryRow): SkillDraft | null {
    if (row.kind !== 'PROCEDURAL') return null;
    const v = row.value as { instruction?: string; trigger?: string; evidence?: string };
    if (!v?.instruction || !v?.trigger) return null;
    return {
        name: humanize(row.key),
        description: v.trigger,
        tier: 'read-only',
        content:
            `## Rule\n${v.instruction}\n\n` +
            `## When it applies\n${v.trigger}\n\n` +
            `## Why (evidence)\n${v.evidence || '(not recorded)'}\n\n` +
            `_Learned by the agent; promoted from procedural memory._`,
    };
}
```

- [ ] **Step 3: Run tests to verify pass**

Run: `cd apps/web-ui && bunx vitest run lib/db/repositories/agent-memory/postgres.test.ts lib/agent-memory/promote.test.ts`
Expected: ALL pass.

- [ ] **Step 4: Commit**

```bash
git add apps/web-ui/lib/db/repositories/agent-memory/ apps/web-ui/lib/queries/agent-memories.ts apps/web-ui/lib/agent-memory/promote.ts apps/web-ui/lib/agent-memory/promote.test.ts
git commit -m "feat(memory): expose kind+sourceThreadId to the client + skill-draft mapper"
```

---

## Task 5: Promote-to-skill UI wiring

**Files:**
- Modify: `apps/web-ui/components/memory/memory-client-component.tsx` (imports :3-29; actions cell :160-192; dialogs at the component tail)

**Interfaces:**
- Consumes: `buildSkillDraftFromMemory`/`SkillDraft` (Task 4); existing `SkillFormDialog` (`{ open, onOpenChange, initialDraft, sourceRunId }`).

- [ ] **Step 1: Imports + state**

Add imports (2-space file):

```typescript
import { Sparkles } from "lucide-react";
import { SkillFormDialog } from "@/components/skills/skill-form-dialog";
import { buildSkillDraftFromMemory, type SkillDraft } from "@/lib/agent-memory/promote";
```

(`Sparkles` joins the existing lucide import line.) Beside the other `useState` hooks add:

```typescript
    const [promote, setPromote] = useState<{ draft: SkillDraft; sourceRunId: string | null } | null>(null);
```

- [ ] **Step 2: Actions-cell item**

In the actions `DropdownMenuContent`, between the View and Delete items, add:

```tsx
                                    {m.kind === "PROCEDURAL" ? (
                                        <DropdownMenuItem
                                            onClick={() => {
                                                const draft = buildSkillDraftFromMemory(m);
                                                if (draft) {
                                                    setPromote({ draft, sourceRunId: m.sourceThreadId ?? null });
                                                } else {
                                                    toast.error("This memory is missing rule fields and can't be promoted");
                                                }
                                            }}
                                        >
                                            <Sparkles className="mr-2 h-4 w-4" />
                                            Promote to skill
                                        </DropdownMenuItem>
                                    ) : null}
```

- [ ] **Step 3: Render the dialog**

Next to the existing `<MemoryDetailDialog …/>` / `<DeleteMemoryDialog …/>` at the component tail, add:

```tsx
            <SkillFormDialog
                open={!!promote}
                onOpenChange={(v) => { if (!v) setPromote(null); }}
                initialDraft={promote?.draft ?? null}
                sourceRunId={promote?.sourceRunId ?? null}
            />
```

- [ ] **Step 4: Verify (typecheck — no component test harness)**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "^components/memory/" || echo "no errors in components/memory"`
Expected: `no errors in components/memory`.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/components/memory/memory-client-component.tsx
git commit -m "feat(memory): Promote-to-skill action on procedural memories (human-approved)"
```

---

## Task 6: Full verification + docs

**Files:**
- Modify: `CLAUDE.md` (after the `memory/episode.ts` row)

- [ ] **Step 1: Full suites**

Run: `cd apps/web-ui && bunx vitest run lib/agent/memory/ lib/db/repositories/agent-memory/ lib/agent-memory/`
Expected: all PASS (≥ 80 tests).

- [ ] **Step 2: Exact-path typecheck of all Phase 4 touched files**

Run: `cd apps/web-ui && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "^(lib/agent/memory/|lib/agent/memory-nodes|lib/agent-memory/|lib/db/repositories/agent-memory/|lib/queries/agent-memories|components/memory/)" || echo "no new errors"`
Expected: `no new errors`.

- [ ] **Step 3: CLAUDE.md**

After the `memory/episode.ts` table row, add:

```markdown
| `memory/procedural.ts` | Procedural memory: operating rules learned from corrections/failures, injected as "Operating rules (learned)"; matured rules promote to Skills via SkillFormDialog (human-approved). Gated by `PROCEDURAL_MEMORY_ENABLED`. |
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(memory): document procedural memory module"
```

---

## Self-Review (completed against the spec)

- **Spec §A (extraction category, ProceduralValue.confidence, ExtractedFact.kind, shape-aware filter via isValidExtractedItem):** Tasks 1 + 3. ✅
- **Spec §B (kind-aware reconcile: neighbor kinds, add/supersede kind, judge line):** Task 2. ✅
- **Spec §C (procedural.ts, third recall section, 3-arg compose with exact-shape preservation, field-validity filter on replay):** Tasks 1 + 3 (recall block includes the `!!v?.instruction && !!v?.trigger` filter). ✅
- **Spec §D (MemoryRow kind+sourceThreadId, promote.ts mapping, Promote action → SkillFormDialog with sourceRunId, human-approved only):** Tasks 4 + 5. ✅
- **Spec §E (flag + constants):** Tasks 1 (constants/flag) + 3 (env). ✅
- **Legacy reconcile-off branch semantic-only:** Task 3 Step 4. ✅
- **Type consistency:** `SkillDraft`, `buildSkillDraftFromMemory`, `composeMemoryContext(facts, episodes, procedures?)`, `PROCEDURE_*`, `isValidExtractedItem` used identically across tasks; `SkillFormDialog` props verified against the actual component source. ✅
- **No placeholders:** every code step carries complete code; commands carry expected output. ✅
