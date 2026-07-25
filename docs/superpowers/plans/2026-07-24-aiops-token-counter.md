# AI Ops Chat Token Counter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a cumulative incoming/outgoing token counter in the AI Ops chat header that updates live and survives reload/history, by routing the `usage_metadata` already produced by every model call through the existing `data-*` part pipeline.

**Architecture:** The counter = sum of all `data-usage` parts. The server accumulates a request-scoped run total across every `on_chat_model_end`, streams a `data-usage` part per call (live), and persists the run total onto the turn's final AI message. The history route reconstructs one `data-usage` part per turn from that stored total. The client sums `data-usage` parts in `deriveRunState` and the header renders `runState.tokenUsage`.

**Tech Stack:** TypeScript, Next.js App Router, LangGraph `streamEvents`, AI SDK UIMessage stream, React, Vitest.

## Global Constraints

- **Do NOT commit.** The user will test the changes, then commit. Every task ends WITHOUT a commit; leave all changes in the working tree. Do NOT touch `.env.example`.
- Indentation: `app/api/chat/*` and `lib/agent-chat/*` use 4-space; `.tsx` components use 2-space. Match the file you edit.
- Comments: default none; a single concise WHY line only where non-obvious. No multi-line comment blocks.
- The counter number is the **cumulative billed total** (Σ input_tokens, Σ output_tokens across every counted model call).
- Persisted usage lives in `chat_messages` `metadata.usage_metadata = { input_tokens, output_tokens }` on the turn's LAST AI message (one record per turn).
- `data-usage` part shape is exactly `{ type: 'data-usage', data: { input: number, output: number } }`.
- Scope: streaming chat path only. Guard-node model calls are already skipped upstream and stay uncounted. Non-streaming fallback path, direct-chat greetings, pre-graph triage calls, and the separate `/api/deep-agent` route are OUT of scope.
- Tests run from `apps/web-ui`: full suite `bun run test`; one file `bunx vitest run <path>`.

---

### Task 1: `token-usage.ts` pure helpers (parse + format)

**Files:**
- Create: `apps/web-ui/lib/agent-chat/token-usage.ts`
- Test: `apps/web-ui/lib/agent-chat/__tests__/token-usage.test.ts`

**Interfaces:**
- Produces: `export interface TokenUsage { input: number; output: number }`;
  `export function parseUsageMetadata(meta: unknown): TokenUsage | null`;
  `export function formatTokens(n: number): string`. Consumed by Task 4 (history route + header).

- [ ] **Step 1: Write the failing test**

Create `apps/web-ui/lib/agent-chat/__tests__/token-usage.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseUsageMetadata, formatTokens } from '../token-usage';

describe('parseUsageMetadata', () => {
    it('reads the LangChain input_tokens/output_tokens shape', () => {
        expect(parseUsageMetadata({ input_tokens: 3, output_tokens: 4 })).toEqual({ input: 3, output: 4 });
    });
    it('reads the {input,output} data-part shape', () => {
        expect(parseUsageMetadata({ input: 5, output: 6 })).toEqual({ input: 5, output: 6 });
    });
    it('returns null when both are zero/absent, or meta is not an object', () => {
        expect(parseUsageMetadata({ input_tokens: 0, output_tokens: 0 })).toBeNull();
        expect(parseUsageMetadata({})).toBeNull();
        expect(parseUsageMetadata(null)).toBeNull();
        expect(parseUsageMetadata('x')).toBeNull();
    });
    it('keeps a positive side even if the other is missing', () => {
        expect(parseUsageMetadata({ output_tokens: 9 })).toEqual({ input: 0, output: 9 });
    });
});

describe('formatTokens', () => {
    it('formats by magnitude', () => {
        expect(formatTokens(0)).toBe('0');
        expect(formatTokens(999)).toBe('999');
        expect(formatTokens(1000)).toBe('1.0k');
        expect(formatTokens(48200)).toBe('48.2k');
        expect(formatTokens(1_500_000)).toBe('1.5m');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/agent-chat/__tests__/token-usage.test.ts`
Expected: FAIL — `../token-usage` cannot be imported.

- [ ] **Step 3: Create the module**

Create `apps/web-ui/lib/agent-chat/token-usage.ts`:

```ts
// Pure helpers for the chat token counter: parse persisted usage metadata and format counts.
export interface TokenUsage { input: number; output: number }

// Accepts the LangChain shape (input_tokens/output_tokens) or the data-usage shape (input/output).
export function parseUsageMetadata(meta: unknown): TokenUsage | null {
    if (!meta || typeof meta !== 'object') return null;
    const m = meta as Record<string, unknown>;
    const input = Number(m.input_tokens ?? m.input) || 0;
    const output = Number(m.output_tokens ?? m.output) || 0;
    if (!input && !output) return null;
    return { input, output };
}

// <1000 -> integer; >=1000 -> one-decimal "k"; >=1e6 -> "m".
export function formatTokens(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return '0';
    if (n < 1000) return String(Math.round(n));
    if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
    return `${(n / 1_000_000).toFixed(1)}m`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run lib/agent-chat/__tests__/token-usage.test.ts`
Expected: PASS.

- [ ] **Step 5: Do NOT commit.** Leave changes in the working tree (per Global Constraints).

---

### Task 2: `data-usage` part builder + client accumulation

**Files:**
- Modify: `apps/web-ui/app/api/chat/stream-parts.ts` (add `buildUsagePart`)
- Modify: `apps/web-ui/components/agent/chat/run-state.ts` (add `tokenUsage` to `RunState` + `case 'data-usage'`)
- Test: `apps/web-ui/app/api/chat/__tests__/stream-parts.test.ts` (append)
- Test: `apps/web-ui/components/agent/chat/__tests__/run-state.test.ts` (append)
- Test: `apps/web-ui/lib/agent-chat/__tests__/events.test.ts` (append — reducer no-op)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `export function buildUsagePart(input: number, output: number): DataPart` (server); `RunState.tokenUsage: { input: number; output: number }` (client). Task 3 consumes `buildUsagePart`; Task 4 (header) consumes `RunState.tokenUsage`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web-ui/app/api/chat/__tests__/stream-parts.test.ts`:

```ts
import { buildUsagePart } from '../stream-parts';

describe('buildUsagePart', () => {
    it('builds a data-usage part', () => {
        expect(buildUsagePart(3, 4)).toEqual({ type: 'data-usage', data: { input: 3, output: 4 } });
    });
});
```

Append to `apps/web-ui/components/agent/chat/__tests__/run-state.test.ts`:

```ts
import { deriveRunState } from '../run-state';

describe('deriveRunState token usage', () => {
    const asst = (parts: any[]) => ({ role: 'assistant', id: 'm', parts });

    it('sums data-usage parts across the thread', () => {
        const state = deriveRunState([
            asst([
                { type: 'data-usage', data: { input: 100, output: 20 } },
                { type: 'data-usage', data: { input: 50, output: 10 } },
            ]),
            asst([{ type: 'data-usage', data: { input: 5, output: 1 } }]),
        ], new Set());
        expect(state.tokenUsage).toEqual({ input: 155, output: 31 });
    });

    it('defaults to zero when there are no data-usage parts', () => {
        const state = deriveRunState([asst([{ type: 'text', text: 'hi' }])], new Set());
        expect(state.tokenUsage).toEqual({ input: 0, output: 0 });
    });
});
```

Append to `apps/web-ui/lib/agent-chat/__tests__/events.test.ts`:

```ts
describe('data-usage parts', () => {
    it('produce no transcript event', () => {
        const events = buildTranscript(msg([{ type: 'data-usage', data: { input: 10, output: 2 } }]), noOpts);
        expect(events).toEqual([]);
    });
});
```

(`buildTranscript`, `msg`, and `noOpts` already exist at the top of `events.test.ts`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```
cd apps/web-ui && bunx vitest run app/api/chat/__tests__/stream-parts.test.ts components/agent/chat/__tests__/run-state.test.ts lib/agent-chat/__tests__/events.test.ts
```
Expected: the `buildUsagePart` and `tokenUsage` tests FAIL (symbol/field missing). The events `data-usage` test likely already PASSES (reducer ignores unknown parts) — that's a regression guard, fine.

- [ ] **Step 3: Add `buildUsagePart` to `stream-parts.ts`**

In `apps/web-ui/app/api/chat/stream-parts.ts`, directly after `buildPhasePart` (ends line 13), add:

```ts
export function buildUsagePart(input: number, output: number): DataPart {
    return { type: 'data-usage', data: { input, output } };
}
```

- [ ] **Step 4: Add `tokenUsage` accumulation to `run-state.ts`**

In `apps/web-ui/components/agent/chat/run-state.ts`:

(a) Add the field to the `RunState` interface (after `hasApprovalData` at line 26):

```ts
    /** Cumulative billed token totals summed from every data-usage part in the thread. */
    tokenUsage: { input: number; output: number };
```

(b) In `deriveRunState`, add two accumulators next to the other `let`s (after line 42 `let hasApprovalData = false;`):

```ts
    let tokenIn = 0;
    let tokenOut = 0;
```

(c) Add a case inside the `switch (part.type)` (e.g. after the `data-phase` case, line 73):

```ts
                case 'data-usage': {
                    tokenIn += Number(part.data?.input) || 0;
                    tokenOut += Number(part.data?.output) || 0;
                    break;
                }
```

(d) Add to the returned object (after `hasApprovalData,` at line 114):

```ts
        tokenUsage: { input: tokenIn, output: tokenOut },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run:
```
cd apps/web-ui && bunx vitest run app/api/chat/__tests__/stream-parts.test.ts components/agent/chat/__tests__/run-state.test.ts lib/agent-chat/__tests__/events.test.ts
```
Expected: PASS.

- [ ] **Step 6: Do NOT commit.**

---

### Task 3: Server — accumulate, stream live, persist the run total

**Files:**
- Modify: `apps/web-ui/app/api/chat/route.ts` (declare `runUsage`; emit in `on_chat_model_end`; persist to last AI message)

**Interfaces:**
- Consumes: `buildUsagePart` from Task 2 (import from `./stream-parts`).
- Produces: streams `data-usage` parts live; writes `metadata.usage_metadata = { input_tokens, output_tokens }` onto the last AI message in the streaming persist path.

- [ ] **Step 1: Declare the request-scoped accumulator**

In `apps/web-ui/app/api/chat/route.ts`, inside `processStream` next to the other per-run accumulators, add after line 708 (`const phaseList: AgentPhase[] = [];`):

```ts
            const runUsage = { input: 0, output: 0 };
```

- [ ] **Step 2: Ensure `buildUsagePart` is imported**

The route already imports from `./stream-parts` (line 12). Add `buildUsagePart` to that existing import list.

- [ ] **Step 3: Extract + emit usage at `on_chat_model_end`**

In the `else if (event.event === "on_chat_model_end") {` branch (line 932), insert at the very top of the branch, BEFORE the existing `if (streamStarted) {` block (line 933):

```ts
                            const endUsage = (event.data?.output as { usage_metadata?: { input_tokens?: number; output_tokens?: number } } | undefined)?.usage_metadata;
                            if (endUsage) {
                                const inTok = Number(endUsage.input_tokens) || 0;
                                const outTok = Number(endUsage.output_tokens) || 0;
                                if (inTok || outTok) {
                                    runUsage.input += inTok;
                                    runUsage.output += outTok;
                                    safeEnqueue(buildUsagePart(inTok, outTok) as UIMessageChunk);
                                }
                            }
```

(Guard-node model runs never reach here — they're short-circuited by `isGuardModelRun` at line 837 — so they stay uncounted, matching the spec.)

- [ ] **Step 4: Persist the run total onto the last AI message**

In the streaming persist block, immediately AFTER the `const mapped = newMessages.map(...)` assignment ends (the closing `});` at line 1219) and BEFORE the `if (memoryRecallText.trim()) {` block (line 1225), add:

```ts
                            if (runUsage.input || runUsage.output) {
                                for (let i = mapped.length - 1; i >= 0; i--) {
                                    if (mapped[i].role === 'ai') {
                                        mapped[i].metadata = {
                                            ...(mapped[i].metadata ?? {}),
                                            usage_metadata: { input_tokens: runUsage.input, output_tokens: runUsage.output },
                                        };
                                        break;
                                    }
                                }
                            }
```

(If the mapped element's `metadata` field is typed too narrowly to reassign, widen the map's return type to `metadata?: Record<string, unknown>` — do not change its runtime shape.)

- [ ] **Step 5: Type-check the touched file**

Run: `cd apps/web-ui && bunx tsc --noEmit 2>&1 | grep -E "app/api/chat/route.ts" || echo "no type errors in route.ts"`
Expected: `no type errors in route.ts`.

- [ ] **Step 6: Full suite (regression)**

Run: `cd apps/web-ui && bun run test`
Expected: no NEW failures vs. the known pre-existing baseline; Task 1/2 tests green.

Note: this task has no isolated unit test (it is streaming glue over LangGraph events); its pure pieces are unit-tested in Tasks 1-2, and its behavior is verified by the manual live check below.

- [ ] **Step 7: Do NOT commit.**

---

### Task 4: History reconstruction + header rendering

**Files:**
- Modify: `apps/web-ui/app/api/threads/[threadId]/history/route.ts` (reconstruct a `data-usage` part from `metadata.usage_metadata`)
- Modify: `apps/web-ui/components/agent/workspace/transcript-header.tsx` (render `runState.tokenUsage`)

**Interfaces:**
- Consumes: `parseUsageMetadata` + `formatTokens` from Task 1; `RunState.tokenUsage` from Task 2.
- Produces: reopened sessions carry `data-usage` parts; the header shows the counter.

- [ ] **Step 1: Reconstruct the usage part on history load**

In `apps/web-ui/app/api/threads/[threadId]/history/route.ts`:

(a) Add the import after the existing `legacy-normalizer` / `ai-content-parts` imports near the top:

```ts
import { parseUsageMetadata } from '@/lib/agent-chat/token-usage';
```

(b) In `convertPlainMessage`, in the `if (role === 'ai')` branch, AFTER the tool-invocation append loop and BEFORE the `if (parts.length === 0) return null;` guard, add:

```ts
        const usage = parseUsageMetadata(metadata?.usage_metadata);
        if (usage && parts.length > 0) {
            parts.push({ type: 'data-usage', data: { input: usage.input, output: usage.output } });
        }
```

(The `parts.length > 0` guard means usage never resurrects an otherwise-empty/dropped message; the run total is stored on the answer message, which has content. `convertMessage` — the checkpoint fallback — is intentionally NOT changed: the checkpoint holds per-message usage, not the run total, and would double-count; the primary `chat_messages` path is authoritative.)

- [ ] **Step 2: Render the counter in the header**

In `apps/web-ui/components/agent/workspace/transcript-header.tsx`:

(a) Add the import after line 12 (`import type { RunState } ...`):

```tsx
import { formatTokens } from "@/lib/agent-chat/token-usage";
```

(b) Inside the `ml-auto` flex container (line 139), add as the FIRST child, before the `elapsedMs` span (line 140):

```tsx
        {(runState.tokenUsage.input > 0 || runState.tokenUsage.output > 0) && (
          <span
            data-testid="token-usage"
            className="font-mono text-xs text-muted-foreground"
            title={`Incoming ${runState.tokenUsage.input.toLocaleString()} tokens · Outgoing ${runState.tokenUsage.output.toLocaleString()} tokens`}
          >
            ↓ {formatTokens(runState.tokenUsage.input)} · ↑ {formatTokens(runState.tokenUsage.output)}
          </span>
        )}
```

- [ ] **Step 3: Type-check the touched files**

Run: `cd apps/web-ui && bunx tsc --noEmit 2>&1 | grep -E "history/route.ts|transcript-header" || echo "no type errors in touched files"`
Expected: `no type errors in touched files`.

- [ ] **Step 4: Full suite (regression)**

Run: `cd apps/web-ui && bun run test`
Expected: no new failures; existing `run-state.test.ts` / history-related tests still green.

- [ ] **Step 5: Do NOT commit.**

---

## Manual / integration verification (after Task 4)

1. Start a chat, send a reasoning/tool-heavy prompt → the header counter (`↓ … · ↑ …`) appears and **ticks up** as the agent runs (input grows fast across iterations; output grows with generated text).
2. Send a second message in the same chat → totals keep accumulating (don't reset).
3. Reload the page / reopen the session from the sidebar → the counter shows the **same** total it had before reload (not lower).
4. A brand-new empty chat shows **no** counter (hidden at zero).
5. Hover the counter → tooltip shows exact `Incoming N tokens · Outgoing N tokens`.

## Self-Review (completed by plan author)

- **Spec coverage:** cumulative sum model → Task 2 `deriveRunState`; live per-call emit + run-total persist → Task 3; history reconstruction → Task 4 Step 1; header render + format → Task 4 Step 2 + Task 1 `formatTokens`; `events.ts` no-op → Task 2 test; exclusions (guard/non-stream/direct/deep-agent/convertMessage) → noted in Global Constraints + Task 3/4 notes.
- **Placeholder scan:** none — every code step has full code and exact commands.
- **Type consistency:** `buildUsagePart(input, output)`, `parseUsageMetadata`, `formatTokens`, and `RunState.tokenUsage: { input; output }` are named identically in their definition and every consumer; the `data-usage` shape `{ input, output }` is identical in the builder, the reducer case, the history reconstruction, and the tests.
