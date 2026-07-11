# Agent Ops Run Timeline Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Agent Ops run-detail timeline as a grouped step timeline with narrative thinking bubbles, live SSE updates, and first-class visibility of memory recall/save, skill selection, and KB scoping; fix and modernize the Agent Ops list page.

**Architecture:** Backend first — the shared memory nodes gain a structured `memoryStats` state channel, the executor records three new `AgentOpsEvent` types (`memory_recall`, `memory_save`, `evaluation`), and a DB-backed SSE route streams events. Frontend second — a pure `buildSteps()` function groups raw events into timeline steps, rendered by a new component suite under `components/agent-ops/run-timeline/`, fed by TanStack Query hooks + an SSE hook with polling fallback.

**Tech Stack:** Next.js 15 App Router, React 19, Tailwind + existing Radix/shadcn primitives (`components/ui/`), framer-motion, TanStack Query v5, sonner, lucide-react, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-11-agent-ops-timeline-redesign-design.md`

## Global Constraints

- Work happens in `apps/web-ui/` on branch `agent-ops-right-size`. Run all commands from `apps/web-ui/` unless stated otherwise.
- **tsc baseline is 182 pre-existing errors** — `bunx tsc --noEmit 2>&1 | grep -c "error TS"` must not exceed the count you measure BEFORE your first change (measure it once, write it down, compare after).
- Test runner: `bunx vitest run <path>` for a single file; `bun run test` for the suite. Several suite failures are PRE-EXISTING (DB/env-dependent); your task only needs its own test files green + no new failures in files you touched.
- Components: 2-space indent, named exports, `"use client"` when using hooks, `@/` import alias, `cn()` from `@/lib/utils` for conditional classes. Lib files: 4-space indent.
- Do not modify `components/ui/*` primitives.
- Toasts: `import { toast } from "sonner"` (never the legacy shim in new code).
- The `[runId]/respond/page.tsx` deep-link page is OUT OF SCOPE — do not touch it.
- Commit after every task with a conventional-commit message ending in:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: `memoryStats` — structured stats from the shared memory nodes

The memory nodes currently return only `memoryContext: string`. Give them a structured `memoryStats` return so the executor (Task 2) can record real events. LangGraph throws `InvalidUpdateError` when a node returns an undeclared channel, so the channel must be declared in BOTH graph states that use these nodes.

**Files:**
- Modify: `apps/web-ui/lib/agent/memory/types.ts` (append types; `MemoryNodeState` is at line ~64)
- Modify: `apps/web-ui/lib/agent/memory-nodes.ts`
- Modify: `apps/web-ui/lib/agent-ops/executor-state.ts` (interface + `graphState` channels)
- Modify: `apps/web-ui/lib/agent/agent-shared.ts` (chat `ReflectionState` interface ~line 80 + channels object ~line 136 — mirror what you do in executor-state.ts)
- Test: `apps/web-ui/tests/agent/memory-nodes-stats.test.ts` (create; `tests/agent/` may need creating)

**Interfaces:**
- Consumes: existing `getMemoryService().recall(...)`, `reconcileMemories(...)`, `captureEpisode(...)`.
- Produces (Tasks 2 & 6 rely on these exact names):
  ```ts
  // lib/agent/memory/types.ts
  export interface MemoryHitStat { key: string; distance?: number }
  export interface MemoryRecallStats {
      phase: 'recall';
      facts: MemoryHitStat[];      // raw semantic hits (pre-LLM-filter)
      rules: MemoryHitStat[];      // distance-gate survivors
      episodes: MemoryHitStat[];   // distance-gate survivors
      injected: boolean;           // memoryContext non-empty
  }
  export interface MemorySaveStats {
      phase: 'save';
      savedFacts: number;          // SEMANTIC items extracted+persisted
      savedRules: number;          // PROCEDURAL items extracted+persisted
      episodeCaptured: boolean;
      reconcileActions?: Record<string, number>;  // {added,updated,superseded,reinforced,noop,failed}
  }
  export type MemoryStats = MemoryRecallStats | MemorySaveStats;
  ```
  Node return types become `Promise<{ memoryContext: string; memoryStats: MemoryRecallStats | null }>` (recall) and `Promise<{ memoryStats: MemorySaveStats | null }>` (save). Skip paths return `memoryStats: null`.

- [ ] **Step 1: Write the failing test**

`apps/web-ui/tests/agent/memory-nodes-stats.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

const { mockRecall } = vi.hoisted(() => ({
    mockRecall: vi.fn(),
}));

vi.mock('../../lib/agent/memory/memory-service', () => ({
    getMemoryService: () => ({ recall: mockRecall }),
}));
// Neutralize optional layers so only the semantic path runs
vi.mock('../../lib/agent/memory/episode', () => ({
    episodicMemoryEnabled: () => false,
    captureEpisode: vi.fn(),
    formatEpisodesSection: (x: unknown) => String(x),
    composeMemoryContext: (facts: string) => facts,
    EPISODE_RECALL_LIMIT: 2,
    EPISODE_DISTANCE_THRESHOLD: 0.65,
}));
vi.mock('../../lib/agent/memory/procedural', () => ({
    proceduralMemoryEnabled: () => false,
    formatProceduresSection: (x: unknown) => String(x),
    isValidExtractedItem: () => true,
    PROCEDURE_RECALL_LIMIT: 3,
    PROCEDURE_DISTANCE_THRESHOLD: 0.55,
}));
vi.mock('../../lib/agent/memory/reconcile', () => ({
    reconcileEnabled: () => false,
    reconcileMemories: vi.fn(),
}));
vi.mock('../../lib/agent/memory/skill-synthesis', () => ({
    synthesizeDomainSkills: vi.fn(),
}));
vi.mock('../../lib/agent/persistence', () => ({ saveMemory: vi.fn() }));

import { HumanMessage } from '@langchain/core/messages';
import { createMemoryRecallNode, createMemorySaveNode } from '../../lib/agent/memory-nodes';

const reflectorModel = {
    invoke: vi.fn().mockResolvedValue({ content: '- [infra/acct] region is ap-south-1' }),
} as never;

const baseState = {
    messages: [new HumanMessage('check costs')],
    taskDescription: 'check costs',
    plan: [], toolResults: [], errors: [], reflection: '',
    iterationCount: 0, isComplete: true, memoryContext: '',
};

describe('memoryStats', () => {
    it('recall returns memoryStats with fact hits and injected=true', async () => {
        mockRecall.mockResolvedValue([
            { namespace: 'infra/acct', key: 'region', value: { fact: 'ap-south-1' }, distance: 0.21 },
            { namespace: 'infra/acct', key: 'payer', value: { fact: 'mgmt acct' }, distance: 0.34 },
        ]);
        const node = createMemoryRecallNode({
            reflectorModel, tenantId: 't1', userId: 'u1', store: {},
        });
        const out = await node(baseState as never);
        expect(out.memoryStats).toEqual({
            phase: 'recall',
            facts: [{ key: 'region', distance: 0.21 }, { key: 'payer', distance: 0.34 }],
            rules: [], episodes: [],
            injected: true,
        });
    });

    it('recall skip path returns memoryStats: null', async () => {
        const node = createMemoryRecallNode({
            reflectorModel, tenantId: undefined, userId: 'u1', store: {},
        });
        const out = await node(baseState as never);
        expect(out.memoryStats).toBeNull();
    });

    it('save returns counts by kind', async () => {
        const extraction = JSON.stringify([
            { namespace: ['infra', 'a'], key: 'k1', value: { fact: 'x', confidence: 'high' } },
            { kind: 'PROCEDURAL', namespace: ['procedures', 'aws'], key: 'k2', value: { instruction: 'y', trigger: 'z' } },
        ]);
        const saveModel = { invoke: vi.fn().mockResolvedValue({ content: extraction }) } as never;
        const node = createMemorySaveNode({
            reflectorModel: saveModel, tenantId: 't1', userId: 'u1', store: {},
        });
        const out = await node({
            ...baseState,
            messages: [new HumanMessage('a'), new HumanMessage('b')],
        } as never, { configurable: { thread_id: 'th1' } });
        expect(out.memoryStats).toMatchObject({
            phase: 'save', savedFacts: 1, savedRules: 1, episodeCaptured: false,
        });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run tests/agent/memory-nodes-stats.test.ts`
Expected: FAIL — `out.memoryStats` is `undefined` (nodes don't return it yet).

- [ ] **Step 3: Add the types**

Append to `apps/web-ui/lib/agent/memory/types.ts` the four exports from the Interfaces block above, verbatim. Then add to the `MemoryNodeState` interface (line ~64):

```ts
    memoryStats?: MemoryStats | null;
```

- [ ] **Step 4: Return stats from the recall node**

In `memory-nodes.ts` `createMemoryRecallNode`:
1. Import the types: `import type { ..., MemoryStats, MemoryRecallStats, MemorySaveStats, MemoryHitStat } from "./memory/types";`
2. Change the return type to `Promise<{ memoryContext: string; memoryStats: MemoryRecallStats | null }>`; both early-return skip paths become `return { memoryContext: "", memoryStats: null };`
3. Declare collectors right after the `query` const:
```ts
        const factStats: MemoryHitStat[] = [];
        const ruleStats: MemoryHitStat[] = [];
        const episodeStats: MemoryHitStat[] = [];
```
4. In the facts try-block, right after the `console.log` of hits: `hits.forEach(h => factStats.push({ key: h.key, distance: h.distance }));`
5. In the procedural block, after computing `near`: `near` is mapped to values — collect from the filtered rule objects instead. Replace the existing `const near = rules.filter(...)...` chain with:
```ts
                const nearRules = rules.filter(r => r.distance !== undefined && r.distance <= PROCEDURE_DISTANCE_THRESHOLD);
                nearRules.forEach(r => ruleStats.push({ key: r.key, distance: r.distance }));
                const near = nearRules
                    .map(r => r.value as unknown as ProceduralValue)
                    .filter(v => !!v?.instruction && !!v?.trigger);
```
6. In the episodic block, after `const near = eps.filter(...)`: `near.forEach(e => episodeStats.push({ key: e.key, distance: e.distance }));`
7. Final return:
```ts
        return {
            memoryContext,
            memoryStats: {
                phase: 'recall',
                facts: factStats, rules: ruleStats, episodes: episodeStats,
                injected: memoryContext.length > 0,
            },
        };
```

- [ ] **Step 5: Return stats from the save node**

In `createMemorySaveNode`:
1. Return type `Promise<{ memoryStats: MemorySaveStats | null }>`; the two early-return skip paths (`no store/tenantId/userId`, `messages.length < 2`) return `{ memoryStats: null }`.
2. Track counts. Before the extraction `try`, declare:
```ts
        let savedFacts = 0;
        let savedRules = 0;
        let reconcileActions: Record<string, number> | undefined;
```
3. After `const toSave = memories.filter(isValidExtractedItem);` add:
```ts
            savedFacts = toSave.filter(m => m.kind !== 'PROCEDURAL').length;
            savedRules = toSave.filter(m => m.kind === 'PROCEDURAL').length;
```
   (When `toSave.length === 0` the early `return {}` in that branch becomes `return { memoryStats: { phase: 'save', savedFacts: 0, savedRules: 0, episodeCaptured: false } };` — likewise the `no JSON array` return.)
4. In the reconcile branch, after `const summary = await reconcileMemories(...)`:
```ts
                reconcileActions = {
                    added: summary.added, updated: summary.updated, superseded: summary.superseded,
                    reinforced: summary.reinforced, noop: summary.noop, failed: summary.failed,
                };
```
5. The episodic-capture block already computes its gate; hoist it:
```ts
        const shouldCapture = episodicMemoryEnabled() && !!threadIdForEpisode && toolResults.length > 0;
        if (shouldCapture) {
            await captureEpisode({ ... unchanged ... });
        }
```
6. Final return (replaces `return {};` at the end):
```ts
        return {
            memoryStats: {
                phase: 'save', savedFacts, savedRules,
                episodeCaptured: shouldCapture, reconcileActions,
            },
        };
```
   Note the outer extraction `catch` currently swallows and falls through — that's fine; counts stay 0.

- [ ] **Step 6: Declare the channel in both graph states**

`apps/web-ui/lib/agent-ops/executor-state.ts` — add `import type { MemoryStats } from "@/lib/agent/memory/types";` at the top, then add to the `ReflectionState` interface:
```ts
    memoryStats: MemoryStats | null;
```
and to `graphState`:
```ts
    memoryStats: {
        reducer: (x: MemoryStats | null, y: MemoryStats | null) => y ?? x,
        default: () => null,
    },
```

`apps/web-ui/lib/agent/agent-shared.ts` — same two additions to the chat `ReflectionState` interface and its channels object (top-level `import type { MemoryStats } from "./memory/types";`).

- [ ] **Step 7: Run the test + regression suites**

Run: `bunx vitest run tests/agent/memory-nodes-stats.test.ts` → PASS (3 tests).
Run: `bunx vitest run tests/agent-ops/` → same failures as before your change (compare — some are pre-existing).
Run: `bunx tsc --noEmit 2>&1 | grep -c "error TS"` → ≤ your recorded baseline.

- [ ] **Step 8: Commit**

```bash
git add apps/web-ui/lib/agent/memory/types.ts apps/web-ui/lib/agent/memory-nodes.ts apps/web-ui/lib/agent-ops/executor-state.ts apps/web-ui/lib/agent/agent-shared.ts apps/web-ui/tests/agent/memory-nodes-stats.test.ts
git commit -m "feat(agent-memory): return structured memoryStats from shared memory nodes"
```

---

### Task 2: Executor records `memory_recall` / `memory_save` / `evaluation` events

**Files:**
- Modify: `apps/web-ui/lib/agent-ops/types.ts` (`AgentEventType` union, line ~15)
- Modify: `apps/web-ui/lib/agent-ops/agent-executor.ts` (`processLangGraphEvent`, lines ~352-480)
- Modify: `apps/web-ui/lib/agent-ops/executor-graphs.ts` (evaluator node, ~line 190-220)
- Modify: `apps/web-ui/lib/agent-ops/executor-state.ts` (`RequestEvaluation` gains `skillName`)
- Test: `apps/web-ui/tests/agent-ops/executor-event-coverage.test.ts` (create)

**Interfaces:**
- Consumes: `memoryStats` shape from Task 1 (arrives as `event.data.output.memoryStats` on `on_chain_end` for nodes `memory_recall`/`memory_save`).
- Produces (UI Tasks 5-8 rely on these): `AgentOpsEvent` rows with
  - `eventType: 'memory_recall'`, `node: 'memory_recall'`, `metadata` = the full `MemoryRecallStats` object, `content` = human summary.
  - `eventType: 'memory_save'`, `metadata` = `MemorySaveStats`.
  - `eventType: 'evaluation'`, `node: 'evaluator'`, `metadata: { mode, skillId, skillName, knowledgeBaseIds, requiresApproval }`, `content` = evaluator reasoning.
- Also: internal LLM chatter from memory nodes is NO LONGER recorded via `on_chat_model_end` (today it leaks as a mislabeled `execution` event); token usage from those calls still accumulates.

- [ ] **Step 1: Write the failing test**

`apps/web-ui/tests/agent-ops/executor-event-coverage.test.ts` — reuse the mock harness style from `tests/agent-ops/agent-executor.test.ts` (hoisted mocks for `agent-ops-service`, `executor-graphs`, `fs/promises`, `mcp-manager`, `skill-service`; look at that file and copy its `vi.mock` block verbatim). Then:

```ts
// after the vi.mock block copied from agent-executor.test.ts:
import { executeAgentRun } from '../../lib/agent-ops/agent-executor';

function makeRun(overrides: Record<string, unknown> = {}) {
    return {
        runId: 'run-1', tenantId: 't1', taskDescription: 'task', threadId: 'th-1',
        source: 'api', mode: 'fast', autoApprove: true, ...overrides,
    } as never;
}

/** Graph mock whose streamEvents yields the given LangGraph events. */
function makeGraph(events: unknown[]) {
    return {
        streamEvents: () => (async function* () { for (const e of events) yield e; })(),
        getState: vi.fn().mockResolvedValue({ values: {}, next: [] }),
        getGraph: () => ({ drawMermaid: () => '' }),
    };
}

describe('executor event coverage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetMCPManager.mockReturnValue({ connectServers: vi.fn() });
    });

    it('records memory_recall event with stats metadata', async () => {
        const stats = { phase: 'recall', facts: [{ key: 'k', distance: 0.2 }], rules: [], episodes: [], injected: true };
        mockCreateDynamicExecutorGraph.mockResolvedValue(makeGraph([
            { event: 'on_chain_end', metadata: { langgraph_node: 'memory_recall' }, data: { output: { memoryContext: 'x', memoryStats: stats } } },
        ]));
        await executeAgentRun(makeRun());
        const call = mockRecordEvent.mock.calls.find(c => c[0].eventType === 'memory_recall');
        expect(call).toBeDefined();
        expect(call![0].metadata).toEqual(stats);
        expect(call![0].content).toContain('1 fact');
    });

    it('records evaluation event with skill and KB metadata', async () => {
        const evaluation = {
            mode: 'fast', skillId: 'cost', skillName: 'Cost Analysis', accountId: null,
            requiresApproval: false, reasoning: 'cost task', clarificationQuestion: null,
            missingInfo: null, knowledgeBaseIds: ['kb1'],
        };
        mockCreateDynamicExecutorGraph.mockResolvedValue(makeGraph([
            { event: 'on_chain_end', metadata: { langgraph_node: 'evaluator' }, data: { output: { evaluation } } },
        ]));
        await executeAgentRun(makeRun());
        const call = mockRecordEvent.mock.calls.find(c => c[0].eventType === 'evaluation');
        expect(call).toBeDefined();
        expect(call![0].metadata).toMatchObject({
            mode: 'fast', skillId: 'cost', skillName: 'Cost Analysis',
            knowledgeBaseIds: ['kb1'], requiresApproval: false,
        });
    });

    it('does NOT record chat-model chatter from memory nodes', async () => {
        mockCreateDynamicExecutorGraph.mockResolvedValue(makeGraph([
            {
                event: 'on_chat_model_end', metadata: { langgraph_node: 'memory_recall' },
                data: { output: { content: 'internal filter output', usage_metadata: { input_tokens: 10, output_tokens: 5 } } },
            },
        ]));
        await executeAgentRun(makeRun());
        const chatter = mockRecordEvent.mock.calls.find(c => c[0].node === 'memory_recall' && c[0].eventType !== 'memory_recall');
        expect(chatter).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/agent-ops/executor-event-coverage.test.ts`
Expected: FAIL — no `memory_recall`/`evaluation` events recorded; chatter test fails (an `execution` event with node `memory_recall` IS recorded).

- [ ] **Step 3: Extend the type union**

`apps/web-ui/lib/agent-ops/types.ts` — `AgentEventType` gains three members:

```ts
export type AgentEventType =
    | 'planning'
    | 'execution'
    | 'tool_call'
    | 'tool_result'
    | 'reflection'
    | 'revision'
    | 'final'
    | 'error'
    | 'memory_recall'
    | 'memory_save'
    | 'evaluation';
```

- [ ] **Step 4: Record the new events in `processLangGraphEvent`**

In `agent-executor.ts`, inside `case 'on_chain_end':` add (before the existing `if (node === 'reflect'...)`):

```ts
            if ((node === 'memory_recall' || node === 'memory_save') && event.data?.output?.memoryStats) {
                const stats = event.data.output.memoryStats;
                const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
                const content = stats.phase === 'recall'
                    ? (stats.injected
                        ? `Recalled ${plural(stats.facts.length, 'fact')} · ${plural(stats.rules.length, 'rule')} · ${plural(stats.episodes.length, 'episode')}`
                        : 'No relevant memories found')
                    : `Saved ${plural(stats.savedFacts, 'fact')} · ${plural(stats.savedRules, 'rule')}${stats.episodeCaptured ? ' · episode captured' : ''}`;
                await agentOpsService.recordEvent({
                    runId, tenantId, eventType: node as AgentEventType, node,
                    content, metadata: stats,
                });
            }
```

Replace the existing evaluator block (`if (node === 'evaluator' && event.data?.output?.evaluation) { ... }`) with:

```ts
            if (node === 'evaluator' && event.data?.output?.evaluation) {
                const eval_ = event.data.output.evaluation;
                await agentOpsService.recordEvent({
                    runId, tenantId, eventType: 'evaluation', node,
                    content: eval_.reasoning || JSON.stringify(eval_, null, 2),
                    metadata: {
                        mode: eval_.mode, skillId: eval_.skillId, skillName: eval_.skillName ?? null,
                        knowledgeBaseIds: eval_.knowledgeBaseIds ?? [],
                        requiresApproval: !!eval_.requiresApproval,
                    },
                });
            }
```

In `case 'on_chat_model_end':`, right after the token-usage accumulation block (`if (usage) { ... }`), add:

```ts
            // Memory nodes' internal LLM calls (relevance filter, extraction) are implementation
            // chatter — the structured memory_recall/memory_save events carry the signal.
            if (node === 'memory_recall' || node === 'memory_save') break;
```

- [ ] **Step 5: Carry `skillName` through the evaluator**

`apps/web-ui/lib/agent-ops/executor-state.ts` — add to `RequestEvaluation`:
```ts
    skillName?: string | null;
```

`apps/web-ui/lib/agent-ops/executor-graphs.ts` — in the evaluator node, after the parse block sets `evalResult` (and before the KB-autonomy block), add:
```ts
        evalResult.skillName = evalResult.skillId
            ? (availableSkills.find(s => s.id === evalResult.skillId)?.name ?? evalResult.skillId)
            : null;
```
(`availableSkills` is already in scope — loaded at the top of the node via `loadSkills(tenantId)`.)

- [ ] **Step 6: Run tests**

Run: `bunx vitest run tests/agent-ops/executor-event-coverage.test.ts` → PASS (3 tests).
Run: `bunx vitest run tests/agent-ops/agent-executor.test.ts` → no NEW failures vs pre-change.
Run: `bunx tsc --noEmit 2>&1 | grep -c "error TS"` → ≤ baseline.

- [ ] **Step 7: Commit**

```bash
git add apps/web-ui/lib/agent-ops/types.ts apps/web-ui/lib/agent-ops/agent-executor.ts apps/web-ui/lib/agent-ops/executor-graphs.ts apps/web-ui/lib/agent-ops/executor-state.ts apps/web-ui/tests/agent-ops/executor-event-coverage.test.ts
git commit -m "feat(agent-ops): record memory_recall/memory_save/evaluation timeline events"
```

---

### Task 3: SSE stream route

**Files:**
- Create: `apps/web-ui/app/api/agent-ops/[runId]/stream/route.ts`
- Test: `apps/web-ui/tests/agent-ops/stream-route.test.ts` (create)

**Interfaces:**
- Consumes: `agentOpsService.getRun(tenantId, runId)`, `agentOpsService.getRunEvents(runId, tenantId)` (events are returned in ascending chronological order), `getSessionTenantId()` from `@/lib/auth-session`.
- Produces (Task 7's `use-run-stream.ts` relies on these): SSE frames
  - `event: run-event` / `data: <AgentOpsEvent JSON>` — one per new event, in order.
  - `event: status` / `data: <AgentOpsRun JSON>` — on every status/result change, and once immediately on connect.
  - `: heartbeat` comment every ~15s.
  - Stream closes after the terminal status frame (`completed`/`failed`/`cancelled`) or a 15-minute lifetime cap.

- [ ] **Step 1: Write the failing test**

`apps/web-ui/tests/agent-ops/stream-route.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

const { mockGetRun, mockGetRunEvents } = vi.hoisted(() => ({
    mockGetRun: vi.fn(),
    mockGetRunEvents: vi.fn(),
}));

vi.mock('@/lib/agent-ops/agent-ops-service', () => ({
    agentOpsService: { getRun: mockGetRun, getRunEvents: mockGetRunEvents },
}));
vi.mock('@/lib/auth-session', () => ({
    getSessionTenantId: vi.fn().mockResolvedValue('t1'),
}));

import { GET } from '../../app/api/agent-ops/[runId]/stream/route';

async function readAll(res: Response): Promise<string> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let out = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out += decoder.decode(value);
    }
    return out;
}

describe('GET /api/agent-ops/[runId]/stream', () => {
    it('streams events then closes on terminal status', async () => {
        const run = { runId: 'r1', tenantId: 't1', status: 'completed' };
        const events = [
            { SK: 'EVENT#1#0', runId: 'r1', eventType: 'planning', node: '__start__', createdAt: 'x' },
            { SK: 'EVENT#2#0', runId: 'r1', eventType: 'final', node: '__end__', createdAt: 'y' },
        ];
        mockGetRun.mockResolvedValue(run);
        mockGetRunEvents.mockResolvedValue(events);

        const req = new Request('http://test/api/agent-ops/r1/stream');
        const res = await GET(req as never, { params: Promise.resolve({ runId: 'r1' }) });

        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toContain('text/event-stream');
        const body = await readAll(res);          // resolves ⇒ stream closed (terminal)
        expect(body).toContain('event: run-event');
        expect(body).toContain('EVENT#1#0');
        expect(body).toContain('EVENT#2#0');
        expect(body).toContain('event: status');
        expect(body).toContain('"status":"completed"');
    });

    it('404s when the run does not exist', async () => {
        mockGetRun.mockResolvedValue(null);
        const req = new Request('http://test/api/agent-ops/r0/stream');
        const res = await GET(req as never, { params: Promise.resolve({ runId: 'r0' }) });
        expect(res.status).toBe(404);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/agent-ops/stream-route.test.ts`
Expected: FAIL — module not found (route doesn't exist).

- [ ] **Step 3: Implement the route**

`apps/web-ui/app/api/agent-ops/[runId]/stream/route.ts`:

```ts
/**
 * Agent Ops — Run Event Stream (SSE)
 *
 * GET /api/agent-ops/[runId]/stream
 *
 * DB-backed: polls the event log server-side and pushes frames, so it works
 * regardless of which ECS replica is executing the run (the in-process event
 * bus is not replica-safe). Closes itself on terminal run status.
 */

import { NextResponse } from 'next/server';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { getSessionTenantId } from '@/lib/auth-session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const POLL_MS = 1500;
const HEARTBEAT_MS = 15_000;
const MAX_LIFETIME_MS = 15 * 60 * 1000;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export async function GET(
    req: Request,
    { params }: { params: Promise<{ runId: string }> }
) {
    const { runId } = await params;

    let tenantId: string;
    try {
        tenantId = await getSessionTenantId();
    } catch {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const initialRun = await agentOpsService.getRun(tenantId, runId);
    if (!initialRun) {
        return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }

    const encoder = new TextEncoder();
    const signal = (req as { signal?: AbortSignal }).signal;

    const stream = new ReadableStream({
        async start(controller) {
            const send = (event: string, data: unknown) =>
                controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
            const startedAt = Date.now();
            let lastBeat = Date.now();
            let cursor = 0;
            let lastStatusJson = '';

            try {
                for (;;) {
                    if (signal?.aborted || Date.now() - startedAt > MAX_LIFETIME_MS) break;

                    const [run, events] = await Promise.all([
                        agentOpsService.getRun(tenantId, runId),
                        agentOpsService.getRunEvents(runId, tenantId),
                    ]);

                    for (; cursor < events.length; cursor++) {
                        send('run-event', events[cursor]);
                    }

                    if (run) {
                        const statusJson = JSON.stringify({ s: run.status, r: run.result, e: run.error });
                        if (statusJson !== lastStatusJson) {
                            lastStatusJson = statusJson;
                            send('status', run);
                        }
                        if (TERMINAL.has(run.status)) break;
                    }

                    if (Date.now() - lastBeat > HEARTBEAT_MS) {
                        controller.enqueue(encoder.encode(`: heartbeat\n\n`));
                        lastBeat = Date.now();
                    }
                    await new Promise(r => setTimeout(r, POLL_MS));
                }
            } catch (err) {
                console.error('[Agent Ops API] Stream error:', err);
            } finally {
                try { controller.close(); } catch { /* already closed */ }
            }
        },
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        },
    });
}
```

- [ ] **Step 4: Run tests**

Run: `bunx vitest run tests/agent-ops/stream-route.test.ts` → PASS (2 tests).
Run: `bunx tsc --noEmit 2>&1 | grep -c "error TS"` → ≤ baseline.

- [ ] **Step 5: Commit**

```bash
git add "apps/web-ui/app/api/agent-ops/[runId]/stream/route.ts" apps/web-ui/tests/agent-ops/stream-route.test.ts
git commit -m "feat(agent-ops): DB-backed SSE stream route for live run timelines"
```

---

### Task 4: `buildSteps` — pure timeline grouping logic

**Files:**
- Create: `apps/web-ui/components/agent-ops/run-timeline/build-steps.ts`
- Test: `apps/web-ui/components/agent-ops/run-timeline/build-steps.test.ts`

**Interfaces:**
- Consumes: `AgentOpsEvent`, `AgentOpsStatus` from `@/lib/agent-ops/types`.
- Produces (Tasks 6-8 render exactly these):

```ts
export type StepStatus = 'ok' | 'error' | 'running' | 'unknown';

export type TimelineStep =
    | { kind: 'memory'; phase: 'recall' | 'save'; event: AgentOpsEvent }
    | { kind: 'evaluation'; event: AgentOpsEvent }
    | { kind: 'planning'; event: AgentOpsEvent }
    | { kind: 'thinking'; event: AgentOpsEvent }
    | { kind: 'tool'; call?: AgentOpsEvent; result?: AgentOpsEvent; toolName: string; status: StepStatus; durationMs?: number }
    | { kind: 'reflection'; event: AgentOpsEvent }
    | { kind: 'final'; event: AgentOpsEvent }
    | { kind: 'error'; event: AgentOpsEvent }
    | { kind: 'group'; steps: TimelineStep[]; durationMs: number; running: boolean };

export function buildSteps(events: AgentOpsEvent[], runStatus: AgentOpsStatus): TimelineStep[];
```

- [ ] **Step 1: Write the failing test**

`build-steps.test.ts` (colocated; vitest picks up `*.test.ts` anywhere under the project):

```ts
import { describe, it, expect } from 'vitest';
import { buildSteps, type TimelineStep } from './build-steps';
import type { AgentOpsEvent } from '@/lib/agent-ops/types';

let seq = 0;
function ev(partial: Partial<AgentOpsEvent>): AgentOpsEvent {
    seq += 1;
    return {
        PK: 'RUN#r1', SK: `EVENT#${seq}#0`, runId: 'r1',
        eventType: 'execution', node: 'generate',
        createdAt: new Date(1700000000000 + seq * 1000).toISOString(),
        ttl: 0, ...partial,
    } as AgentOpsEvent;
}

describe('buildSteps', () => {
    it('pairs a tool_call with its matching tool_result', () => {
        const steps = buildSteps([
            ev({ eventType: 'tool_call', toolName: 'execute_command' }),
            ev({ eventType: 'tool_result', toolName: 'execute_command', toolOutput: 'ok output' }),
        ], 'completed');
        expect(steps).toHaveLength(1);
        const t = steps[0] as Extract<TimelineStep, { kind: 'tool' }>;
        expect(t.kind).toBe('tool');
        expect(t.status).toBe('ok');
        expect(t.durationMs).toBe(1000);
    });

    it('flags an error result', () => {
        const steps = buildSteps([
            ev({ eventType: 'tool_call', toolName: 'execute_command' }),
            ev({ eventType: 'tool_result', toolName: 'execute_command', toolOutput: 'Command failed: aws sts ...' }),
        ], 'completed');
        expect((steps[0] as Extract<TimelineStep, { kind: 'tool' }>).status).toBe('error');
    });

    it('marks an unpaired call running while the run is active, unknown when settled', () => {
        const events = [ev({ eventType: 'tool_call', toolName: 'glob' })];
        expect((buildSteps(events, 'in_progress')[0] as Extract<TimelineStep, { kind: 'tool' }>).status).toBe('running');
        expect((buildSteps(events, 'failed')[0] as Extract<TimelineStep, { kind: 'tool' }>).status).toBe('unknown');
    });

    it('promotes thinking execution events to thinking bubbles', () => {
        const steps = buildSteps([
            ev({ eventType: 'execution', metadata: { contentType: 'thinking' }, content: 'Now I will…' }),
        ], 'completed');
        expect(steps[0].kind).toBe('thinking');
    });

    it('maps memory and evaluation events to dedicated steps', () => {
        const steps = buildSteps([
            ev({ eventType: 'memory_recall', node: 'memory_recall' }),
            ev({ eventType: 'evaluation', node: 'evaluator' }),
            ev({ eventType: 'memory_save', node: 'memory_save' }),
        ], 'completed');
        expect(steps.map(s => s.kind)).toEqual(['memory', 'evaluation', 'memory']);
        expect((steps[0] as Extract<TimelineStep, { kind: 'memory' }>).phase).toBe('recall');
        expect((steps[2] as Extract<TimelineStep, { kind: 'memory' }>).phase).toBe('save');
    });

    it('treats legacy evaluator planning events as evaluation (old runs)', () => {
        const steps = buildSteps([ev({ eventType: 'planning', node: 'evaluator' })], 'completed');
        expect(steps[0].kind).toBe('evaluation');
    });

    it('folds ≥3 contiguous work steps into a group, keeps structural steps outside', () => {
        const steps = buildSteps([
            ev({ eventType: 'planning', node: '__start__' }),
            ev({ eventType: 'tool_call', toolName: 'a' }),
            ev({ eventType: 'tool_result', toolName: 'a', toolOutput: 'x' }),
            ev({ eventType: 'execution', metadata: { contentType: 'thinking' }, content: 't' }),
            ev({ eventType: 'tool_call', toolName: 'b' }),
            ev({ eventType: 'tool_result', toolName: 'b', toolOutput: 'y' }),
            ev({ eventType: 'reflection', node: 'reflect', content: 'looks done' }),
        ], 'completed');
        expect(steps.map(s => s.kind)).toEqual(['planning', 'group', 'reflection']);
        const g = steps[1] as Extract<TimelineStep, { kind: 'group' }>;
        expect(g.steps).toHaveLength(3);
        expect(g.running).toBe(false);
    });

    it('does not fold short work runs (< 3 steps)', () => {
        const steps = buildSteps([
            ev({ eventType: 'tool_call', toolName: 'a' }),
            ev({ eventType: 'tool_result', toolName: 'a', toolOutput: 'x' }),
        ], 'completed');
        expect(steps[0].kind).toBe('tool');
    });

    it('group containing the running step reports running: true', () => {
        const steps = buildSteps([
            ev({ eventType: 'tool_call', toolName: 'a' }),
            ev({ eventType: 'tool_result', toolName: 'a', toolOutput: 'x' }),
            ev({ eventType: 'execution', metadata: { contentType: 'thinking' }, content: 't' }),
            ev({ eventType: 'tool_call', toolName: 'b' }),
        ], 'in_progress');
        const g = steps[0] as Extract<TimelineStep, { kind: 'group' }>;
        expect(g.kind).toBe('group');
        expect(g.running).toBe(true);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run components/agent-ops/run-timeline/build-steps.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`build-steps.ts`:

```ts
import type { AgentOpsEvent, AgentOpsStatus } from "@/lib/agent-ops/types";

export type StepStatus = "ok" | "error" | "running" | "unknown";

export type TimelineStep =
  | { kind: "memory"; phase: "recall" | "save"; event: AgentOpsEvent }
  | { kind: "evaluation"; event: AgentOpsEvent }
  | { kind: "planning"; event: AgentOpsEvent }
  | { kind: "thinking"; event: AgentOpsEvent }
  | { kind: "tool"; call?: AgentOpsEvent; result?: AgentOpsEvent; toolName: string; status: StepStatus; durationMs?: number }
  | { kind: "reflection"; event: AgentOpsEvent }
  | { kind: "final"; event: AgentOpsEvent }
  | { kind: "error"; event: AgentOpsEvent }
  | { kind: "group"; steps: TimelineStep[]; durationMs: number; running: boolean };

const GROUP_MIN = 3;
const ACTIVE_STATUSES: AgentOpsStatus[] = ["queued", "in_progress", "awaiting_input", "awaiting_approval"];

function isErrorOutput(e: AgentOpsEvent): boolean {
  const text = e.toolOutput ?? e.content ?? "";
  return /^(command failed|error[:\s]|failed[:\s])/i.test(text.trim());
}

function ts(e: AgentOpsEvent): number {
  return new Date(e.createdAt).getTime();
}

/** Map raw events to flat steps (pass 1), then fold work segments (pass 2). */
export function buildSteps(events: AgentOpsEvent[], runStatus: AgentOpsStatus): TimelineStep[] {
  const runActive = ACTIVE_STATUSES.includes(runStatus);
  const flat: TimelineStep[] = [];
  const openTools: Array<Extract<TimelineStep, { kind: "tool" }>> = [];

  for (const e of events) {
    switch (e.eventType) {
      case "memory_recall":
        flat.push({ kind: "memory", phase: "recall", event: e });
        break;
      case "memory_save":
        flat.push({ kind: "memory", phase: "save", event: e });
        break;
      case "evaluation":
        flat.push({ kind: "evaluation", event: e });
        break;
      case "planning":
        // Legacy runs recorded the evaluator's decision as a planning event.
        if (e.node === "evaluator") flat.push({ kind: "evaluation", event: e });
        else flat.push({ kind: "planning", event: e });
        break;
      case "tool_call": {
        const step: Extract<TimelineStep, { kind: "tool" }> = {
          kind: "tool", call: e, toolName: e.toolName ?? "tool", status: "unknown",
        };
        flat.push(step);
        openTools.push(step);
        break;
      }
      case "tool_result": {
        const idx = openTools.findIndex(t => t.toolName === (e.toolName ?? "tool") && !t.result);
        if (idx >= 0) {
          const step = openTools[idx];
          step.result = e;
          step.status = isErrorOutput(e) ? "error" : "ok";
          if (step.call) step.durationMs = Math.max(0, ts(e) - ts(step.call));
          openTools.splice(idx, 1);
        } else {
          flat.push({
            kind: "tool", result: e, toolName: e.toolName ?? "tool",
            status: isErrorOutput(e) ? "error" : "ok",
          });
        }
        break;
      }
      case "execution":
        flat.push({ kind: "thinking", event: e });
        break;
      case "reflection":
      case "revision":
        flat.push({ kind: "reflection", event: e });
        break;
      case "final":
        flat.push({ kind: "final", event: e });
        break;
      case "error":
        flat.push({ kind: "error", event: e });
        break;
      default:
        flat.push({ kind: "thinking", event: e as AgentOpsEvent });
        break;
    }
  }

  for (const open of openTools) open.status = runActive ? "running" : "unknown";

  // Pass 2 — fold contiguous work (tool/thinking) segments of >= GROUP_MIN into groups.
  const out: TimelineStep[] = [];
  let segment: TimelineStep[] = [];
  const flush = () => {
    if (segment.length >= GROUP_MIN) {
      out.push({
        kind: "group",
        steps: segment,
        durationMs: segment.reduce((acc, s) => acc + (s.kind === "tool" ? (s.durationMs ?? 0) : 0), 0),
        running: segment.some(s => s.kind === "tool" && s.status === "running"),
      });
    } else {
      out.push(...segment);
    }
    segment = [];
  };
  for (const step of flat) {
    if (step.kind === "tool" || step.kind === "thinking") segment.push(step);
    else { flush(); out.push(step); }
  }
  flush();
  return out;
}
```

- [ ] **Step 4: Run tests**

Run: `bunx vitest run components/agent-ops/run-timeline/build-steps.test.ts` → PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/components/agent-ops/run-timeline/build-steps.ts apps/web-ui/components/agent-ops/run-timeline/build-steps.test.ts
git commit -m "feat(agent-ops): pure buildSteps timeline grouping logic"
```

---

### Task 5: TanStack Query hooks + SSE client hook

**Files:**
- Modify: `apps/web-ui/lib/queries/query-keys.ts` (add `agentOps` domain)
- Create: `apps/web-ui/lib/queries/agent-ops.ts`
- Create: `apps/web-ui/components/agent-ops/run-timeline/use-run-stream.ts`
- Test: `apps/web-ui/components/agent-ops/run-timeline/append-event.test.ts` (create)

**Interfaces:**
- Consumes: `queryKeys` factory pattern, `AgentOpsRun`/`AgentOpsEvent` types, Task 3's SSE frame names (`run-event`, `status`).
- Produces (Tasks 7-9 rely on):
  - `queryKeys.agentOps.list(filters)` / `queryKeys.agentOps.detail(runId)`
  - `useAgentOpsRuns(filters: { source?: string; status?: string })` → `AgentOpsRun[]`
  - `useAgentOpsRunDetail(runId: string, opts?: { pollMs?: number | false })` → `{ run: AgentOpsRun; events: AgentOpsEvent[] }`
  - `useCancelRun()`, `useApproveRun()`, `useResumeRun()` mutations (sonner toasts + invalidation)
  - `useRunStream(runId: string, active: boolean)` → `{ streaming: boolean }`
  - `appendEvent(old, ev)` pure cache-merge helper (exported for tests)

- [ ] **Step 1: Write the failing test for the cache-merge helper**

`append-event.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { appendEvent } from './use-run-stream';
import type { AgentOpsEvent } from '@/lib/agent-ops/types';

const e = (sk: string) => ({ SK: sk, runId: 'r1', eventType: 'planning', node: 'x', createdAt: 'now', PK: 'RUN#r1', ttl: 0 }) as AgentOpsEvent;

describe('appendEvent', () => {
    it('appends a new event', () => {
        const old = { run: { runId: 'r1' }, events: [e('EVENT#1#0')] } as never;
        const next = appendEvent(old, e('EVENT#2#0'));
        expect(next!.events).toHaveLength(2);
    });
    it('dedups by SK', () => {
        const old = { run: { runId: 'r1' }, events: [e('EVENT#1#0')] } as never;
        const next = appendEvent(old, e('EVENT#1#0'));
        expect(next!.events).toHaveLength(1);
    });
    it('returns undefined when cache is empty (no clobber before initial fetch)', () => {
        expect(appendEvent(undefined, e('EVENT#1#0'))).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run components/agent-ops/run-timeline/append-event.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add query keys**

In `apps/web-ui/lib/queries/query-keys.ts`, add a domain (alphabetical placement next to the others is fine):

```ts
    agentOps: {
        all: ['agent-ops'] as const,
        lists: () => [...queryKeys.agentOps.all, 'list'] as const,
        list: (filters?: unknown) => [...queryKeys.agentOps.lists(), filters ?? {}] as const,
        details: () => [...queryKeys.agentOps.all, 'detail'] as const,
        detail: (runId: string) => [...queryKeys.agentOps.details(), runId] as const,
    },
```

- [ ] **Step 4: Create the query hooks**

`apps/web-ui/lib/queries/agent-ops.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { queryKeys } from './query-keys';
import type { AgentOpsRun, AgentOpsEvent } from '@/lib/agent-ops/types';

export interface RunListFilters {
    source?: string;
    status?: string;
    limit?: number;
}

export interface RunDetail {
    run: AgentOpsRun;
    events: AgentOpsEvent[];
}

const ACTIVE = new Set(['queued', 'in_progress', 'awaiting_input', 'awaiting_approval']);

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data as T;
}

export function useAgentOpsRuns(filters: RunListFilters = {}) {
    return useQuery({
        queryKey: queryKeys.agentOps.list(filters),
        queryFn: async () => {
            const params = new URLSearchParams({ limit: String(filters.limit ?? 50) });
            if (filters.source && filters.source !== 'all') params.set('source', filters.source);
            if (filters.status && filters.status !== 'all') params.set('status', filters.status);
            const data = await fetchJson<{ runs: AgentOpsRun[] }>(`/api/agent-ops?${params}`);
            return data.runs ?? [];
        },
        refetchInterval: (query) =>
            (query.state.data ?? []).some(r => ACTIVE.has(r.status)) ? 5000 : 30000,
    });
}

export function useAgentOpsRunDetail(runId: string, opts: { pollMs?: number | false } = {}) {
    return useQuery({
        queryKey: queryKeys.agentOps.detail(runId),
        queryFn: () => fetchJson<RunDetail>(`/api/agent-ops/${runId}`),
        enabled: !!runId,
        refetchInterval: opts.pollMs ?? false,
    });
}

function useRunAction(path: (runId: string) => string, verb: string) {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: ({ runId, body }: { runId: string; body?: Record<string, unknown> }) =>
            fetchJson(path(runId), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body ?? {}),
            }),
        onSuccess: (_d, { runId }) => {
            qc.invalidateQueries({ queryKey: queryKeys.agentOps.detail(runId) });
            qc.invalidateQueries({ queryKey: queryKeys.agentOps.lists() });
        },
        onError: (err) => toast.error(`Failed to ${verb} run`, { description: (err as Error).message }),
    });
}

export function useCancelRun() {
    return useRunAction((id) => `/api/agent-ops/${id}/cancel`, 'cancel');
}
export function useApproveRun() {
    return useRunAction((id) => `/api/agent-ops/${id}/approve`, 'update');
}
export function useResumeRun() {
    return useRunAction((id) => `/api/agent-ops/${id}/resume`, 'resume');
}
```

Note: the cancel/approve/resume API routes accept `tenantId`/`action`/`userInput` in the body — callers pass them via `body` (Task 8 shows the call sites).

- [ ] **Step 5: Create the SSE hook**

`apps/web-ui/components/agent-ops/run-timeline/use-run-stream.ts`:

```ts
"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queries/query-keys";
import type { RunDetail } from "@/lib/queries/agent-ops";
import type { AgentOpsEvent, AgentOpsRun } from "@/lib/agent-ops/types";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const MAX_BACKOFF_MS = 30_000;

/** Pure cache merge: append an event unless its SK is already present. */
export function appendEvent(old: RunDetail | undefined, ev: AgentOpsEvent): RunDetail | undefined {
  if (!old) return undefined;
  if (old.events.some(e => e.SK === ev.SK)) return old;
  return { ...old, events: [...old.events, ev] };
}

function safeParse<T>(raw: string): T | null {
  try { return JSON.parse(raw) as T; } catch { return null; }
}

/**
 * Live-stream run events into the TanStack Query cache while the run is active.
 * Returns { streaming } so the caller can enable polling fallback when false.
 */
export function useRunStream(runId: string, active: boolean): { streaming: boolean } {
  const qc = useQueryClient();
  const [streaming, setStreaming] = useState(false);
  const retryRef = useRef(0);

  useEffect(() => {
    if (!active || !runId) return;
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const detailKey = queryKeys.agentOps.detail(runId);

    const open = () => {
      es = new EventSource(`/api/agent-ops/${runId}/stream`);
      es.onopen = () => { retryRef.current = 0; setStreaming(true); };
      es.addEventListener("run-event", (e) => {
        const ev = safeParse<AgentOpsEvent>((e as MessageEvent).data);
        if (ev) qc.setQueryData<RunDetail>(detailKey, (old) => appendEvent(old, ev));
      });
      es.addEventListener("status", (e) => {
        const run = safeParse<AgentOpsRun>((e as MessageEvent).data);
        if (!run) return;
        qc.setQueryData<RunDetail>(detailKey, (old) => (old ? { ...old, run } : old));
        if (TERMINAL.has(run.status)) {
          stopped = true;
          es?.close();
          setStreaming(false);
          // One authoritative refetch after settle (catches any missed frame).
          qc.invalidateQueries({ queryKey: detailKey });
          qc.invalidateQueries({ queryKey: queryKeys.agentOps.lists() });
        }
      });
      es.onerror = () => {
        es?.close();
        setStreaming(false);
        if (!stopped) {
          retryRef.current += 1;
          const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** retryRef.current);
          timer = setTimeout(open, delay);
        }
      };
    };

    open();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      es?.close();
      setStreaming(false);
    };
  }, [runId, active, qc]);

  return { streaming };
}
```

- [ ] **Step 6: Run tests**

Run: `bunx vitest run components/agent-ops/run-timeline/append-event.test.ts` → PASS (3 tests).
Run: `bunx tsc --noEmit 2>&1 | grep -c "error TS"` → ≤ baseline.

- [ ] **Step 7: Commit**

```bash
git add apps/web-ui/lib/queries/query-keys.ts apps/web-ui/lib/queries/agent-ops.ts apps/web-ui/components/agent-ops/run-timeline/use-run-stream.ts apps/web-ui/components/agent-ops/run-timeline/append-event.test.ts
git commit -m "feat(agent-ops): TanStack Query hooks + SSE client hook for runs"
```

---

### Task 6: Timeline step components

Presentational components only — no data fetching. All files under `apps/web-ui/components/agent-ops/run-timeline/`. Verified by tsc + Task 8's page integration (no DOM test framework in this repo).

**Files:**
- Create: `apps/web-ui/components/agent-ops/run-timeline/step-shell.tsx`
- Create: `apps/web-ui/components/agent-ops/run-timeline/tool-step.tsx`
- Create: `apps/web-ui/components/agent-ops/run-timeline/memory-step.tsx`
- Create: `apps/web-ui/components/agent-ops/run-timeline/evaluation-step.tsx`
- Create: `apps/web-ui/components/agent-ops/run-timeline/simple-steps.tsx` (planning, reflection, final, error)
- Create: `apps/web-ui/components/agent-ops/run-timeline/thinking-bubble.tsx`
- Create: `apps/web-ui/components/agent-ops/run-timeline/working-group.tsx`

**Interfaces:**
- Consumes: `TimelineStep` variants from Task 4; `MemoryRecallStats`/`MemorySaveStats` from Task 1 (via `event.metadata`); `MarkdownContent` from `@/components/ui/markdown-content`; `formatTime` from `@/lib/date-utils`.
- Produces: `<ToolStep step timezone>`, `<MemoryStep step timezone>`, `<EvaluationStep step timezone>`, `<PlanningStep|ReflectionStep|FinalStep|ErrorStep event timezone>`, `<ThinkingBubble event>`, `<WorkingGroup step timezone>` — each accepting its exact `TimelineStep` variant. `WorkingGroup` renders children via the same `StepRenderer` used by `timeline.tsx` (Task 7 exports it; to avoid a cycle, `working-group.tsx` accepts a `renderStep: (s: TimelineStep, i: number) => ReactNode` prop).

- [ ] **Step 1: Shared step shell**

`step-shell.tsx` — the collapsed one-liner + expandable body every step uses:

```tsx
"use client";

import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

export function StepShell({
  icon,
  iconClass,
  title,
  meta,
  time,
  defaultOpen = false,
  running = false,
  tone = "default",
  children,
}: {
  icon: ReactNode;
  iconClass?: string;
  title: ReactNode;
  meta?: ReactNode;
  time?: string;
  defaultOpen?: boolean;
  running?: boolean;
  tone?: "default" | "error";
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const expandable = !!children;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className={cn(
        "rounded-lg border bg-card",
        tone === "error" && "border-red-300 dark:border-red-900",
        running && "border-primary/50 shadow-[0_0_0_2px_hsl(var(--primary)/0.12)]",
      )}
    >
      <button
        type="button"
        onClick={() => expandable && setOpen(o => !o)}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left text-sm",
          expandable && "cursor-pointer hover:bg-accent/40 rounded-lg",
        )}
      >
        <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-md", iconClass)}>
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
        {meta}
        {time && <span className="shrink-0 text-xs text-muted-foreground">{time}</span>}
        {expandable && (
          <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && children && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="border-t px-3 py-2.5">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export function formatStepDuration(ms?: number): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}
```

- [ ] **Step 2: Tool step**

`tool-step.tsx`:

```tsx
"use client";

import { Check, Loader2, Wrench, X } from "lucide-react";
import { StepShell, formatStepDuration } from "./step-shell";
import { formatTime } from "@/lib/date-utils";
import type { TimelineStep } from "./build-steps";

type ToolStepData = Extract<TimelineStep, { kind: "tool" }>;

function StatusBadge({ status }: { status: ToolStepData["status"] }) {
  if (status === "ok") return <Check className="size-3.5 shrink-0 text-green-600" />;
  if (status === "error") return <span className="flex shrink-0 items-center gap-1 text-xs text-red-600"><X className="size-3.5" /> failed</span>;
  if (status === "running") return <span className="flex shrink-0 items-center gap-1 text-xs text-primary"><Loader2 className="size-3 animate-spin" /> running</span>;
  return null;
}

export function ToolStep({ step, timezone }: { step: ToolStepData; timezone?: string }) {
  const anchor = step.call ?? step.result;
  const args = step.call?.toolArgs;
  const output = step.result?.toolOutput ?? step.result?.content;

  return (
    <StepShell
      icon={<Wrench className="size-3.5 text-sky-600" />}
      iconClass="bg-sky-100 dark:bg-sky-950/50"
      title={<span className="font-mono text-[13px]">{step.toolName}</span>}
      meta={
        <span className="flex shrink-0 items-center gap-2">
          <StatusBadge status={step.status} />
          {step.durationMs !== undefined && (
            <span className="text-xs text-muted-foreground">{formatStepDuration(step.durationMs)}</span>
          )}
        </span>
      }
      time={anchor ? formatTime(anchor.createdAt, timezone) : undefined}
      running={step.status === "running"}
      tone={step.status === "error" ? "error" : "default"}
      defaultOpen={step.status === "error"}
    >
      {args && Object.keys(args).length > 0 && (
        <div className="mb-2">
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Arguments</p>
          <pre className="max-h-56 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-xs">
            {JSON.stringify(args, null, 2)}
          </pre>
        </div>
      )}
      {output && (
        <div>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Output</p>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted/60 p-2 font-mono text-xs">
            {output}
          </pre>
        </div>
      )}
      {!args && !output && <p className="text-xs text-muted-foreground">No detail captured.</p>}
    </StepShell>
  );
}
```

- [ ] **Step 3: Memory step**

`memory-step.tsx`:

```tsx
"use client";

import { Brain } from "lucide-react";
import { StepShell } from "./step-shell";
import { formatTime } from "@/lib/date-utils";
import type { MemoryRecallStats, MemorySaveStats } from "@/lib/agent/memory/types";
import type { TimelineStep } from "./build-steps";

type MemoryStepData = Extract<TimelineStep, { kind: "memory" }>;

function HitList({ label, hits }: { label: string; hits: Array<{ key: string; distance?: number }> }) {
  if (!hits.length) return null;
  return (
    <div className="mb-2 last:mb-0">
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <ul className="space-y-0.5">
        {hits.map(h => (
          <li key={h.key} className="flex items-center gap-2 text-xs">
            <span className="font-mono">{h.key}</span>
            {h.distance !== undefined && (
              <span className="text-muted-foreground">d={h.distance.toFixed(2)}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MemoryStep({ step, timezone }: { step: MemoryStepData; timezone?: string }) {
  const meta = step.event.metadata as unknown as (MemoryRecallStats | MemorySaveStats) | undefined;
  const isRecall = step.phase === "recall";
  const recall = meta && meta.phase === "recall" ? meta : undefined;
  const save = meta && meta.phase === "save" ? meta : undefined;
  const hasDetail = !!(recall && (recall.facts.length || recall.rules.length || recall.episodes.length)) || !!save;

  return (
    <StepShell
      icon={<Brain className="size-3.5 text-violet-600" />}
      iconClass="bg-violet-100 dark:bg-violet-950/50"
      title={step.event.content || (isRecall ? "Memory recall" : "Memory save")}
      time={formatTime(step.event.createdAt, timezone)}
    >
      {hasDetail ? (
        <>
          {recall && (
            <>
              <HitList label="Facts" hits={recall.facts} />
              <HitList label="Learned rules" hits={recall.rules} />
              <HitList label="Episodes replayed" hits={recall.episodes} />
            </>
          )}
          {save && (
            <ul className="space-y-0.5 text-xs">
              <li>{save.savedFacts} fact(s), {save.savedRules} rule(s) saved</li>
              <li>Episode captured: {save.episodeCaptured ? "yes" : "no"}</li>
              {save.reconcileActions && (
                <li className="text-muted-foreground">
                  Reconcile: {Object.entries(save.reconcileActions).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${k}`).join(", ") || "no-op"}
                </li>
              )}
            </ul>
          )}
        </>
      ) : undefined}
    </StepShell>
  );
}
```

Note: when `hasDetail` is false pass `undefined` as children so the shell renders non-expandable — the ternary above does exactly that.

- [ ] **Step 4: Evaluation step**

`evaluation-step.tsx`:

```tsx
"use client";

import { Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { StepShell } from "./step-shell";
import { formatTime } from "@/lib/date-utils";
import type { TimelineStep } from "./build-steps";

type EvaluationStepData = Extract<TimelineStep, { kind: "evaluation" }>;

export function EvaluationStep({ step, timezone }: { step: EvaluationStepData; timezone?: string }) {
  const m = (step.event.metadata ?? {}) as {
    mode?: string; skillId?: string | null; skillName?: string | null;
    knowledgeBaseIds?: string[]; requiresApproval?: boolean;
  };
  const kbs = m.knowledgeBaseIds ?? [];

  return (
    <StepShell
      icon={<Zap className="size-3.5 text-amber-600" />}
      iconClass="bg-amber-100 dark:bg-amber-950/50"
      title="Evaluated request"
      meta={
        <span className="flex shrink-0 flex-wrap items-center gap-1">
          {m.mode && <Badge variant="secondary" className="px-1.5 py-0 text-[11px]">{m.mode} mode</Badge>}
          {(m.skillName || m.skillId) && (
            <Badge variant="outline" className="px-1.5 py-0 text-[11px]">skill: {m.skillName ?? m.skillId}</Badge>
          )}
          {kbs.length > 0 && <Badge variant="outline" className="px-1.5 py-0 text-[11px]">KB ×{kbs.length}</Badge>}
          {m.requiresApproval && <Badge variant="outline" className="border-amber-400 px-1.5 py-0 text-[11px] text-amber-600">approval</Badge>}
        </span>
      }
      time={formatTime(step.event.createdAt, timezone)}
    >
      {step.event.content ? (
        <div className="space-y-2 text-xs">
          <p className="text-muted-foreground">{step.event.content}</p>
          {kbs.length > 0 && <p>Knowledge bases: <span className="font-mono">{kbs.join(", ")}</span></p>}
        </div>
      ) : undefined}
    </StepShell>
  );
}
```

- [ ] **Step 5: Simple steps (planning / reflection / final / error) + thinking bubble**

`simple-steps.tsx`:

```tsx
"use client";

import { CheckCircle2, ClipboardList, RefreshCw, XCircle } from "lucide-react";
import { MarkdownContent } from "@/components/ui/markdown-content";
import { StepShell } from "./step-shell";
import { formatTime } from "@/lib/date-utils";
import type { AgentOpsEvent } from "@/lib/agent-ops/types";

const PREVIEW_LEN = 140;

function preview(text?: string): string {
  if (!text) return "";
  const line = text.split("\n")[0];
  return line.length > PREVIEW_LEN ? `${line.slice(0, PREVIEW_LEN)}…` : line;
}

function ContentBody({ content }: { content?: string }) {
  if (!content) return null;
  return (
    <div className="max-h-96 overflow-auto text-sm">
      <MarkdownContent content={content} />
    </div>
  );
}

export function PlanningStep({ event, timezone }: { event: AgentOpsEvent; timezone?: string }) {
  return (
    <StepShell
      icon={<ClipboardList className="size-3.5 text-blue-600" />}
      iconClass="bg-blue-100 dark:bg-blue-950/50"
      title={preview(event.content) || "Planning"}
      time={formatTime(event.createdAt, timezone)}
    >
      <ContentBody content={event.content} />
    </StepShell>
  );
}

export function ReflectionStep({ event, timezone }: { event: AgentOpsEvent; timezone?: string }) {
  return (
    <StepShell
      icon={<RefreshCw className="size-3.5 text-purple-600" />}
      iconClass="bg-purple-100 dark:bg-purple-950/50"
      title={event.eventType === "revision" ? "Revision" : "Reflection"}
      meta={<span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{preview(event.content)}</span>}
      time={formatTime(event.createdAt, timezone)}
    >
      <ContentBody content={event.content} />
    </StepShell>
  );
}

export function FinalStep({ event, timezone }: { event: AgentOpsEvent; timezone?: string }) {
  return (
    <StepShell
      icon={<CheckCircle2 className="size-3.5 text-green-600" />}
      iconClass="bg-green-100 dark:bg-green-950/50"
      title={event.node === "__cancelled__" ? "Run cancelled" : "Final summary"}
      time={formatTime(event.createdAt, timezone)}
      defaultOpen
    >
      <ContentBody content={event.content} />
    </StepShell>
  );
}

export function ErrorStep({ event, timezone }: { event: AgentOpsEvent; timezone?: string }) {
  return (
    <StepShell
      icon={<XCircle className="size-3.5 text-red-600" />}
      iconClass="bg-red-100 dark:bg-red-950/50"
      title={preview(event.content) || "Error"}
      time={formatTime(event.createdAt, timezone)}
      tone="error"
      defaultOpen
    >
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-red-50 p-2 font-mono text-xs text-red-700 dark:bg-red-950/30 dark:text-red-400">
        {event.content}
      </pre>
    </StepShell>
  );
}
```

`thinking-bubble.tsx`:

```tsx
"use client";

import { motion } from "framer-motion";
import { MarkdownContent } from "@/components/ui/markdown-content";
import type { AgentOpsEvent } from "@/lib/agent-ops/types";

/** Narrative agent thinking, rendered as a quiet bubble between steps (design: B-style). */
export function ThinkingBubble({ event }: { event: AgentOpsEvent }) {
  if (!event.content) return null;
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="max-w-[94%] rounded-xl border border-dashed border-muted-foreground/25 bg-muted/30 px-3.5 py-2.5 text-sm italic text-muted-foreground [&_p]:my-0.5"
    >
      <MarkdownContent content={event.content} />
    </motion.div>
  );
}
```

- [ ] **Step 6: Working group**

`working-group.tsx`:

```tsx
"use client";

import { useState, type ReactNode } from "react";
import { ChevronRight, Loader2, Terminal } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { formatStepDuration } from "./step-shell";
import type { TimelineStep } from "./build-steps";

type GroupStepData = Extract<TimelineStep, { kind: "group" }>;

export function WorkingGroup({
  step,
  renderStep,
}: {
  step: GroupStepData;
  renderStep: (s: TimelineStep, i: number) => ReactNode;
}) {
  // Groups with live work stay open; settled groups start collapsed.
  const [open, setOpen] = useState(step.running);
  const toolCount = step.steps.filter(s => s.kind === "tool").length;

  return (
    <div className={cn("rounded-lg border bg-muted/20", step.running && "border-primary/40")}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent/40"
      >
        {step.running
          ? <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
          : <Terminal className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className="flex-1 font-medium text-muted-foreground">
          {step.running ? "Working" : "Worked"} — {toolCount} tool call{toolCount === 1 ? "" : "s"}
        </span>
        {step.durationMs > 0 && (
          <span className="text-xs text-muted-foreground">{formatStepDuration(step.durationMs)}</span>
        )}
        <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-90")} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="space-y-2 border-t px-3 py-2.5 pl-5">
              {step.steps.map((s, i) => renderStep(s, i))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
```

- [ ] **Step 7: Verify + commit**

Run: `bunx tsc --noEmit 2>&1 | grep -c "error TS"` → ≤ baseline.

```bash
git add apps/web-ui/components/agent-ops/run-timeline/
git commit -m "feat(agent-ops): timeline step components (A+B hybrid layout)"
```

---

### Task 7: `RunTimeline` + `RunHeader`

**Files:**
- Create: `apps/web-ui/components/agent-ops/run-timeline/timeline.tsx`
- Create: `apps/web-ui/components/agent-ops/run-timeline/run-header.tsx`

**Interfaces:**
- Consumes: everything from Tasks 4-6.
- Produces (Task 8 uses):
  - `<RunTimeline events={AgentOpsEvent[]} runStatus={AgentOpsStatus} timezone={string?} live={boolean} />`
  - `<RunHeader run={AgentOpsRun} tokens={{input: number; output: number}} streaming={boolean} onCancel={() => void} cancelling={boolean} onExportPdf={() => void} exporting={boolean} onBack={() => void} />`

- [ ] **Step 1: Timeline with auto-scroll pinning**

`timeline.tsx`:

```tsx
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { buildSteps, type TimelineStep } from "./build-steps";
import { ToolStep } from "./tool-step";
import { MemoryStep } from "./memory-step";
import { EvaluationStep } from "./evaluation-step";
import { PlanningStep, ReflectionStep, FinalStep, ErrorStep } from "./simple-steps";
import { ThinkingBubble } from "./thinking-bubble";
import { WorkingGroup } from "./working-group";
import type { AgentOpsEvent, AgentOpsStatus } from "@/lib/agent-ops/types";

function StepRenderer({ step, timezone }: { step: TimelineStep; timezone?: string }) {
  switch (step.kind) {
    case "memory": return <MemoryStep step={step} timezone={timezone} />;
    case "evaluation": return <EvaluationStep step={step} timezone={timezone} />;
    case "planning": return <PlanningStep event={step.event} timezone={timezone} />;
    case "thinking": return <ThinkingBubble event={step.event} />;
    case "tool": return <ToolStep step={step} timezone={timezone} />;
    case "reflection": return <ReflectionStep event={step.event} timezone={timezone} />;
    case "final": return <FinalStep event={step.event} timezone={timezone} />;
    case "error": return <ErrorStep event={step.event} timezone={timezone} />;
    case "group":
      return (
        <WorkingGroup
          step={step}
          renderStep={(s, i) => <StepRenderer key={i} step={s} timezone={timezone} />}
        />
      );
  }
}

export function RunTimeline({
  events,
  runStatus,
  timezone,
  live,
}: {
  events: AgentOpsEvent[];
  runStatus: AgentOpsStatus;
  timezone?: string;
  live: boolean;
}) {
  const steps = useMemo(() => buildSteps(events, runStatus), [events, runStatus]);
  const endRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(false);
  const lastCount = useRef(0);

  // Follow the newest step unless the user scrolled away (pinned).
  useEffect(() => {
    if (events.length > lastCount.current && live && !pinned) {
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
    lastCount.current = events.length;
  }, [events.length, live, pinned]);

  useEffect(() => {
    if (!live) return;
    const onScroll = () => {
      const gap = document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
      setPinned(gap > 240);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [live]);

  if (events.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {runStatus === "queued" ? "Waiting for the agent to start…" : "No events recorded."}
      </p>
    );
  }

  return (
    <div className="relative space-y-2">
      {steps.map((step, i) => <StepRenderer key={i} step={step} timezone={timezone} />)}
      {live && (
        <div className="flex items-center gap-2 px-1 py-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> Agent is working…
        </div>
      )}
      <div ref={endRef} />
      {pinned && live && (
        <div className="sticky bottom-4 flex justify-center">
          <Button
            size="sm"
            variant="secondary"
            className="shadow-md"
            onClick={() => {
              setPinned(false);
              endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
            }}
          >
            <ArrowDown className="mr-1.5 size-3.5" /> Jump to latest
          </Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Run header**

`run-header.tsx`:

```tsx
"use client";

import {
  ArrowLeft, CalendarClock, CheckCircle2, Cpu, Download, Globe, Loader2,
  MessageSquare, ShieldCheck, StopCircle, Timer, Wifi, XCircle, Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AgentOpsRun, AgentOpsStatus } from "@/lib/agent-ops/types";

const STATUS_STYLE: Record<AgentOpsStatus, { label: string; className: string; icon: typeof Loader2; spin?: boolean }> = {
  queued: { label: "Queued", className: "bg-muted text-muted-foreground", icon: Timer },
  in_progress: { label: "Running", className: "bg-primary/10 text-primary", icon: Loader2, spin: true },
  awaiting_input: { label: "Needs input", className: "bg-blue-500/10 text-blue-600", icon: MessageSquare },
  awaiting_approval: { label: "Needs approval", className: "bg-amber-500/10 text-amber-600", icon: ShieldCheck },
  completed: { label: "Completed", className: "bg-green-500/10 text-green-600", icon: CheckCircle2 },
  failed: { label: "Failed", className: "bg-red-500/10 text-red-600", icon: XCircle },
  cancelled: { label: "Cancelled", className: "bg-muted text-muted-foreground", icon: StopCircle },
};

const SOURCE_ICONS: Record<string, typeof Globe> = {
  slack: MessageSquare, scheduled: CalendarClock, api: Globe, jira: Zap,
};

function fmtDuration(ms?: number): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export function RunHeader({
  run, tokens, streaming, onCancel, cancelling, onExportPdf, exporting, onBack,
}: {
  run: AgentOpsRun;
  tokens: { input: number; output: number };
  streaming: boolean;
  onCancel: () => void;
  cancelling: boolean;
  onExportPdf: () => void;
  exporting: boolean;
  onBack: () => void;
}) {
  const status = STATUS_STYLE[run.status];
  const StatusIcon = status.icon;
  const SourceIcon = SOURCE_ICONS[run.source] ?? Globe;
  const active = run.status === "in_progress" || run.status === "queued";

  return (
    <div className="sticky top-0 z-10 -mx-1 space-y-3 border-b bg-background/95 px-1 pb-4 pt-1 backdrop-blur">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back to Agent Ops">
          <ArrowLeft className="size-4" />
        </Button>
        <span className={cn("flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium", status.className)}>
          <StatusIcon className={cn("size-3.5", status.spin && "animate-spin")} />
          {status.label}
        </span>
        {streaming && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Wifi className="size-3 text-green-600" /> live
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {run.status === "completed" && (
            <Button variant="outline" size="sm" onClick={onExportPdf} disabled={exporting}>
              {exporting ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Download className="mr-1.5 size-3.5" />}
              PDF
            </Button>
          )}
          {active && (
            <Button variant="destructive" size="sm" onClick={onCancel} disabled={cancelling}>
              {cancelling ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <StopCircle className="mr-1.5 size-3.5" />}
              Cancel
            </Button>
          )}
        </span>
      </div>

      <p className="line-clamp-2 text-[15px] font-medium leading-snug">{run.taskDescription}</p>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1"><SourceIcon className="size-3" /><span className="capitalize">{run.source}</span></span>
        <span className="capitalize">{run.mode} mode</span>
        {run.selectedSkill && <Badge variant="outline" className="px-1.5 py-0 text-[11px]">skill: {run.selectedSkill}</Badge>}
        {run.accountName && <span>{run.accountName}</span>}
        <span className="flex items-center gap-1"><Timer className="size-3" />{fmtDuration(run.durationMs)}</span>
        {(tokens.input > 0 || tokens.output > 0) && (
          <span className="flex items-center gap-1"><Cpu className="size-3" />{tokens.input.toLocaleString()}↑ {tokens.output.toLocaleString()}↓</span>
        )}
        <span className="font-mono text-[11px] opacity-60">{run.runId}</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify + commit**

Run: `bunx tsc --noEmit 2>&1 | grep -c "error TS"` → ≤ baseline.
Run: `bunx vitest run components/agent-ops/run-timeline/` → build-steps + append-event suites still PASS.

```bash
git add apps/web-ui/components/agent-ops/run-timeline/timeline.tsx apps/web-ui/components/agent-ops/run-timeline/run-header.tsx
git commit -m "feat(agent-ops): RunTimeline + RunHeader components"
```

---

### Task 8: Rebuild the run-detail page

**Files:**
- Modify: `apps/web-ui/app/app/agent-ops/[runId]/page.tsx` (full rewrite — the old `EVENT_TYPE_CONFIG`/`EventRow` go away)

**Interfaces:**
- Consumes: `RunHeader`, `RunTimeline`, `useAgentOpsRunDetail`, `useRunStream`, `useCancelRun`, `useApproveRun`, `useResumeRun`, `exportRunToPdf`.
- Behavior contract: SSE streams while active; when `streaming === false` and run active, the detail query polls every 2s; HIL panels render inline BELOW the timeline; result/error cards stay; all action failures toast.

- [ ] **Step 1: Rewrite the page**

Replace the entire content of `apps/web-ui/app/app/agent-ops/[runId]/page.tsx` with:

```tsx
"use client"

import { useCallback, useState } from "react"
import { useParams, useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { MarkdownContent } from "@/components/ui/markdown-content"
import { Spinner } from "@/components/ui/spinner"
import {
  ArrowLeft, CheckCircle2, Clock, Loader2, MessageSquare, ShieldCheck, ShieldX, XCircle,
} from "lucide-react"
import { RunHeader } from "@/components/agent-ops/run-timeline/run-header"
import { RunTimeline } from "@/components/agent-ops/run-timeline/timeline"
import { useRunStream } from "@/components/agent-ops/run-timeline/use-run-stream"
import { useAgentOpsRunDetail, useApproveRun, useCancelRun, useResumeRun } from "@/lib/queries/agent-ops"
import { exportRunToPdf } from "@/lib/agent-ops/export-pdf"
import { useTenant } from "@/lib/tenant-context"

const ACTIVE = new Set(["queued", "in_progress", "awaiting_input", "awaiting_approval"])

export default function RunDetailPage() {
  const params = useParams()
  const router = useRouter()
  const runId = params.runId as string
  const { timezone } = useTenant()

  const [exporting, setExporting] = useState(false)
  const [clarificationText, setClarificationText] = useState("")

  // First fetch without polling; useRunStream drives live updates, and we fall
  // back to 2s polling only while the run is active and the stream is down.
  const detail = useAgentOpsRunDetail(runId, { pollMs: undefined })
  const run = detail.data?.run
  const events = detail.data?.events ?? []
  const isActive = !!run && ACTIVE.has(run.status)

  const { streaming } = useRunStream(runId, isActive)

  // Polling fallback: a second subscription on the same query key contributes
  // an interval only when the run is active and the stream is down.
  useAgentOpsRunDetail(runId, { pollMs: isActive && !streaming ? 2000 : false })

  const cancelRun = useCancelRun()
  const approveRun = useApproveRun()
  const resumeRun = useResumeRun()

  const handleExportPdf = useCallback(async () => {
    if (!run) return
    setExporting(true)
    try { await exportRunToPdf(run, events) } finally { setExporting(false) }
  }, [run, events])

  if (detail.isLoading) {
    return <div className="flex flex-1 items-center justify-center py-24"><Spinner /></div>
  }

  if (!run) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center py-24 text-muted-foreground">
        <XCircle className="mb-3 h-12 w-12 opacity-30" />
        <p className="font-medium">Run not found</p>
        <Button variant="ghost" className="mt-3" onClick={() => router.push("/app/agent-ops")}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Back to Agent Ops
        </Button>
      </div>
    )
  }

  const tokens = events.reduce(
    (acc, e) => {
      acc.input += (e.metadata?.inputTokens as number) || 0
      acc.output += (e.metadata?.outputTokens as number) || 0
      return acc
    },
    { input: 0, output: 0 },
  )

  return (
    <div className="space-y-5">
      <RunHeader
        run={run}
        tokens={tokens}
        streaming={streaming}
        onCancel={() => cancelRun.mutate({ runId, body: { tenantId: run.tenantId } })}
        cancelling={cancelRun.isPending}
        onExportPdf={handleExportPdf}
        exporting={exporting}
        onBack={() => router.push("/app/agent-ops")}
      />

      {/* Result */}
      {run.result?.summary && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm text-green-600">
              <CheckCircle2 className="h-4 w-4" /> Result
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-md bg-muted p-4">
              <MarkdownContent content={run.result.summary} />
            </div>
            {run.result.toolsUsed?.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                <span className="mr-1 text-xs text-muted-foreground">Tools used:</span>
                {run.result.toolsUsed.map(tool => (
                  <Badge key={tool} variant="outline" className="text-xs">{tool}</Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Error */}
      {run.error && (
        <Card className="border-red-200 dark:border-red-800">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm text-red-600">
              <XCircle className="h-4 w-4" /> Error
            </CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="whitespace-pre-wrap rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/30">{run.error}</pre>
          </CardContent>
        </Card>
      )}

      {/* Timeline */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Clock className="h-4 w-4" /> Execution Timeline
            <Badge variant="secondary" className="ml-1 text-xs">{events.length} events</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <RunTimeline
            events={events}
            runStatus={run.status}
            timezone={timezone}
            live={run.status === "in_progress" || run.status === "queued"}
          />

          {/* HIL: clarification — inline where the run paused */}
          {run.status === "awaiting_input" && run.clarification && (
            <div className="mt-4 rounded-lg border border-blue-300 bg-blue-50/50 p-4 dark:border-blue-700 dark:bg-blue-950/20">
              <p className="mb-2 flex items-center gap-2 text-sm font-medium text-blue-700 dark:text-blue-400">
                <MessageSquare className="h-4 w-4" /> The agent needs your input
                {run.clarification.missingInfo && (
                  <Badge variant="outline" className="ml-auto border-blue-400 text-xs text-blue-600">{run.clarification.missingInfo}</Badge>
                )}
              </p>
              <div className="mb-3 rounded-md border bg-background p-3">
                <MarkdownContent content={run.clarification.question} />
              </div>
              <Textarea
                placeholder="Type your response…"
                value={clarificationText}
                onChange={e => setClarificationText(e.target.value)}
                rows={3}
                disabled={resumeRun.isPending}
              />
              <Button
                className="mt-3"
                disabled={resumeRun.isPending || !clarificationText.trim()}
                onClick={() => resumeRun.mutate(
                  { runId, body: { tenantId: run.tenantId, userInput: clarificationText.trim() } },
                  { onSuccess: () => setClarificationText("") },
                )}
              >
                {resumeRun.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <MessageSquare className="mr-2 h-4 w-4" />}
                Submit Response
              </Button>
            </div>
          )}

          {/* HIL: approval — inline where the run paused */}
          {run.status === "awaiting_approval" && run.approvalRequest && (
            <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50/50 p-4 dark:border-amber-700 dark:bg-amber-950/20">
              <p className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
                <ShieldCheck className="h-4 w-4" /> Approval required
                <Badge variant="outline" className="ml-auto border-amber-400 text-xs text-amber-600">
                  {run.approvalRequest.approvalType === "plan" ? "Plan" : "Tool execution"}
                </Badge>
              </p>
              <div className="mb-3 rounded-md border bg-background p-3">
                <ol className="list-inside list-decimal space-y-1">
                  {run.approvalRequest.planSteps.map((step: string, i: number) => (
                    <li key={i} className="text-sm">{step}</li>
                  ))}
                </ol>
                {run.approvalRequest.pendingTools && run.approvalRequest.pendingTools.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <span className="mr-1 text-xs text-muted-foreground">Mutative tools:</span>
                    {run.approvalRequest.pendingTools.map((tool: string) => (
                      <Badge key={tool} variant="outline" className="border-red-300 text-xs text-red-600">{tool}</Badge>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex gap-3">
                <Button
                  className="bg-green-600 text-white hover:bg-green-700"
                  disabled={approveRun.isPending}
                  onClick={() => approveRun.mutate({ runId, body: { tenantId: run.tenantId, action: "approve" } })}
                >
                  <ShieldCheck className="mr-2 h-4 w-4" /> Approve & Execute
                </Button>
                <Button
                  variant="destructive"
                  disabled={approveRun.isPending}
                  onClick={() => approveRun.mutate({ runId, body: { tenantId: run.tenantId, action: "reject" } })}
                >
                  <ShieldX className="mr-2 h-4 w-4" /> Reject
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
```

Note: the `useAgentOpsRunDetail(runId, { pollMs: ... })` double-call shares one cache entry (same query key) — the second subscription only contributes the interval. `pollMs: undefined` in the first call means "no interval from this subscriber".

- [ ] **Step 2: Verify**

Run: `bunx tsc --noEmit 2>&1 | grep -c "error TS"` → ≤ baseline.
Run: `bun run test` (from `apps/web-ui`) → no NEW failures vs pre-task run.

Manual smoke (requires `docker compose up -d postgres` + `bun run dev` at repo root and a configured LLM provider): open an old run → timeline renders with grouped steps; trigger a new run → live stream, thinking bubbles, memory/evaluation steps appear.

- [ ] **Step 3: Commit**

```bash
git add "apps/web-ui/app/app/agent-ops/[runId]/page.tsx"
git commit -m "feat(agent-ops): rebuild run-detail page on the new timeline suite"
```

---

### Task 9: Rebuild the Agent Ops list page

**Files:**
- Modify: `apps/web-ui/app/app/agent-ops/page.tsx`

**Interfaces:**
- Consumes: `useAgentOpsRuns`, `useCancelRun` (Task 5); `DropdownMenu` primitives from `@/components/ui/dropdown-menu`; existing `NewRunDialog`, `PageHeader`.
- Behavior contract: header no longer overflows (settings collapse into one dropdown); cards get status accent + chips + live pulse; filters/stats stay; data via hooks (no `useState`+`fetch`).

- [ ] **Step 1: Rewrite the page**

Keep `SOURCE_ICONS` and `STATUS_CONFIG` as-is, then replace the component body. Key changes (complete replacement for the sections named):

1. Data + actions — replace the `useState`/`useCallback`/`useEffect` fetch block with:

```tsx
export default function AgentOpsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tenantId = searchParams.get("tenantId") || "default";
  const { timezone } = useTenant();
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const runsQuery = useAgentOpsRuns({ source: sourceFilter, status: statusFilter });
  const runs = runsQuery.data ?? [];
  const loading = runsQuery.isLoading;
  const cancelRun = useCancelRun();
```

with imports:

```tsx
import { useAgentOpsRuns, useCancelRun } from "@/lib/queries/agent-ops";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Settings2 } from "lucide-react";
```

(drop the now-unused `useEffect`/`useCallback` imports.)

2. Header actions — replace the four settings `Button`s (Slack/Jira/MCP stay; Scheduled Tasks stays a top-level button) with:

```tsx
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => runsQuery.refetch()} disabled={runsQuery.isFetching}>
              <RefreshCw className={`h-4 w-4 mr-2 ${runsQuery.isFetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={() => router.push("/app/agent-ops/scheduled-tasks")}>
              <CalendarClock className="h-4 w-4 mr-2" />
              Scheduled Tasks
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <Settings2 className="h-4 w-4 mr-2" />
                  Settings
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => router.push("/app/agent-ops/slack-settings")}>
                  <MessageSquare className="h-4 w-4 mr-2" /> Slack
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => router.push("/app/agent-ops/jira-settings")}>
                  <AlertCircle className="h-4 w-4 mr-2" /> Jira
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => router.push("/app/agent-ops/mcp-settings")}>
                  <Plug className="h-4 w-4 mr-2" /> MCP Servers
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <NewRunDialog tenantId={tenantId} />
          </>
        }
```

3. Run cards — replace the row `<div>` body inside `runs.map(...)` with an accent-edged card (structure identical, upgraded visuals):

```tsx
                return (
                  <div
                    key={run.runId}
                    className={`relative flex items-center justify-between overflow-hidden rounded-lg border p-3 pl-4 hover:bg-accent/50 cursor-pointer transition-colors`}
                    onClick={() => router.push(`/app/agent-ops/${run.runId}?tenantId=${run.tenantId}`)}
                  >
                    <span
                      className={`absolute inset-y-0 left-0 w-1 ${
                        run.status === "completed" ? "bg-green-500/70"
                        : run.status === "failed" ? "bg-red-500/70"
                        : run.status === "in_progress" ? "bg-primary animate-pulse"
                        : run.status === "awaiting_approval" || run.status === "awaiting_input" ? "bg-amber-400/80"
                        : "bg-muted-foreground/30"
                      }`}
                    />
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-muted flex items-center justify-center">
                        <SourceIcon className="h-4 w-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm line-clamp-2">{run.taskDescription}</p>
                        <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                          <span className="capitalize">{run.source}</span>
                          <span>•</span>
                          <span>{run.mode} mode</span>
                          {run.selectedSkill && (<><span>•</span><span>skill: {run.selectedSkill}</span></>)}
                          <span>•</span>
                          <span>{formatTime(run.createdAt)}</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <span className="text-xs text-muted-foreground">{formatDuration(run.durationMs)}</span>
                      <Badge variant={statusConfig.variant} className="flex items-center gap-1">
                        <StatusIcon className={`h-3 w-3 ${run.status === "in_progress" ? "animate-spin" : ""}`} />
                        {statusConfig.label}
                      </Badge>
                      {(run.status === "in_progress" || run.status === "queued") && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-destructive hover:text-destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            cancelRun.mutate({ runId: run.runId, body: { tenantId: run.tenantId } });
                          }}
                          disabled={cancelRun.isPending}
                          title="Cancel run"
                        >
                          {cancelRun.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <StopCircle className="h-3 w-3" />}
                        </Button>
                      )}
                    </div>
                  </div>
                );
```

4. Loading state uses `Spinner` from `@/components/ui/spinner` instead of the inline `Loader2` block. Stats cards and filter `Select`s stay unchanged (they operate on `runs` exactly as before).

- [ ] **Step 2: Verify + commit**

Run: `bunx tsc --noEmit 2>&1 | grep -c "error TS"` → ≤ baseline.
Manual: `/app/agent-ops` header shows Refresh · Scheduled Tasks · Settings ▾ · New Agent Run on one row with no title wrap.

```bash
git add apps/web-ui/app/app/agent-ops/page.tsx
git commit -m "feat(agent-ops): modernize runs list page — query hooks, settings dropdown, accent cards"
```

---

### Task 10: PDF export entries + final verification sweep

**Files:**
- Modify: `apps/web-ui/lib/agent-ops/export-pdf.ts` (`EVENT_META` map at line ~4 and `TIMELINE_COLORS` map — both keyed by eventType)

**Interfaces:**
- Consumes: the three new event types.
- Produces: exported PDFs render memory/evaluation events with distinct styling (both maps already default unknown types — this makes them first-class).

- [ ] **Step 1: Add map entries**

In `EVENT_META` add:

```ts
    memory_recall: { label: "Memory Recall", bg: "#ede9fe", color: "#6d28d9" },
    memory_save:   { label: "Memory Save",   bg: "#ede9fe", color: "#6d28d9" },
    evaluation:    { label: "Evaluation",    bg: "#fef3c7", color: "#b45309" },
```

In `TIMELINE_COLORS` (same file — find the map keyed by eventType) add:

```ts
    memory_recall: "#8b5cf6",
    memory_save: "#8b5cf6",
    evaluation: "#f59e0b",
```

- [ ] **Step 2: Full verification sweep**

```bash
cd apps/web-ui
bunx tsc --noEmit 2>&1 | grep -c "error TS"     # ≤ recorded baseline
bun run test                                     # no NEW failures vs the pre-Task-1 run
bun run lint                                     # no NEW errors in touched files
```

Then a full manual smoke with the dev server (`bun run dev` at repo root):
1. Open an OLD run → timeline renders grouped steps, no memory/evaluation steps (expected), no console errors.
2. Trigger a new run (NewRunDialog) → header shows live + streaming; memory recall step appears first, evaluation step with mode/skill/KB pills, tool steps pair call+result, thinking bubbles between; scroll up mid-run → "Jump to latest" chip appears.
3. Cancel a run from the list page → toast on failure path verified by killing the dev server first (optional).
4. Export PDF on a completed run → memory/evaluation rows styled.

- [ ] **Step 3: Commit**

```bash
git add apps/web-ui/lib/agent-ops/export-pdf.ts
git commit -m "feat(agent-ops): PDF export styling for memory/evaluation events"
```

---

## Task Dependency Order

1 → 2 (executor consumes `memoryStats`) → 3 (independent of 2, needs nothing from it — can run after 1 or even parallel) → 4 (pure, independent) → 5 (needs 3's frame names, 4's types not required) → 6 (needs 4) → 7 (needs 4, 5, 6) → 8 (needs 5, 7) → 9 (needs 5) → 10 (last).
