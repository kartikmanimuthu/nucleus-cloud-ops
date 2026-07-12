# AIOps Chat UI Redesign Implementation Plan (Phase 2 — Mission Control)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat chat rendering with the approved Mission Control design: two-pane layout (conversation + live run rail), threaded run timeline, per-tool batch approval card, clarification card, and guard risk card — all driven by the typed data parts shipped in the backend plan.

**Architecture:** A single derivation hook (`useRunState`) parses typed data parts (`data-plan`, `data-phase`, `data-approval`, `data-clarification`) out of `useChat` messages into one `RunState` object; every new component renders from it. `chat-interface.tsx` keeps `useChat`, config state, and the composer wiring but delegates rendering to the new components. Old threads (no data parts) render through the existing legacy path unchanged.

**Tech Stack:** React 19, AI SDK 7 `useChat`, Tailwind + `cn()`, Radix primitives, existing `ai-elements` components, framer-motion (reduced-motion aware), Vitest + Playwright.

**Prerequisite:** `docs/superpowers/plans/2026-07-12-aiops-chat-backend.md` fully landed (data parts + decisions contract live).
**Spec:** `docs/superpowers/specs/2026-07-12-aiops-chat-overhaul-design.md`

## Global Constraints

- Do NOT modify `components/ui/*` primitives. `components/ai-elements/*` may be extended (new props), not rebuilt.
- All new components live under `apps/web-ui/components/agent/chat/`, kebab-case files, named exports, `"use client"` where hooks are used.
- Legacy threads (persisted before data parts existed) must keep rendering — the `MessageRow`/`renderPhaseBlock` path stays as fallback.
- The auto-approve checkbox is relabeled **"Auto-approve read-only tools"** (backend guard makes that its true meaning).
- The run rail collapses below the `lg` breakpoint into a header status strip; the page must stay usable on mobile.
- Decision submission uses the Plan A contract: `body.decisions: Array<{ toolCallId, approved, reason?, answer? }>`, submitted ONLY when every pending tool is decided.
- Wire shapes consumed here are defined in Plan A Task 8 (`data-plan`, `data-phase`, `data-approval`, `data-clarification`) and Task 9 (`plan`, `pendingInterrupt` on the history response).
- Tests: Vitest (`cd apps/web-ui && bun run test`); no new failures vs the recorded baseline.

---

### Task 1: Run-state types + useRunState hook

**Files:**
- Create: `apps/web-ui/components/agent/chat/run-state.ts` (pure derivation — testable without React)
- Create: `apps/web-ui/components/agent/chat/use-run-state.ts` (thin memo wrapper)
- Test: `apps/web-ui/components/agent/chat/__tests__/run-state.test.ts`

**Interfaces:**
- Produces (consumed by every later task):

```typescript
export interface RunPlanStep { step: string; status: 'pending' | 'in_progress' | 'completed' | 'failed' }
export interface RunGuardVerdict { toolCallId: string; toolName: string; isMutative: boolean; severity: 'LOW' | 'MEDIUM' | 'HIGH'; action: string; blastRadius: string; reversible: boolean; saferPath: string }
export interface PendingApprovalTool { toolCallId: string; toolName: string; args: Record<string, unknown>; guard: RunGuardVerdict | null }
export interface PendingClarification { toolCallId: string; question: string; options: string[] }
export interface RunState {
    plan: RunPlanStep[];
    planUpdatedBy: string | null;
    currentPhase: string;               // 'planning' | 'execution' | … | 'text'
    phases: Array<{ phase: string; node: string; ts: number }>;
    pendingApproval: { batchId: string; tools: PendingApprovalTool[] } | null;
    pendingClarifications: PendingClarification[];
    hasStructuredData: boolean;         // false → legacy thread, keep old rendering only
}
export function deriveRunState(messages: Array<{ role: string; parts?: Array<{ type: string; data?: unknown }> }>, resolvedToolCallIds: Set<string>): RunState
export function useRunState(messages: unknown[], resolvedToolCallIds: Set<string>): RunState
```

- `resolvedToolCallIds` = tool call ids that already have a result part or a local optimistic decision — pending items are filtered against it so a decided batch disappears from "pending" immediately.

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/web-ui/components/agent/chat/__tests__/run-state.test.ts
import { describe, it, expect } from 'vitest';
import { deriveRunState } from '../run-state';

const msg = (parts: Array<{ type: string; data?: unknown; text?: string }>) =>
    ({ role: 'assistant', parts });

describe('deriveRunState', () => {
    it('takes the LAST data-plan part as the live plan', () => {
        const rs = deriveRunState([
            msg([
                { type: 'data-plan', data: { steps: [{ step: 'a', status: 'pending' }], updatedBy: 'planner' } },
                { type: 'data-plan', data: { steps: [{ step: 'a', status: 'completed' }], updatedBy: 'reflect' } },
            ]),
        ] as any, new Set());
        expect(rs.plan).toEqual([{ step: 'a', status: 'completed' }]);
        expect(rs.planUpdatedBy).toBe('reflect');
        expect(rs.hasStructuredData).toBe(true);
    });

    it('tracks current phase from the last data-phase part', () => {
        const rs = deriveRunState([
            msg([
                { type: 'data-phase', data: { phase: 'planning', node: 'planner', ts: 1 } },
                { type: 'data-phase', data: { phase: 'execution', node: 'generate', ts: 2 } },
            ]),
        ] as any, new Set());
        expect(rs.currentPhase).toBe('execution');
        expect(rs.phases).toHaveLength(2);
    });

    it('surfaces pending approvals and clarifications, filtering resolved ids', () => {
        const rs = deriveRunState([
            msg([
                { type: 'data-approval', data: { batchId: 'b1', tools: [
                    { toolCallId: 't1', toolName: 'execute_command', args: {}, guard: null },
                    { toolCallId: 't2', toolName: 'write_file', args: {}, guard: { toolCallId: 't2', toolName: 'write_file', isMutative: true, severity: 'MEDIUM', action: '', blastRadius: '', reversible: true, saferPath: '' } },
                ] } },
                { type: 'data-clarification', data: { toolCallId: 't3', question: 'which?', options: ['a'] } },
            ]),
        ] as any, new Set(['t1']));
        expect(rs.pendingApproval!.tools.map(t => t.toolCallId)).toEqual(['t2']);
        expect(rs.pendingClarifications).toHaveLength(1);
    });

    it('clears pendingApproval entirely when all its tools are resolved', () => {
        const rs = deriveRunState([
            msg([{ type: 'data-approval', data: { batchId: 'b1', tools: [{ toolCallId: 't1', toolName: 'x', args: {}, guard: null }] } }]),
        ] as any, new Set(['t1']));
        expect(rs.pendingApproval).toBeNull();
    });

    it('legacy thread (no data parts) → hasStructuredData false, empty plan', () => {
        const rs = deriveRunState([msg([{ type: 'reasoning', text: 'PLANNING_PHASE_START\nsteps…' }])] as any, new Set());
        expect(rs.hasStructuredData).toBe(false);
        expect(rs.plan).toEqual([]);
    });

    it('only the LAST data-approval batch counts (earlier batches are history)', () => {
        const rs = deriveRunState([
            msg([{ type: 'data-approval', data: { batchId: 'b1', tools: [{ toolCallId: 't1', toolName: 'x', args: {}, guard: null }] } }]),
            msg([{ type: 'data-approval', data: { batchId: 'b2', tools: [{ toolCallId: 't9', toolName: 'y', args: {}, guard: null }] } }]),
        ] as any, new Set());
        expect(rs.pendingApproval!.batchId).toBe('b2');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web-ui && bunx vitest run components/agent/chat/__tests__/run-state.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement run-state.ts**

```typescript
// apps/web-ui/components/agent/chat/run-state.ts
// Pure derivation of live run state from typed message data parts.
// One source of truth for the run rail, the timeline, and the decision cards.

export interface RunPlanStep { step: string; status: 'pending' | 'in_progress' | 'completed' | 'failed' }
export interface RunGuardVerdict {
    toolCallId: string; toolName: string; isMutative: boolean;
    severity: 'LOW' | 'MEDIUM' | 'HIGH'; action: string; blastRadius: string;
    reversible: boolean; saferPath: string;
}
export interface PendingApprovalTool {
    toolCallId: string; toolName: string; args: Record<string, unknown>;
    guard: RunGuardVerdict | null;
}
export interface PendingClarification { toolCallId: string; question: string; options: string[] }

export interface RunState {
    plan: RunPlanStep[];
    planUpdatedBy: string | null;
    currentPhase: string;
    phases: Array<{ phase: string; node: string; ts: number }>;
    pendingApproval: { batchId: string; tools: PendingApprovalTool[] } | null;
    pendingClarifications: PendingClarification[];
    hasStructuredData: boolean;
}

interface LoosePart { type: string; data?: any; text?: string }
interface LooseMessage { role: string; parts?: LoosePart[] }

export function deriveRunState(
    messages: LooseMessage[],
    resolvedToolCallIds: Set<string>,
): RunState {
    let plan: RunPlanStep[] = [];
    let planUpdatedBy: string | null = null;
    const phases: RunState['phases'] = [];
    let lastApproval: { batchId: string; tools: PendingApprovalTool[] } | null = null;
    const clarifications: PendingClarification[] = [];
    let hasStructuredData = false;

    for (const message of messages) {
        if (message.role !== 'assistant') continue;
        for (const part of message.parts ?? []) {
            switch (part.type) {
                case 'data-plan': {
                    hasStructuredData = true;
                    const steps = Array.isArray(part.data?.steps) ? part.data.steps : [];
                    if (steps.length > 0) { plan = steps; planUpdatedBy = part.data?.updatedBy ?? null; }
                    break;
                }
                case 'data-phase': {
                    hasStructuredData = true;
                    if (part.data?.phase) phases.push({ phase: String(part.data.phase), node: String(part.data.node ?? ''), ts: Number(part.data.ts ?? 0) });
                    break;
                }
                case 'data-approval': {
                    hasStructuredData = true;
                    const tools = Array.isArray(part.data?.tools) ? part.data.tools : [];
                    lastApproval = { batchId: String(part.data?.batchId ?? ''), tools };
                    // Answering a clarification from an earlier turn means older
                    // clarifications are stale — a new approval batch resets them.
                    clarifications.length = 0;
                    break;
                }
                case 'data-clarification': {
                    hasStructuredData = true;
                    if (part.data?.toolCallId) {
                        clarifications.push({
                            toolCallId: String(part.data.toolCallId),
                            question: String(part.data.question ?? ''),
                            options: Array.isArray(part.data.options) ? part.data.options.map(String) : [],
                        });
                    }
                    break;
                }
            }
        }
    }

    const unresolvedTools = (lastApproval?.tools ?? []).filter(t => !resolvedToolCallIds.has(t.toolCallId));
    const pendingApproval = lastApproval && unresolvedTools.length > 0
        ? { batchId: lastApproval.batchId, tools: unresolvedTools }
        : null;
    const pendingClarifications = clarifications.filter(c => !resolvedToolCallIds.has(c.toolCallId));

    return {
        plan,
        planUpdatedBy,
        currentPhase: phases.length > 0 ? phases[phases.length - 1].phase : 'text',
        phases,
        pendingApproval,
        pendingClarifications,
        hasStructuredData,
    };
}
```

And the hook:

```typescript
// apps/web-ui/components/agent/chat/use-run-state.ts
"use client";

import { useMemo } from 'react';
import { deriveRunState, RunState } from './run-state';

export function useRunState(messages: unknown[], resolvedToolCallIds: Set<string>): RunState {
    return useMemo(
        () => deriveRunState(messages as any, resolvedToolCallIds),
        [messages, resolvedToolCallIds],
    );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web-ui && bunx vitest run components/agent/chat/__tests__/run-state.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(ai-ops): RunState derivation from typed data parts + useRunState hook"
```

---

### Task 2: Decision collection hook (per-tool + submit-when-complete)

**Files:**
- Create: `apps/web-ui/components/agent/chat/use-decisions.ts`
- Test: `apps/web-ui/components/agent/chat/__tests__/use-decisions.test.ts`

**Interfaces:**
- Consumes: `RunState.pendingApproval`, `RunState.pendingClarifications` from Task 1.
- Produces:

```typescript
export interface DecisionMap { [toolCallId: string]: { approved: boolean; reason?: string; answer?: string } }
export function useDecisions(opts: {
    pendingToolCallIds: string[];                       // approval tools + clarification ids
    onComplete: (decisions: Array<{ toolCallId: string; approved: boolean; reason?: string; answer?: string }>) => void;
}): {
    decisions: DecisionMap;
    decide: (toolCallId: string, d: { approved: boolean; reason?: string; answer?: string }) => void;
    decideRemaining: (approved: boolean) => void;
    decidedCount: number;
    resolvedIds: Set<string>;                            // feeds useRunState's resolvedToolCallIds
}
```

`onComplete` fires exactly once, when the last pending id receives a decision. When `pendingToolCallIds` changes identity (new batch), local decisions reset.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web-ui/components/agent/chat/__tests__/use-decisions.test.ts
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDecisions } from '../use-decisions';

describe('useDecisions', () => {
    it('fires onComplete exactly once when the last tool is decided', () => {
        const onComplete = vi.fn();
        const { result } = renderHook(() => useDecisions({ pendingToolCallIds: ['t1', 't2'], onComplete }));
        act(() => result.current.decide('t1', { approved: true }));
        expect(onComplete).not.toHaveBeenCalled();
        act(() => result.current.decide('t2', { approved: false, reason: 'nope' }));
        expect(onComplete).toHaveBeenCalledTimes(1);
        expect(onComplete.mock.calls[0][0]).toEqual([
            { toolCallId: 't1', approved: true, reason: undefined, answer: undefined },
            { toolCallId: 't2', approved: false, reason: 'nope', answer: undefined },
        ]);
    });

    it('decideRemaining decides all undecided ids at once and completes', () => {
        const onComplete = vi.fn();
        const { result } = renderHook(() => useDecisions({ pendingToolCallIds: ['t1', 't2', 't3'], onComplete }));
        act(() => result.current.decide('t2', { approved: false }));
        act(() => result.current.decideRemaining(true));
        expect(onComplete).toHaveBeenCalledTimes(1);
        const batch = onComplete.mock.calls[0][0];
        expect(batch.find((d: any) => d.toolCallId === 't2').approved).toBe(false);
        expect(batch.filter((d: any) => d.approved)).toHaveLength(2);
    });

    it('resets when the pending id set changes (new batch)', () => {
        const onComplete = vi.fn();
        const { result, rerender } = renderHook(
            ({ ids }) => useDecisions({ pendingToolCallIds: ids, onComplete }),
            { initialProps: { ids: ['t1'] } },
        );
        act(() => result.current.decide('t1', { approved: true }));
        rerender({ ids: ['t9'] });
        expect(result.current.decidedCount).toBe(0);
        expect(result.current.resolvedIds.size).toBe(0);
    });
});
```

Note: if `@testing-library/react` is not yet a devDependency, add it: `cd apps/web-ui && bun add -d @testing-library/react`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run components/agent/chat/__tests__/use-decisions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement use-decisions.ts**

```typescript
// apps/web-ui/components/agent/chat/use-decisions.ts
"use client";

import { useEffect, useMemo, useRef, useState } from 'react';

export interface Decision { approved: boolean; reason?: string; answer?: string }
export interface DecisionMap { [toolCallId: string]: Decision }

export function useDecisions(opts: {
    pendingToolCallIds: string[];
    onComplete: (decisions: Array<{ toolCallId: string } & Decision>) => void;
}) {
    const { pendingToolCallIds, onComplete } = opts;
    const [decisions, setDecisions] = useState<DecisionMap>({});
    const firedRef = useRef(false);
    const onCompleteRef = useRef(onComplete);
    onCompleteRef.current = onComplete;

    const batchKey = pendingToolCallIds.join('|');
    // New batch → clear local decisions and re-arm completion.
    useEffect(() => {
        setDecisions({});
        firedRef.current = false;
    }, [batchKey]);

    useEffect(() => {
        if (firedRef.current || pendingToolCallIds.length === 0) return;
        const allDecided = pendingToolCallIds.every(id => decisions[id] !== undefined);
        if (!allDecided) return;
        firedRef.current = true;
        onCompleteRef.current(pendingToolCallIds.map(id => ({ toolCallId: id, ...decisions[id] })));
    }, [decisions, pendingToolCallIds]);

    const decide = (toolCallId: string, d: Decision) =>
        setDecisions(prev => ({ ...prev, [toolCallId]: d }));

    const decideRemaining = (approved: boolean) =>
        setDecisions(prev => {
            const next = { ...prev };
            for (const id of pendingToolCallIds) if (next[id] === undefined) next[id] = { approved };
            return next;
        });

    const decidedCount = pendingToolCallIds.filter(id => decisions[id] !== undefined).length;
    const resolvedIds = useMemo(
        () => (firedRef.current ? new Set(Object.keys(decisions)) : new Set<string>()),
        [decisions],
    );

    return { decisions, decide, decideRemaining, decidedCount, resolvedIds };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web-ui && bunx vitest run components/agent/chat/__tests__/use-decisions.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(ai-ops): useDecisions hook — per-tool decisions, submit only when batch complete"
```

---

### Task 3: Guard risk card + approval batch card

**Files:**
- Create: `apps/web-ui/components/agent/chat/guard-risk-panel.tsx`
- Create: `apps/web-ui/components/agent/chat/approval-batch-card.tsx`
- Test: `apps/web-ui/components/agent/chat/__tests__/approval-batch-card.test.tsx`

**Interfaces:**
- Consumes: `PendingApprovalTool`, `RunGuardVerdict` (Task 1); `useDecisions` return values (Task 2) passed as props.
- Produces:

```typescript
export function GuardRiskPanel({ guard }: { guard: RunGuardVerdict }): JSX.Element
export function ApprovalBatchCard(props: {
    tools: PendingApprovalTool[];
    decisions: DecisionMap;
    onDecide: (toolCallId: string, d: { approved: boolean; reason?: string }) => void;
    onDecideRemaining: (approved: boolean) => void;
}): JSX.Element
```

"Use safer path" = `onDecide(id, { approved: false, reason: \`Use safer path instead: ${guard.saferPath}\` })`.

- [ ] **Step 1: Write the failing render test**

```typescript
// apps/web-ui/components/agent/chat/__tests__/approval-batch-card.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ApprovalBatchCard } from '../approval-batch-card';

const tools = [
    { toolCallId: 't1', toolName: 'get_aws_credentials', args: { accountId: '1' }, guard: null },
    { toolCallId: 't2', toolName: 'execute_command', args: { command: 'aws ec2 terminate-instances --instance-ids i-1' },
      guard: { toolCallId: 't2', toolName: 'execute_command', isMutative: true, severity: 'HIGH' as const, action: 'Terminates i-1', blastRadius: 'Instance destroyed', reversible: false, saferPath: 'Stop instead' } },
];

describe('ApprovalBatchCard', () => {
    it('renders one row per tool with severity badge on guarded rows', () => {
        render(<ApprovalBatchCard tools={tools} decisions={{}} onDecide={vi.fn()} onDecideRemaining={vi.fn()} />);
        expect(screen.getByText(/2 tool calls awaiting/i)).toBeTruthy();
        expect(screen.getByText('HIGH')).toBeTruthy();
        expect(screen.getByText(/Terminates i-1/)).toBeTruthy();
    });

    it('per-row approve calls onDecide with that id only', () => {
        const onDecide = vi.fn();
        render(<ApprovalBatchCard tools={tools} decisions={{}} onDecide={onDecide} onDecideRemaining={vi.fn()} />);
        fireEvent.click(screen.getAllByRole('button', { name: /^Approve$/ })[0]);
        expect(onDecide).toHaveBeenCalledWith('t1', { approved: true });
    });

    it('safer path button rejects with the safer suggestion as reason', () => {
        const onDecide = vi.fn();
        render(<ApprovalBatchCard tools={tools} decisions={{}} onDecide={onDecide} onDecideRemaining={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: /safer path/i }));
        expect(onDecide).toHaveBeenCalledWith('t2', { approved: false, reason: 'Use safer path instead: Stop instead' });
    });

    it('shows decision state instead of buttons for decided rows', () => {
        render(<ApprovalBatchCard tools={tools} decisions={{ t1: { approved: true } }} onDecide={vi.fn()} onDecideRemaining={vi.fn()} />);
        expect(screen.getByText(/approved/i)).toBeTruthy();
    });
});
```

Note: component tests need a DOM — if `vitest.config` lacks it for tsx tests, add `// @vitest-environment jsdom` as the first line of the test file (and `bun add -d jsdom` if missing).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run components/agent/chat/__tests__/approval-batch-card.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement guard-risk-panel.tsx**

```tsx
// apps/web-ui/components/agent/chat/guard-risk-panel.tsx
"use client";

import { cn } from "@/lib/utils";
import { ShieldAlert } from "lucide-react";
import type { RunGuardVerdict } from "./run-state";

const SEVERITY_STYLES: Record<RunGuardVerdict["severity"], string> = {
  HIGH: "bg-red-500/10 text-red-600 border-red-500/30",
  MEDIUM: "bg-amber-500/10 text-amber-600 border-amber-500/30",
  LOW: "bg-muted text-muted-foreground border-border",
};

export function GuardRiskPanel({ guard }: { guard: RunGuardVerdict }) {
  return (
    <div className="mt-2 rounded-md border border-red-500/20 bg-red-500/5 p-2.5 text-xs space-y-1.5">
      <div className="flex items-center gap-2 font-semibold text-red-700 dark:text-red-400">
        <ShieldAlert className="h-3.5 w-3.5" />
        Guard: destructive action detected
        <span className={cn("ml-auto rounded border px-1.5 py-0.5 text-[10px] font-bold", SEVERITY_STYLES[guard.severity])}>
          {guard.severity}
        </span>
      </div>
      <dl className="grid grid-cols-[90px_1fr] gap-x-3 gap-y-1 text-muted-foreground">
        <dt className="font-medium uppercase text-[10px] tracking-wide">Action</dt>
        <dd className="text-foreground">{guard.action}</dd>
        <dt className="font-medium uppercase text-[10px] tracking-wide">Blast radius</dt>
        <dd>{guard.blastRadius}</dd>
        <dt className="font-medium uppercase text-[10px] tracking-wide">Reversible</dt>
        <dd>{guard.reversible ? "Yes" : "No — treat as permanent"}</dd>
        {guard.saferPath && (
          <>
            <dt className="font-medium uppercase text-[10px] tracking-wide">Safer path</dt>
            <dd>{guard.saferPath}</dd>
          </>
        )}
      </dl>
    </div>
  );
}
```

- [ ] **Step 4: Implement approval-batch-card.tsx**

```tsx
// apps/web-ui/components/agent/chat/approval-batch-card.tsx
"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AlertTriangle, Check, ShieldCheck, X } from "lucide-react";
import type { PendingApprovalTool } from "./run-state";
import type { DecisionMap } from "./use-decisions";
import { GuardRiskPanel } from "./guard-risk-panel";

function ArgsPreview({ args }: { args: Record<string, unknown> }) {
  const text = JSON.stringify(args, null, 2);
  return (
    <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted/50 p-2 font-mono text-[11px] leading-snug">
      {text.length > 2000 ? text.slice(0, 2000) + "\n… (truncated)" : text}
    </pre>
  );
}

export function ApprovalBatchCard({
  tools,
  decisions,
  onDecide,
  onDecideRemaining,
}: {
  tools: PendingApprovalTool[];
  decisions: DecisionMap;
  onDecide: (toolCallId: string, d: { approved: boolean; reason?: string }) => void;
  onDecideRemaining: (approved: boolean) => void;
}) {
  const undecided = tools.filter((t) => decisions[t.toolCallId] === undefined);
  return (
    <div data-testid="approval-batch-card" className="my-2 overflow-hidden rounded-lg border border-amber-500/30 bg-background shadow-sm">
      <div className="flex items-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm font-semibold text-amber-700 dark:text-amber-400">
        <AlertTriangle className="h-4 w-4" />
        {tools.length} tool call{tools.length === 1 ? "" : "s"} awaiting your approval
      </div>

      <div className="divide-y">
        {tools.map((tool) => {
          const decision = decisions[tool.toolCallId];
          const mutative = !!tool.guard?.isMutative;
          return (
            <div key={tool.toolCallId} className="px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs font-semibold">▸ {tool.toolName}</span>
                {!mutative && (
                  <span className="flex items-center gap-1 text-[10px] text-emerald-600">
                    <ShieldCheck className="h-3 w-3" /> read-only
                  </span>
                )}
                <span className="ml-auto text-[11px]">
                  {decision === undefined ? (
                    <span className="text-amber-600">● awaiting</span>
                  ) : decision.approved ? (
                    <span className="text-emerald-600">✓ approved</span>
                  ) : (
                    <span className="text-red-600">✕ rejected</span>
                  )}
                </span>
              </div>
              <ArgsPreview args={tool.args} />
              {mutative && tool.guard && <GuardRiskPanel guard={tool.guard} />}
              {decision === undefined && (
                <div className="mt-2 flex gap-2">
                  <Button size="sm" className="h-7" onClick={() => onDecide(tool.toolCallId, { approved: true })}>
                    <Check className="mr-1 h-3 w-3" /> Approve
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 border-red-500/40 text-red-600 hover:bg-red-500/10"
                    onClick={() => onDecide(tool.toolCallId, { approved: false })}>
                    <X className="mr-1 h-3 w-3" /> Reject
                  </Button>
                  {tool.guard?.saferPath && (
                    <Button size="sm" variant="ghost" className="h-7"
                      onClick={() => onDecide(tool.toolCallId, { approved: false, reason: `Use safer path instead: ${tool.guard!.saferPath}` })}>
                      Use safer path
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className={cn("flex items-center justify-between gap-2 border-t bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground")}>
        <span>Run continues when all are decided — approved calls run, rejected return “denied by user” to the agent.</span>
        {undecided.length > 0 && (
          <span className="flex shrink-0 gap-2">
            <Button size="sm" variant="outline" className="h-6 text-[11px]" onClick={() => onDecideRemaining(true)}>
              ✓ Approve remaining
            </Button>
            <Button size="sm" variant="outline" className="h-6 text-[11px]" onClick={() => onDecideRemaining(false)}>
              ✕ Reject remaining
            </Button>
          </span>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/web-ui && bunx vitest run components/agent/chat/__tests__/approval-batch-card.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(ai-ops): approval batch card with per-tool decisions + guard risk panel"
```

---

### Task 4: Clarification card

**Files:**
- Create: `apps/web-ui/components/agent/chat/clarification-card.tsx`
- Test: `apps/web-ui/components/agent/chat/__tests__/clarification-card.test.tsx`

**Interfaces:**
- Produces: `ClarificationCard({ clarification, onAnswer }: { clarification: PendingClarification; onAnswer: (toolCallId: string, answer: string) => void })`. `onAnswer` maps to `decide(toolCallId, { approved: true, answer })` at the call site.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web-ui/components/agent/chat/__tests__/clarification-card.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ClarificationCard } from '../clarification-card';

const clar = { toolCallId: 't3', question: 'Which instance should I start?', options: ['i-0abc · web', 'All of them'] };

describe('ClarificationCard', () => {
    it('renders question and option chips', () => {
        render(<ClarificationCard clarification={clar} onAnswer={vi.fn()} />);
        expect(screen.getByText(/Which instance/)).toBeTruthy();
        expect(screen.getByRole('button', { name: 'i-0abc · web' })).toBeTruthy();
    });

    it('chip click answers with the chip text', () => {
        const onAnswer = vi.fn();
        render(<ClarificationCard clarification={clar} onAnswer={onAnswer} />);
        fireEvent.click(screen.getByRole('button', { name: 'All of them' }));
        expect(onAnswer).toHaveBeenCalledWith('t3', 'All of them');
    });

    it('free-text submit answers with trimmed text; empty blocked', () => {
        const onAnswer = vi.fn();
        render(<ClarificationCard clarification={clar} onAnswer={onAnswer} />);
        const input = screen.getByPlaceholderText(/type a custom answer/i);
        fireEvent.change(input, { target: { value: '   ' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(onAnswer).not.toHaveBeenCalled();
        fireEvent.change(input, { target: { value: '  i-0def  ' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(onAnswer).toHaveBeenCalledWith('t3', 'i-0def');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run components/agent/chat/__tests__/clarification-card.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement clarification-card.tsx**

```tsx
// apps/web-ui/components/agent/chat/clarification-card.tsx
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { HelpCircle, Send } from "lucide-react";
import type { PendingClarification } from "./run-state";

export function ClarificationCard({
  clarification,
  onAnswer,
}: {
  clarification: PendingClarification;
  onAnswer: (toolCallId: string, answer: string) => void;
}) {
  const [text, setText] = useState("");

  const submit = (answer: string) => {
    const trimmed = answer.trim();
    if (!trimmed) return;
    onAnswer(clarification.toolCallId, trimmed);
  };

  return (
    <div data-testid="clarification-card" className="my-2 overflow-hidden rounded-lg border border-blue-500/30 bg-background shadow-sm">
      <div className="flex items-center gap-2 border-b border-blue-500/20 bg-blue-500/10 px-3 py-2 text-sm font-semibold text-blue-700 dark:text-blue-400">
        <HelpCircle className="h-4 w-4" />
        The agent needs input to continue
      </div>
      <div className="space-y-2.5 px-3 py-2.5 text-sm">
        <p>{clarification.question}</p>
        {clarification.options.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {clarification.options.map((opt) => (
              <Button key={opt} size="sm" variant="outline"
                className="h-7 rounded-full border-blue-500/40 text-xs text-blue-700 hover:bg-blue-500/10 dark:text-blue-400"
                onClick={() => submit(opt)}>
                {opt}
              </Button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <Textarea
            rows={1}
            value={text}
            placeholder="Or type a custom answer… (Enter to send — the run resumes immediately)"
            className="min-h-[36px] resize-none text-xs"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit(text);
              }
            }}
          />
          <Button size="sm" className="h-8 shrink-0" disabled={!text.trim()} onClick={() => submit(text)}>
            <Send className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests + commit**

Run: `cd apps/web-ui && bunx vitest run components/agent/chat/__tests__/clarification-card.test.tsx`
Expected: PASS (3 tests).

```bash
git add -A
git commit -m "feat(ai-ops): clarification card — option chips + free-text answer"
```

---

### Task 5: Run rail (live plan + activity + context)

**Files:**
- Create: `apps/web-ui/components/agent/chat/run-rail.tsx`

**Interfaces:**
- Consumes: `RunState` (Task 1); existing `Plan`/`PlanHeader`/`PlanContent`/`PlanStep` from `@/components/ai-elements/plan` — `PlanStep` already supports `status: 'pending' | 'active' | 'completed' | 'failed'`.
- Produces:

```typescript
export function RunRail(props: {
    runState: RunState;
    isStreaming: boolean;
    context: { accountNames: string[]; modelLabel: string; skillName: string | null; toolCount: number | null; kbLabel: string };
}): JSX.Element
```

Plan status mapping: `in_progress` → `active`, others pass through.

- [ ] **Step 1: Implement run-rail.tsx**

```tsx
// apps/web-ui/components/agent/chat/run-rail.tsx
"use client";

import { cn } from "@/lib/utils";
import { Activity, AlertTriangle, Cloud, Cpu, HelpCircle, ListChecks, ShieldCheck, Sparkles } from "lucide-react";
import { Plan, PlanContent, PlanHeader, PlanStep } from "@/components/ai-elements/plan";
import type { RunState } from "./run-state";

const PHASE_LABELS: Record<string, string> = {
  planning: "Planning", execution: "Executing", reflection: "Reflecting",
  revision: "Revising", final: "Finalizing", memory_recall: "Recalling memory",
  memory_save: "Saving memory", text: "Idle",
};

function RailSection({ icon: Icon, title, children }: { icon: React.ElementType; title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3 w-3" /> {title}
      </div>
      {children}
    </div>
  );
}

export function RunRail({
  runState,
  isStreaming,
  context,
}: {
  runState: RunState;
  isStreaming: boolean;
  context: { accountNames: string[]; modelLabel: string; skillName: string | null; toolCount: number | null; kbLabel: string };
}) {
  const { plan, currentPhase, pendingApproval, pendingClarifications } = runState;
  const done = plan.filter((s) => s.status === "completed").length;
  const mutativePending = pendingApproval?.tools.some((t) => t.guard?.isMutative) ?? false;

  return (
    <aside data-testid="run-rail" className="flex h-full w-full flex-col gap-4 overflow-y-auto border-l bg-muted/20 p-3">
      {/* Phase */}
      <RailSection icon={Activity} title="Status">
        <div className="flex items-center gap-2 text-sm">
          <span className={cn("h-2 w-2 rounded-full", isStreaming ? "animate-pulse bg-blue-500" : "bg-muted-foreground/40")} />
          {PHASE_LABELS[currentPhase] ?? currentPhase}
        </div>
      </RailSection>

      {/* Live plan */}
      {plan.length > 0 && (
        <RailSection icon={ListChecks} title={`Execution plan · ${done}/${plan.length}`}>
          <Plan defaultOpen isStreaming={isStreaming}>
            <PlanHeader title="Plan" />
            <PlanContent>
              {plan.map((step, i) => (
                <PlanStep key={i} number={i + 1}
                  status={step.status === "in_progress" ? "active" : step.status}>
                  {step.step}
                </PlanStep>
              ))}
            </PlanContent>
          </Plan>
        </RailSection>
      )}

      {/* Activity */}
      <RailSection icon={Sparkles} title="Activity">
        <ul className="space-y-1 text-xs text-muted-foreground">
          {pendingApproval && (
            <li className="flex items-center gap-1.5 text-amber-600">
              <AlertTriangle className="h-3 w-3" />
              {pendingApproval.tools.length} approval{pendingApproval.tools.length === 1 ? "" : "s"} pending
            </li>
          )}
          {pendingClarifications.length > 0 && (
            <li className="flex items-center gap-1.5 text-blue-600">
              <HelpCircle className="h-3 w-3" /> question awaiting your answer
            </li>
          )}
          <li className="flex items-center gap-1.5">
            <ShieldCheck className={cn("h-3 w-3", mutativePending ? "text-red-500" : "text-emerald-600")} />
            {mutativePending ? "guard: destructive action held" : "guard: active"}
          </li>
        </ul>
      </RailSection>

      {/* Context */}
      <RailSection icon={Cloud} title="Context">
        <ul className="space-y-1 text-xs text-muted-foreground">
          <li className="truncate">{context.accountNames.length > 0 ? context.accountNames.join(", ") : "No account selected"}</li>
          <li className="flex items-center gap-1.5 truncate"><Cpu className="h-3 w-3 shrink-0" />{context.modelLabel || "Default model"}</li>
          {context.skillName && <li className="truncate">Skill: {context.skillName}</li>}
          <li className="truncate">{context.kbLabel}{context.toolCount != null ? ` · ${context.toolCount} tools` : ""}</li>
        </ul>
      </RailSection>
    </aside>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web-ui && bunx tsc --noEmit 2>&1 | grep "run-rail"`
Expected: no errors. (Check `PlanStep`'s accepted `status` union in `components/ai-elements/plan.tsx:139-186`; if `'failed'` isn't in its prop union, extend the union in plan.tsx — additive prop change is allowed by the constraints.)

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(ai-ops): run rail — live plan check-off, activity, run context"
```

---

### Task 6: Threaded run timeline

Nodes on a vertical spine for phase transitions and tool calls, matching the approved mockup. Renders per assistant message, replacing the flat block list for structured threads.

**Files:**
- Create: `apps/web-ui/components/agent/chat/run-timeline.tsx`

**Interfaces:**
- Consumes: message `parts` (text / reasoning / tool-* / data-*), the existing `renderToolInvocation` + `renderPhaseBlock` render props from `chat-interface.tsx` (passed in — the timeline is a LAYOUT around existing part renderers, not a re-implementation).
- Produces:

```typescript
export function RunTimeline(props: {
    parts: Array<{ type: string; [k: string]: unknown }>;
    messageId: string;
    isActivelyStreaming: boolean;
    renderPhaseBlock: (phase: string, content: string, key: string, isActive?: boolean) => React.ReactNode;
    renderToolInvocation: (part: unknown, messageId: string, index: number) => React.ReactNode;
    parsePhase: (content: string) => { phase: string; cleanContent: string };
}): JSX.Element
```

- [ ] **Step 1: Implement run-timeline.tsx**

```tsx
// apps/web-ui/components/agent/chat/run-timeline.tsx
"use client";

import React from "react";
import { cn } from "@/lib/utils";

const PHASE_DOT: Record<string, string> = {
  planning: "bg-violet-500", execution: "bg-amber-500", reflection: "bg-sky-500",
  revision: "bg-cyan-500", final: "bg-emerald-500", memory_recall: "bg-emerald-400",
  memory_save: "bg-emerald-400", text: "bg-muted-foreground/50",
};

function TimelineNode({ color, active, children }: { color: string; active?: boolean; children: React.ReactNode }) {
  return (
    <div className="relative pl-5">
      <span
        className={cn(
          "absolute left-[-5px] top-2 h-2.5 w-2.5 rounded-full ring-2 ring-background",
          color,
          active && "animate-pulse ring-4 ring-blue-500/20",
        )}
      />
      {children}
    </div>
  );
}

/**
 * Threaded timeline for one assistant message: each reasoning phase and each
 * tool call is a node on a vertical spine. data-* parts are NOT rendered here —
 * plan lives in the rail; approval/clarification cards render after the
 * timeline (see chat-interface integration).
 */
export function RunTimeline({
  parts,
  messageId,
  isActivelyStreaming,
  renderPhaseBlock,
  renderToolInvocation,
  parsePhase,
}: {
  parts: Array<{ type: string; [k: string]: any }>;
  messageId: string;
  isActivelyStreaming: boolean;
  renderPhaseBlock: (phase: string, content: string, key: string, isActive?: boolean) => React.ReactNode;
  renderToolInvocation: (part: unknown, messageId: string, index: number) => React.ReactNode;
  parsePhase: (content: string) => { phase: string; cleanContent: string };
}) {
  const lastReasoningIdx = parts.map((p) => p.type).lastIndexOf("reasoning");

  return (
    <div className="ml-1.5 space-y-2 border-l-2 border-border/70 py-1">
      {parts.map((part, index) => {
        const key = `${messageId}-tl-${index}`;
        if (part.type === "reasoning") {
          const { phase, cleanContent } = parsePhase(part.text || "");
          const isActive = isActivelyStreaming && index === lastReasoningIdx;
          const rendered = renderPhaseBlock(phase, cleanContent, key, isActive);
          if (!rendered) return null;
          return (
            <TimelineNode key={key} color={PHASE_DOT[phase] ?? PHASE_DOT.text} active={isActive}>
              {rendered}
            </TimelineNode>
          );
        }
        if (part.type?.startsWith?.("tool-") || part.toolCallId) {
          return (
            <TimelineNode key={key} color="bg-foreground/60" active={isActivelyStreaming && index === parts.length - 1}>
              {renderToolInvocation(part, messageId, index)}
            </TimelineNode>
          );
        }
        return null; // text parts render OUTSIDE the timeline (answer-level), data-* parts elsewhere
      })}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `cd apps/web-ui && bunx tsc --noEmit 2>&1 | grep run-timeline`
Expected: no errors.

```bash
git add -A
git commit -m "feat(ai-ops): threaded run timeline — phase/tool nodes on a status spine"
```

---

### Task 7: Mission Control integration in chat-interface.tsx

Wire everything together: two-pane layout, timeline rendering for assistant messages, decision cards bound to `useDecisions` → `decisions` resume POST, relabeled auto-approve toggle, pending-interrupt restore from history.

**Files:**
- Modify: `apps/web-ui/components/agent/chat-interface.tsx`

**Interfaces:**
- Consumes: everything from Tasks 1-6; Plan A's `decisions` body contract; history response fields `plan` + `pendingInterrupt` (Plan A Task 9).

- [ ] **Step 1: Add imports and run-state wiring**

In `chat-interface.tsx`, add imports:

```tsx
import { useRunState } from "@/components/agent/chat/use-run-state";
import { useDecisions } from "@/components/agent/chat/use-decisions";
import { ApprovalBatchCard } from "@/components/agent/chat/approval-batch-card";
import { ClarificationCard } from "@/components/agent/chat/clarification-card";
import { RunRail } from "@/components/agent/chat/run-rail";
import { RunTimeline } from "@/components/agent/chat/run-timeline";
```

After the `useChat` call (line ~735), add:

```tsx
  // ── Mission Control run state ──────────────────────────────────────────────
  // Restored pending-interrupt parts from a reload are appended as a synthetic
  // assistant message so deriveRunState sees them like live stream parts.
  const [restoredParts, setRestoredParts] = useState<any[]>([]);
  const runMessages = useMemo(
    () => (restoredParts.length > 0
      ? [...messages, { role: "assistant", parts: restoredParts, id: "restored-interrupt" }]
      : messages),
    [messages, restoredParts],
  );

  const submitDecisions = useCallback(async (decisionBatch: Array<{ toolCallId: string; approved: boolean; reason?: string; answer?: string }>) => {
    setRestoredParts([]); // decided — the synthetic restore card must not linger
    await sendMessage(
      { role: "user", content: "" } as any, // carrier message; server acts on body.decisions
      {
        body: {
          threadId, autoApprove, model: selectedModel, mode: agentMode,
          decisions: decisionBatch,
          accounts: selectedAccounts.length > 0 ? selectedAccounts.map((a) => ({ accountId: a.accountId, accountName: a.name })) : undefined,
          selectedSkill: selectedSkill || undefined,
          mcpServerIds: selectedMcpServerIds.length > 0 ? selectedMcpServerIds : undefined,
          knowledgeBaseIds: selectedKbIds.length > 0 ? selectedKbIds : undefined,
        },
      },
    );
  }, [sendMessage, threadId, autoApprove, selectedModel, agentMode, selectedAccounts, selectedSkill, selectedMcpServerIds, selectedKbIds]);

  // Pending ids = approval tools + clarifications; derive in two passes so
  // useDecisions' resolved ids feed back into the displayed pending state.
  const runStateRaw = useRunState(runMessages, useMemo(() => new Set<string>(), []));
  const pendingIds = useMemo(
    () => [
      ...(runStateRaw.pendingApproval?.tools.map((t) => t.toolCallId) ?? []),
      ...runStateRaw.pendingClarifications.map((c) => c.toolCallId),
    ],
    [runStateRaw.pendingApproval, runStateRaw.pendingClarifications],
  );
  const { decisions, decide, decideRemaining, resolvedIds } = useDecisions({
    pendingToolCallIds: pendingIds,
    onComplete: submitDecisions,
  });
  const runState = useRunState(runMessages, resolvedIds);
```

Note on the carrier message: verify the server ignores an empty user message when `decisions` is present — Plan A Task 7 branches on `decisions` BEFORE reading `lastMessage`, so it does. If v7's `sendMessage` rejects an empty content message, use `content: "(decisions submitted)"` and hide it client-side by filtering messages with `role === 'user' && parts?.length === 0` — decide empirically at this step.

- [ ] **Step 2: Restore parked interrupts on history load**

In the `fetchHistory` success branch (after `setMessages(data.messages)`), add:

```tsx
          if (data.pendingInterrupt?.parts?.length) {
            console.log("[ChatInterface] Restoring parked interrupt:", data.pendingInterrupt.parts.length, "part(s)");
            setRestoredParts(data.pendingInterrupt.parts);
          }
          // Reloaded threads carry the final plan even without live data-plan parts.
          if (data.plan?.length && !data.pendingInterrupt) {
            setRestoredParts([{ type: "data-plan", data: { steps: data.plan, updatedBy: "history" } }]);
          }
```

- [ ] **Step 3: Two-pane layout + decision cards in the message area**

Replace the root layout (line ~1390 `<div className="relative flex flex-col h-full w-full …">`) with a two-pane structure — conversation column plus rail:

```tsx
    <div className="relative flex h-full w-full overflow-hidden rounded-xl border bg-background shadow-lg">
      {/* Left: conversation column (existing header + messages + composer move inside) */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* …existing header / ScrollArea / composer JSX unchanged inside this div… */}
      </div>

      {/* Right: run rail — hidden below lg */}
      <div className="hidden w-72 shrink-0 lg:block xl:w-80">
        <RunRail
          runState={runState}
          isStreaming={isLoading}
          context={{
            accountNames: selectedAccounts.map((a) => a.name),
            modelLabel: availableModels.find((m) => m.id === selectedModel)?.label ?? selectedModel,
            skillName: availableSkills.find((s) => s.id === selectedSkill)?.name ?? null,
            toolCount: null,
            kbLabel: selectedKbIds.length > 0 ? `Knowledge: ${selectedKbIds.length} selected` : "Knowledge: All (auto)",
          }}
        />
      </div>
    </div>
```

Inside the header (small screens), add a compact status strip so mobile keeps phase/plan/approval visibility:

```tsx
          <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground lg:hidden">
            {runState.plan.length > 0 && (
              <span>plan {runState.plan.filter((s) => s.status === "completed").length}/{runState.plan.length}</span>
            )}
            {runState.pendingApproval && <span className="text-amber-600">⚠ {runState.pendingApproval.tools.length}</span>}
          </div>
```

At the END of the messages list (inside the ScrollArea, after the `messages.map(...)` block), render the pending cards:

```tsx
          {runState.pendingClarifications.map((c) => (
            <ClarificationCard key={c.toolCallId} clarification={c}
              onAnswer={(id, answer) => decide(id, { approved: true, answer })} />
          ))}
          {runState.pendingApproval && (
            <ApprovalBatchCard
              tools={runState.pendingApproval.tools}
              decisions={decisions}
              onDecide={decide}
              onDecideRemaining={decideRemaining}
            />
          )}
```

- [ ] **Step 4: Route assistant messages through the timeline**

In `MessageRow` (or at its call site — keep `MessageRow` the owner), for assistant messages with structured parts render the timeline layout: text parts render full-width as the answer; reasoning/tool parts render inside `RunTimeline`. Modify `MessageRow`'s parts rendering:

```tsx
  const workParts = parts.filter((p: any) => p.type === "reasoning" || p.type?.startsWith?.("tool-") || (p.toolCallId && p.type !== "text"));
  const textParts = parts.filter((p: any) => p.type === "text");

  // Assistant messages: work in the timeline, answer as full-width prose below.
  {!isUser && workParts.length > 0 && (
    <RunTimeline
      parts={workParts}
      messageId={message.id}
      isActivelyStreaming={!!isLastMessage && !!isActivelyStreaming}
      renderPhaseBlock={renderPhaseBlock}
      renderToolInvocation={renderToolInvocation}
      parsePhase={parsePhaseFromContent}
    />
  )}
  {textParts.map((part: any, index: number) => (
    /* existing text-part rendering (markdown / streaming pre) keyed as before */
  ))}
```

Keep the existing flat loop as the fallback when `workParts.length === 0` (pure-text messages) and for user messages. Legacy history threads flow through the same path — their reasoning parts carry phase markers, which `parsePhaseFromContent` handles, so old threads get the timeline too (acceptable and desirable).

- [ ] **Step 5: Hide legacy per-tool Confirmation when a batch card owns the decision**

In `renderToolInvocation`, suppress the inline `Confirmation` block when the toolCallId belongs to the current `runState.pendingApproval` batch or `pendingClarifications` (the new cards own those decisions):

```tsx
    const ownedByBatch =
      runState.pendingApproval?.tools.some((t) => t.toolCallId === part.toolCallId) ||
      runState.pendingClarifications.some((c) => c.toolCallId === part.toolCallId);
    const isPending = !ownedByBatch && !autoApprove && isCall && !result && !isLoading;
```

(add `runState` to the callback's dependency array).

- [ ] **Step 6: Relabel the auto-approve toggle**

Find the composer checkbox label for auto-approve (search for `Auto-approve tools` in the JSX below line 1460) and change the label text to `Auto-approve read-only tools`, with `title="Read-only tools run without asking. Destructive actions always pause for approval."`

- [ ] **Step 7: Manual verification of the full experience**

With backend + this task on `bun run dev`:

| Check | Expected |
|---|---|
| Plan & Execute run | Rail shows plan; steps check off live as generate/reflect advance them |
| Mutative prompt, auto-approve ON | Amber batch card with red guard panel (severity, blast radius, safer path); deciding all resumes the run; only approved tools execute |
| Batch of 2+: approve one, reject one | Approved executes, rejected returns "Rejected by user" to the agent (visible in following agent text) |
| ask_user flow | Blue card with chips; answering resumes; answer visible as the tool's result |
| Reload mid-approval | Card restored from `pendingInterrupt` |
| Old thread from before the overhaul | Renders via legacy parsing, no crashes, no rail plan |
| Window < lg | Rail hidden; header strip shows plan progress + approval badge |

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(ai-ops): Mission Control chat — two-pane layout, threaded timeline, batch decision cards"
```

---

### Task 8: E2E tests

**Files:**
- Create: `apps/web-ui-e2e/agent-mission-control.spec.ts`

**Interfaces:**
- Consumes: `data-testid`s introduced above: `run-rail`, `approval-batch-card`, `clarification-card`, plus existing `chat-messages-container`, `user-message`, `ai-message`.

- [ ] **Step 1: Write the spec**

```typescript
// apps/web-ui-e2e/agent-mission-control.spec.ts
import { test, expect } from '@playwright/test';

// These tests require a live agent backend (model provider configured).
// They assert UI structure and interrupt flow, not model output content.

test.describe('AI Ops Mission Control', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/app/agent');
        await page.waitForLoadState('networkidle');
    });

    test('layout renders composer and (on lg viewports) the run rail region', async ({ page }) => {
        await expect(page.getByPlaceholder(/ask the agent/i)).toBeVisible();
        await expect(page.getByText('Auto-approve read-only tools')).toBeVisible();
        // Rail is empty-state on a fresh thread but the region exists on lg
        await page.setViewportSize({ width: 1440, height: 900 });
        await expect(page.getByTestId('run-rail')).toBeVisible();
    });

    test('run rail hides below lg and header strip appears instead', async ({ page }) => {
        await page.setViewportSize({ width: 900, height: 800 });
        await expect(page.getByTestId('run-rail')).toBeHidden();
    });

    test('mutative request pauses at the approval card despite auto-approve on', async ({ page }) => {
        await page.getByPlaceholder(/ask the agent/i).fill(
            'Execute exactly this command with execute_command and nothing else: aws ec2 stop-instances --instance-ids i-00000000000000000 --region us-east-1');
        await page.keyboard.press('Enter');
        const card = page.getByTestId('approval-batch-card');
        await expect(card).toBeVisible({ timeout: 120_000 });
        await expect(card.getByText(/awaiting your approval/i)).toBeVisible();
        // Reject so the E2E run never mutates anything.
        await card.getByRole('button', { name: /reject remaining|^Reject$/i }).first().click();
        // Run resumes: the agent produces further output after the rejection.
        await expect(page.getByTestId('ai-message').last()).toContainText(/reject|denied|not|cannot/i, { timeout: 120_000 });
    });

    test('plan mode shows a live plan in the rail', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        // Switch to Plan & Execute mode
        await page.getByText('Fast (ReAct)').click();
        await page.getByText('Plan & Execute').click();
        await page.getByPlaceholder(/ask the agent/i).fill('List the files in your working directory and summarize them');
        await page.keyboard.press('Enter');
        await expect(page.getByTestId('run-rail').getByText(/execution plan/i)).toBeVisible({ timeout: 120_000 });
    });
});
```

- [ ] **Step 2: Run the spec**

Run: `cd apps/web-ui-e2e && bunx playwright test agent-mission-control.spec.ts --headed`
Expected: 4 passing (requires configured provider + at least the auth `storageState` setup from the existing suite; reuse `auth.setup.ts`).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test(ai-ops): Mission Control E2E — layout, guard pause, live plan"
```

---

### Task 9: Final verification + cleanup

**Files:**
- Modify (cleanup only): `apps/web-ui/components/agent/chat-interface.tsx`

- [ ] **Step 1: Full unit suite + build**

Run: `cd apps/web-ui && bun run test 2>&1 | tail -5 && cd ../.. && bun run build:web`
Expected: no new failures vs baseline; build succeeds.

- [ ] **Step 2: Dead-code sweep in chat-interface.tsx**

Remove now-unreachable code paths: the old plan-parsing cache (`planStepCacheRef` + the JSON/line parsing inside `renderPhaseBlock`'s `planning` branch) is still needed ONLY for legacy threads — keep it but add a comment `// LEGACY: pre-data-part threads only`. Delete `handleToolApproval`'s now-dead branches ONLY IF the legacy inline Confirmation was fully removed; if legacy threads can still surface it (they can — old parked threads), keep it and mark it `// LEGACY resume contract`.

- [ ] **Step 3: Lint**

Run: `cd apps/web-ui && bun run lint 2>&1 | tail -5`
Expected: no new errors.

- [ ] **Step 4: Update CLAUDE.md component map**

In the root `CLAUDE.md` "Component Patterns" section, extend the agent domain line to mention `agent/chat/` (Mission Control components). One-line change.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore(ai-ops): Mission Control cleanup — legacy paths annotated, docs updated"
```

---

## Self-Review Notes

- Spec coverage: two-pane Mission Control (T7), threaded timeline (T6), live plan rail (T5), per-tool + approve-all batch card (T2/T3), clarification card (T4), guard risk card (T3), useRunState single source (T1), pending-interrupt reload restore (T7 Step 2), auto-approve relabel (T7 Step 6), legacy fallback (T7 Step 4), E2E (T8).
- Composer extraction into a separate `composer.tsx` file was dropped from this plan (YAGNI): the composer JSX stays inside chat-interface.tsx, which already shrinks via the extracted timeline/rail/cards. Revisit only if the file stays unwieldy after T9.
- Type consistency: `RunState`/`PendingApprovalTool`/`DecisionMap` names match across T1→T7; decision body field is `decisions` everywhere, matching Plan A Task 7.
- Both empirically-uncertain integration points (empty carrier message in T7 Step 1; PlanStep `failed` status prop in T5 Step 2) carry explicit in-step verification instructions rather than silent assumptions.
