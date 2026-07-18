# AI Ops Workspace Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the AI Ops chat (`/app/agent`) as a Devin-style 3-column workspace — session sidebar, transcript with faded collapsible thinking blocks + compact tool rows, plan/activity rail — driven end-to-end by typed stream parts instead of sentinel-string parsing.

**Architecture:** The backend already emits typed parts live (`data-phase` route.ts:771, `data-plan` route.ts:929, `data-approval`/`data-clarification` route.ts:944 via `app/api/chat/stream-parts.ts`) *and* legacy sentinels (`PLANNING_PHASE_START` etc.) inside reasoning text. We finish the typed migration (add `data-memory`, humanize reflector JSON, stop live sentinels, convert sentinels→typed parts server-side on history reload), build a pure `buildTranscript()` reducer that turns `message.parts` into a `TranscriptEvent[]`, then render that with new focused components under `components/agent/workspace/`. The old UI keeps working until the final swap task.

**Tech Stack:** Next.js 15 App Router, React 19, AI SDK 7 (`@ai-sdk/react` useChat, `UIMessageChunk`), Tailwind + shadcn tokens, existing `components/ai-elements/*` primitives, Vitest + fast-check, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-18-aiops-workspace-redesign-design.md` (read it first).

## Global Constraints

- All web-ui imports use the `@/` alias (maps to `apps/web-ui/`); relative imports only within the same directory.
- Existing shadcn/Tailwind tokens only (`primary`, `muted`, `muted-foreground`, `border`, `destructive`); **no new palette, no hex colors**. Semantic status colors: `text-emerald-600` ✓, `text-red-500`/`text-destructive` ✗, `text-amber-500` ⚠ — nothing else colored.
- Sentence case in all UI copy. No ALL-CAPS labels (the `uppercase tracking-wider` section-title pattern in `run-rail.tsx` is the one allowed exception).
- Geist Sans default; `font-mono` (Geist Mono) only inside tool commands/IO/code.
- Components: named exports, `"use client"` where hooks are used, props typed inline, `cn()` for conditional classes. UI primitives from `components/ui/` are consumed, never modified.
- Toasts: `import { toast } from "sonner"`.
- New files ≤ ~300 lines. If a task's file grows past that, split it.
- Tests: Vitest via `cd apps/web-ui && bun run test` (runs `vitest run`). Test files colocate under `__tests__/`.
- Every task ends with a commit. Run `cd apps/web-ui && bunx tsc --noEmit` before each commit; the repo has a pre-existing baseline of tsc errors — you only must not *add* new ones (compare against `git stash`-free baseline by running it on HEAD first if unsure — do NOT use git stash, run it before your edits).
- The old `chat-interface.tsx` path must keep compiling and working until Task 14 swaps it out.

## Key existing code (read before starting any task)

| File | What it gives you |
|---|---|
| `apps/web-ui/app/api/chat/route.ts` | streaming core: `processStream()` (L651–1079), `getPhaseFromNode` (L~570), `getPhaseMarker` (L605), reasoning/text delta emission (L778–827), memory text capture (L704–710, 806–808), persistence with sentinel prefixes (L1004–1074) |
| `apps/web-ui/app/api/chat/stream-parts.ts` | `buildPlanPart`, `buildPhasePart`, `buildInterruptParts`, `DataPart` type |
| `apps/web-ui/components/agent/chat/run-state.ts` | `deriveRunState(messages, resolvedToolCallIds)` → plan/phase/approvals; `computeToolPartVisibility`; `isRejectedToolResult` |
| `apps/web-ui/components/agent/chat/use-run-state.ts`, `use-decisions.ts` | hooks wrapping the above |
| `apps/web-ui/components/agent/chat-interface.tsx` | the 2,904-line monolith being replaced; sentinel parser L147–188; history fetch L1072–1132; approval handler L1312–1358; composer/render below L1360 |
| `apps/web-ui/app/api/threads/[threadId]/history/route.ts` | history reload — currently returns sentinel-prefixed content the client regex-parses |
| `apps/web-ui/components/ai-elements/` | `reasoning.tsx`, `tool.tsx`, `plan.tsx`, `task.tsx`, `confirmation.tsx` primitives |
| `apps/web-ui/components/agent/chat/{approval-batch-card,clarification-card,guard-risk-panel,run-rail,run-timeline}.tsx` | surviving Mission Control components |
| `apps/web-ui/app/app/agent/page.tsx` + `components/agent/chat-tab-bar.tsx` | current tab shell (removed in Task 14) |

---

## Phase A — Typed stream completion (backend)

### Task 1: `TranscriptEvent` model + `buildTranscript()` reducer

**Files:**
- Create: `apps/web-ui/lib/agent-chat/events.ts`
- Test: `apps/web-ui/lib/agent-chat/__tests__/events.test.ts`

**Interfaces:**
- Consumes: AI SDK message shape `{ id, role, parts: [{ type, text?, data?, toolCallId?, state?, input?, output?, ... }] }` (same loose shape as `run-state.ts` `LooseMessage`).
- Produces (later tasks rely on these exact names):

```typescript
export type TranscriptEvent =
  | { kind: 'thinking'; id: string; phase: AgentPhaseName; text: string; streaming: boolean }
  | { kind: 'tool'; id: string; toolCallId: string; toolName: string; input: unknown;
      output: unknown; status: 'running' | 'done' | 'error' | 'rejected' }
  | { kind: 'memory'; id: string; op: 'recall' | 'save'; summary: string; count: number | null }
  | { kind: 'answer'; id: string; text: string; streaming: boolean }
  | { kind: 'image'; id: string; url: string };

export type AgentPhaseName =
  | 'planning' | 'execution' | 'reflection' | 'revision' | 'final'
  | 'memory_recall' | 'memory_save' | 'text';

export function buildTranscript(
  message: LooseMessage,
  opts: { isStreaming: boolean; toolVisibility: Map<string, string>;
          decisions: Map<string, { approved: boolean; answer?: string }> },
): TranscriptEvent[];
```

**Behavior contract (encode each bullet as a test):**
1. Walks `message.parts` in order, tracking current phase from `data-phase` parts (`part.data.phase`). `data-phase` parts themselves emit no event.
2. `reasoning` parts → `thinking` events tagged with the current phase. **Strip any leading sentinel** (`/^(PLANNING|EXECUTION|REFLECTION|REVISION|FINAL|MEMORY_RECALL|MEMORY_SAVE)_PHASE_START\n?/`) defensively. Reasoning text that is empty after stripping emits nothing. Consecutive reasoning parts with the same phase and no intervening tool/memory/answer event merge into ONE thinking event (concatenated text).
3. Tool parts (any part with `toolCallId`, type ≠ `text`) → `tool` events. Status: `rejected` if `isRejectedToolResult(output, decisions.get(toolCallId))` (import from `@/components/agent/chat/run-state`); `error` if `state === 'output-error'`; `done` if output present or `state === 'output-available'`; else `running`. Skip the part when `toolVisibility.get(toolCallId) !== message.id` (cross-message dedupe, same rule as today).
4. `data-memory` parts (`{ op, summary, count }`) → `memory` events.
5. `text` parts → `answer` events (whitespace-only text emits nothing — covers the backend's `' '` placeholder).
6. Reasoning parts whose phase is `memory_recall`/`memory_save` → `memory` events (`summary` = text, `count: null`), NOT thinking events — this is the legacy-thread path.
7. `streaming: true` only on the LAST event of the LAST assistant message while `opts.isStreaming`.
8. `data-plan`, `data-approval`, `data-clarification`, `step-start` parts emit no event (rail/cards consume them via `deriveRunState`).

- [ ] **Step 1: Write failing tests** — one `describe` per bullet above. Example shape:

```typescript
import { describe, it, expect } from 'vitest';
import { buildTranscript } from '../events';

const msg = (parts: any[]) => ({ id: 'm1', role: 'assistant', parts });
const noOpts = { isStreaming: false, toolVisibility: new Map(), decisions: new Map() };

describe('phase tracking', () => {
  it('tags reasoning with the phase from the preceding data-phase part', () => {
    const events = buildTranscript(msg([
      { type: 'data-phase', data: { phase: 'planning' } },
      { type: 'reasoning', text: 'Let me plan.' },
    ]), noOpts);
    expect(events).toEqual([
      expect.objectContaining({ kind: 'thinking', phase: 'planning', text: 'Let me plan.' }),
    ]);
  });
});

describe('sentinel stripping', () => {
  it('strips a leading PLANNING_PHASE_START marker', () => {
    const events = buildTranscript(msg([
      { type: 'reasoning', text: 'PLANNING_PHASE_START\nLet me plan.' },
    ]), noOpts);
    expect((events[0] as any).text).toBe('Let me plan.');
  });
});

describe('tool dedupe', () => {
  it('skips a tool part whose visibility winner is another message', () => {
    const vis = new Map([['tc1', 'OTHER']]);
    const events = buildTranscript(msg([
      { type: 'tool-execute_command', toolCallId: 'tc1', state: 'input-available', input: {} },
    ]), { ...noOpts, toolVisibility: vis });
    expect(events).toEqual([]);
  });
});
// ...cover bullets 3 (all four statuses), 4, 5, 6, 7, 8 the same way
```

- [ ] **Step 2: Run tests, verify they fail** — `cd apps/web-ui && bunx vitest run lib/agent-chat` → FAIL (module not found).
- [ ] **Step 3: Implement `events.ts`** per the contract. Reuse `isRejectedToolResult` from run-state; do not duplicate it. Keep the file pure (no React).
- [ ] **Step 4: Run tests, verify pass** — `bunx vitest run lib/agent-chat` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(agent-chat): TranscriptEvent model + buildTranscript reducer"`

### Task 2: `data-memory` part emitted live; memory reasoning silenced

**Files:**
- Modify: `apps/web-ui/app/api/chat/stream-parts.ts` (add builder)
- Modify: `apps/web-ui/app/api/chat/route.ts` (emission)
- Test: `apps/web-ui/app/api/chat/__tests__/stream-parts.test.ts` (create)

**Interfaces:**
- Produces: `buildMemoryPart(op: 'recall' | 'save', summary: string): DataPart` → `{ type: 'data-memory', data: { op, summary, count } }` where `count` = number of markdown bullets (`/^[-*•]\s/m` matches) in summary, or `null` if none.

- [ ] **Step 1: Failing test** for `buildMemoryPart` (count derivation: 3-bullet summary → 3; prose → null).
- [ ] **Step 2: Implement** in `stream-parts.ts`.
- [ ] **Step 3: Wire into route.ts.** In `processStream`: memory text already accumulates in `memoryRecallText`/`memorySaveText` (L704–710, 806–808). Changes:
  - In `on_chat_model_start`/`on_chat_model_stream`/`on_chat_model_end`, when `currentPhase` is `memory_recall`/`memory_save`, **do not** open/stream/close a reasoning part (keep accumulating the text into the existing buffers; keep `phaseList` push so persistence positioning is unchanged).
  - In `on_chat_model_end` for those phases, emit `safeEnqueue(buildMemoryPart('recall' | 'save', accumulatedText) as UIMessageChunk)` — use a per-run local accumulator so multiple recalls in one run emit separate parts; the existing `memoryRecallText` global buffer still feeds persistence.
- [ ] **Step 4:** `bunx vitest run app/api/chat` → PASS; `bunx tsc --noEmit` → no new errors.
- [ ] **Step 5: Commit** — `feat(chat-api): emit data-memory parts, stop streaming memory text as reasoning`

### Task 3: Reflection humanized — raw reflector JSON never streams

**Files:**
- Modify: `apps/web-ui/app/api/chat/stream-parts.ts` (add `humanizeReflection`)
- Modify: `apps/web-ui/app/api/chat/route.ts`
- Test: extend `apps/web-ui/app/api/chat/__tests__/stream-parts.test.ts`

**Interfaces:**
- Produces: `humanizeReflection(raw: string): string` — parses the reflector's JSON (`{ isComplete, analysis, issues, suggestions, updatedPlan }`, possibly wrapped in ```json fences or with leading prose) and returns prose: `analysis` + (if non-empty/non-"None") `\n\nIssues: ${issues}` + `\n\nNext: ${suggestions}`. On parse failure returns `raw` unchanged.

- [ ] **Step 1: Failing tests** — full JSON → prose without braces/quotes; fenced JSON; `issues: "None for this step."` omitted; malformed input passthrough.
- [ ] **Step 2: Implement** (find first `{`…last `}`, `JSON.parse`, fall back on throw).
- [ ] **Step 3: Wire into route.ts.** When `currentPhase === 'reflection'`: buffer deltas into a local `reflectionBuf` instead of enqueueing reasoning-deltas; at `on_chat_model_end`, emit one reasoning part (`reasoning-start` / single `reasoning-delta` with `humanizeReflection(reflectionBuf)` / `reasoning-end`) under a fresh part id. Also apply `humanizeReflection` to the reflection message content before persistence (in the `finally` block's marker loop, when the tagged phase is `reflection`).
- [ ] **Step 4:** tests + tsc pass. Manually verify with dev server if convenient: reflection renders as prose.
- [ ] **Step 5: Commit** — `feat(chat-api): humanize reflector output; never stream raw reflection JSON`

### Task 4: Kill live sentinels; history route emits typed parts

**Files:**
- Create: `apps/web-ui/lib/agent-chat/legacy-normalizer.ts`
- Modify: `apps/web-ui/app/api/chat/route.ts` (stop emitting live markers)
- Modify: `apps/web-ui/app/api/threads/[threadId]/history/route.ts`
- Test: `apps/web-ui/lib/agent-chat/__tests__/legacy-normalizer.test.ts`

**Interfaces:**
- Produces: `normalizeLegacyContent(content: string): { phase: AgentPhaseName; text: string }` — the ONLY code allowed to know sentinel strings after this task (route.ts keeps `getPhaseMarker` for persistence-format compatibility only).
- The history route's reconstructed assistant messages gain, for each phase-marked content block: a `{ type: 'data-phase', data: { phase, node: 'history', ts: 0 } }` part followed by a `reasoning` (or `text` for `final`/`text` phases) part with the stripped text. Read the route first and adapt to its existing parts-building code — it already reconstructs reasoning/phase parts from markers; refactor it to delegate all marker knowledge to `normalizeLegacyContent`.

- [ ] **Step 1: Failing tests** for `normalizeLegacyContent` — each of the 7 markers maps to its phase; unmarked content → `{ phase: 'text', text: content }`. Add a fast-check property test: for any string s without leading marker, `normalizeLegacyContent(s).text === s`; for any marker m + s, `.text === s`.
- [ ] **Step 2: Implement** `legacy-normalizer.ts` (port the mapping from `chat-interface.tsx:147–188`).
- [ ] **Step 3: route.ts live-stream change.** Delete the `getPhaseMarker` delta emission in `on_chat_model_start` (L783–794). Persistence marker-prefixing in the `finally` block stays untouched.
- [ ] **Step 4: history route change.** Replace its inline marker parsing with `normalizeLegacyContent`; emit `data-phase` + reasoning/text parts as specified. Memory-phase blocks (`memory_recall`/`memory_save`) become `{ type: 'data-memory', data: { op, summary: text, count: null } }` parts instead of reasoning.
- [ ] **Step 5:** all vitest suites + tsc pass. Legacy UI still renders live streams correctly (it has phase-config fallbacks; brief manual check with `bun run dev` — phases show as plain reasoning blocks now, acceptable during migration).
- [ ] **Step 6: Commit** — `feat(chat-api): typed-parts history reconstruction; stop streaming phase sentinels`

## Phase B — Transcript components

### Task 5: `ThinkingBlock` — faded collapsible with duration

**Files:**
- Create: `apps/web-ui/components/agent/workspace/events/thinking-block.tsx`
- Test: `apps/web-ui/components/agent/workspace/events/__tests__/thinking-block.test.tsx`

**Interfaces:**
- Consumes: `TranscriptEvent & { kind: 'thinking' }` from Task 1.
- Produces: `export function ThinkingBlock({ event, durationMs }: { event: Extract<TranscriptEvent, { kind: 'thinking' }>; durationMs?: number })`.

**Behavior:** Wraps `components/ai-elements/reasoning.tsx` (`Reasoning`, `ReasoningTrigger`, `ReasoningContent`). Trigger label: `Thought for ${seconds}s` when `durationMs` known, else `Thinking…` while `event.streaming`, else `Thought`. Open while `event.streaming` (pass `isStreaming`), `defaultOpen={false}` otherwise (the ai-elements Reasoning already auto-collapses when streaming flips false — verify; if not, control `open` locally with a `useEffect` on `event.streaming`). Row styling: `text-xs italic text-muted-foreground`, no border, hover `bg-muted/40`. Expanded content shows a phase tag chip (`event.phase` sentence-cased, e.g. `reflection` → "Reflection") when phase ≠ `execution`, rendered `text-[10px] rounded bg-muted px-1.5`. Markdown via `MarkdownContent` from `@/components/ui/markdown-content`.

- [ ] **Step 1: Failing component tests** (Testing Library, jsdom — follow the pattern in `components/agent/chat/__tests__/clarification-card.test.tsx`): renders "Thought for 12s" for `durationMs: 12000`; renders "Thinking…" when streaming; content hidden when collapsed; phase chip "Reflection" visible when expanded for phase `reflection`.
- [ ] **Step 2:** verify fail → **Step 3:** implement → **Step 4:** pass + tsc.
- [ ] **Step 5: Commit** — `feat(workspace): ThinkingBlock event component`

### Task 6: `ToolRow` — compact row, expand, grouping

**Files:**
- Create: `apps/web-ui/components/agent/workspace/events/tool-row.tsx`
- Create: `apps/web-ui/lib/agent-chat/group-events.ts`
- Test: `apps/web-ui/lib/agent-chat/__tests__/group-events.test.ts`, `apps/web-ui/components/agent/workspace/events/__tests__/tool-row.test.tsx`

**Interfaces:**
- `groupEvents(events: TranscriptEvent[]): Array<TranscriptEvent | { kind: 'tool-group'; id: string; tools: Array<Extract<TranscriptEvent, { kind: 'tool' }>> }>` — runs of ≥3 consecutive `tool` events all with status `done` collapse into one `tool-group`; runs containing any `running`/`error`/`rejected` tool are never grouped; non-tool events pass through.
- `ToolRow({ event }: { event: Extract<TranscriptEvent, { kind: 'tool' }> })` and `ToolGroupRow({ group, }: { group: { tools: [...] } })` (both exported from `tool-row.tsx`).

**Row anatomy (28–32px):** chevron, tool icon (map: `execute_command`→`Terminal`, `read_file`→`FileText`, `write_file`→`FilePen`, `search_knowledge_base`→`BookOpen`, default `Wrench` — lucide-react), tool name in `font-mono text-xs`, argument preview (first meaningful arg value: `command` | `file_path` | `path` | `query` | first string value; truncated `max-w-[24rem] truncate font-mono text-muted-foreground`), status: spinner (`Spinner` from `@/components/ui/spinner`) / `✓` `text-emerald-600` / `✗` `text-red-500` / `Rejected` chip `text-red-500`. Expanded: Input and Output panes, `font-mono text-xs bg-muted/40 rounded p-2 overflow-x-auto`, input rendered via `JSON.stringify(input, null, 2)` after unwrapping — if `input` is `{ input: string }` where the string parses as JSON, unwrap and parse it (kills the double-escaped display). Output: string rendered verbatim in `<pre>`, object pretty-printed. Group row: `Ran ${n} tools ✓` expands to the individual rows.

- [ ] **Step 1: Failing tests** — `group-events`: 3 done tools → one group; 2 done → passthrough; done-running-done → passthrough; thinking-tool-tool-tool-answer ordering preserved. `tool-row`: renders name + preview from `{ command: 'aws lambda list-functions' }`; double-encoded `{ input: "{\"file_path\":\"/tmp/x\"}" }` expands to show `file_path` un-escaped; rejected status renders "Rejected".
- [ ] **Step 2–4:** fail → implement → pass + tsc.
- [ ] **Step 5: Commit** — `feat(workspace): ToolRow/ToolGroupRow + event grouping`

### Task 7: `MemoryRow` + interrupt cards restyle-in-place

**Files:**
- Create: `apps/web-ui/components/agent/workspace/events/memory-row.tsx`
- Modify: `apps/web-ui/components/agent/chat/approval-batch-card.tsx`, `clarification-card.tsx`, `guard-risk-panel.tsx` (styling only — tokens/sentence case; **no behavior change**; existing tests must keep passing unchanged except copy assertions)
- Test: `apps/web-ui/components/agent/workspace/events/__tests__/memory-row.test.tsx`

**Interfaces:** `MemoryRow({ event }: { event: Extract<TranscriptEvent, { kind: 'memory' }> })`. Label: `Recalled ${count} memories` / `Saved ${count} memories` (singular handled); `count: null` → `Recalled memories` / `Saved memories`. Icons: `Brain` (recall) / `Database` (save), `text-muted-foreground`. Collapsible; expanded shows `summary` as markdown. Same row chrome as ThinkingBlock (no border, hover tint).

- [ ] **Step 1: Failing tests** (labels incl. singular + null-count; collapsed by default).
- [ ] **Step 2–4:** implement; then restyle the three cards (keep all handlers/test ids); run `bunx vitest run components/agent` → all pass.
- [ ] **Step 5: Commit** — `feat(workspace): MemoryRow; restyle interrupt cards to workspace tokens`

### Task 8: `AgentTurn` + `Transcript` — assemble the grammar

**Files:**
- Create: `apps/web-ui/components/agent/workspace/agent-turn.tsx`
- Create: `apps/web-ui/components/agent/workspace/transcript.tsx`
- Test: `apps/web-ui/components/agent/workspace/__tests__/agent-turn.test.tsx`

**Interfaces:**
- `AgentTurn({ message, isStreaming, toolVisibility, decisions, showWork, onApprove, onReject, onClarify })` — one assistant message: avatar (single `Bot` icon in a `size-7` rounded square, ONE per turn), then `groupEvents(buildTranscript(message, …))` mapped: `thinking`→`ThinkingBlock`, `tool`→`ToolRow`, `tool-group`→`ToolGroupRow`, `memory`→`MemoryRow`, `answer`→`MarkdownContent` full-opacity in `prose` styles, `image`→`<img>`. Process rows render inside a `border-l pl-3 ml-3` guide line; the answer renders outside/below it. `showWork: false` hides all non-answer events behind a single `▸ Show work (n steps)` toggle row. Interrupt cards: when `deriveRunState` (passed-down `runState`) has `pendingApproval`/`pendingClarifications` attached to this message (last assistant message), render `ApprovalBatchCard`/`ClarificationCard` after the events — reuse the exact wiring currently in `chat-interface.tsx` (search for `<ApprovalBatchCard` there and port its props).
- `Transcript({ messages, ...passthrough })` — the ONLY scroll container (`overflow-y-auto`); user messages as right-aligned `bg-primary text-primary-foreground rounded-2xl` bubbles (filter `isEmptyDecisionCarrier` — port from `chat-interface.tsx:294–304` into `lib/agent-chat/events.ts` and re-export); assistant messages as `AgentTurn`; content column `mx-auto w-full max-w-3xl px-4`; auto-scroll-to-bottom unless the user scrolled up (port the `handleScroll` intent logic from `chat-interface.tsx:1152–1163`).
- Thinking `durationMs`: compute in `Transcript` from consecutive `data-phase` `ts` values on the message (`part.data.ts`); pass a `Map<eventId, ms>` down. Best-effort — `undefined` is fine for history (`ts: 0`).

- [ ] **Step 1: Failing tests** — assistant message with reasoning+tool+text parts renders exactly one avatar, one ThinkingBlock, one ToolRow, one answer; `showWork:false` hides rows and shows "Show work (2 steps)"; decision-carrier user message renders nothing.
- [ ] **Step 2–4:** fail → implement → pass + tsc.
- [ ] **Step 5: Commit** — `feat(workspace): AgentTurn + Transcript`

## Phase C — Shell

### Task 9: `useChatSession` — extract wiring from the monolith

**Files:**
- Create: `apps/web-ui/lib/agent-chat/use-chat-session.ts`
- Test: none (extraction of already-tested behavior; covered by Task 14 smoke)

**Interfaces:**
- Produces: `useChatSession(opts: { threadId: string; body: () => Record<string, unknown> })` returning `{ messages, sendMessage, stop, status, error, runState, decisions, decide, submitClarification, toolVisibility, isStreaming }`.
- This is a **move, not a rewrite**: lift from `chat-interface.tsx` the `useChat` + `DefaultChatTransport` setup, history fetch + restore (L1072–1132 — keep calling `/api/threads/${threadId}/history`; with Task 4 it now returns typed parts, so DELETE the client-side plan/sentinel reconstruction and pass parts through), `useRunState`, `useDecisions`, and the approval/clarification submit handlers (`handleToolApproval` L1312–1358 and the batch-decision submit — search `decisions` POST in the file). Keep the old component compiling by leaving its internal copies untouched (the new hook duplicates temporarily; the monolith dies in Task 14 — this is the one sanctioned duplication).

- [ ] **Step 1: Implement the hook** by porting the code paths above.
- [ ] **Step 2:** `bunx tsc --noEmit` — no new errors. `bunx vitest run` — all green.
- [ ] **Step 3: Commit** — `feat(agent-chat): useChatSession hook (extracted chat wiring)`

### Task 10: `SessionSidebar`

**Files:**
- Create: `apps/web-ui/components/agent/workspace/session-sidebar.tsx`
- Test: `apps/web-ui/components/agent/workspace/__tests__/session-sidebar.test.tsx`

**Interfaces:**
- Consumes: the existing threads listing used by `components/agent/thread-sidebar.tsx` (read it; reuse its fetch endpoint via a TanStack Query hook — if `lib/queries/` has no threads hook, add `lib/queries/agent-threads.ts` with `useAgentThreads()` keyed via `query-keys.ts`).
- Produces: `SessionSidebar({ sessions, activeId, onSelect, onNew, statuses, collapsed, onToggleCollapse })` where `statuses: Map<string, 'streaming' | 'attention' | 'idle'>` (green pulse dot / amber dot / none).

**Behavior:** `+ New chat` button (full-width, top), search input filtering by title (client-side), sessions grouped by `Today` / `Yesterday` / `Previous` from `updatedAt` (dayjs is available at root; prefer plain `Date` math here — no new deps), each row: truncated title + status dot + relative time. Collapse to a 48px icon strip (`PanelLeft` toggle). Width `w-64`, `border-r bg-muted/20`.

- [ ] **Step 1: Failing tests** — groups render; streaming session shows pulse dot (`data-testid="status-streaming"`); search filters; onSelect fires.
- [ ] **Step 2–4:** fail → implement → pass + tsc.
- [ ] **Step 5: Commit** — `feat(workspace): SessionSidebar`

### Task 11: `TranscriptHeader` (stepper) + `RunRail` evolution

**Files:**
- Create: `apps/web-ui/components/agent/workspace/transcript-header.tsx`
- Modify: `apps/web-ui/components/agent/chat/run-rail.tsx`
- Test: `apps/web-ui/components/agent/workspace/__tests__/transcript-header.test.tsx`

**Interfaces:**
- `TranscriptHeader({ title, runState, isStreaming, elapsedMs, onMenuAction }: { title: string; runState: RunState; isStreaming: boolean; elapsedMs: number | null; onMenuAction: (a: 'export' | 'copy' | 'schedule' | 'skill' | 'clear') => void })`.
- Stepper derives ONLY from `runState`: steps `Plan · Execute · Reflect · Revise`; a step is ✓ when its phase appears in `runState.phases` before the current one, ● (pulse, `text-primary`) when `runState.currentPhase` maps to it (`planning`→Plan, `execution`/`memory_recall`→Execute, `reflection`→Reflect, `revision`/`memory_save`→Revise, `final`→all ✓), upcoming steps `text-muted-foreground/50`. Execute step shows `n/N` from `runState.plan` when plan non-empty. Idle (not streaming, no phases) → no stepper, just title.
- `run-rail.tsx` changes: (a) plan steps render a derived short title — first sentence clause of `step.step` truncated at 60 chars — with the full text in a collapsible detail (use `PlanStep` children for title; wrap with a `title=` tooltip attr for full text); (b) add a thin progress bar (`h-1 rounded bg-muted` + `bg-primary` fill `width: done/total`); (c) DELETE the "Generating…" style badge if present (status derives from `runState` only — it already does; verify no contradictory copy remains); (d) add transient activity line: when `currentPhase` is `memory_save`/`memory_recall`, Activity shows `Saving memory…`/`Recalling memory…` with spinner.

- [ ] **Step 1: Failing tests** — stepper: `currentPhase: 'execution'`, plan 12/19 → Plan ✓, Execute active with "12/19"; `final` → all ✓; idle → no stepper.
- [ ] **Step 2–4:** fail → implement (keep existing run-rail tests passing) → pass + tsc.
- [ ] **Step 5: Commit** — `feat(workspace): TranscriptHeader stepper; run-rail short titles + progress`

### Task 12: `Composer`

**Files:**
- Create: `apps/web-ui/components/agent/workspace/composer.tsx`
- Test: `apps/web-ui/components/agent/workspace/__tests__/composer.test.tsx`

**Interfaces:**
- `Composer(props)` with props lifted from the monolith's composer region (below `chat-interface.tsx:2600` — read it): `{ value, onChange, onSubmit, onStop, isStreaming, disabled, context, onContextChange, attachments, onAttach, mode, onModeChange }` where `context = { account, model, skill, kb, tools }` (the same state objects the monolith manages — port the pickers' internals, not their layout).

**Layout:** (1) chips row — account/model/skill as removable `rounded-full border px-2.5 py-0.5 text-xs` pills with full name in `title` tooltip, `×` to clear; (2) `+` popover (Popover from ui) containing the KB selector, tools selector, and image attach (reuse `FileUpload`); (3) textarea auto-grow 1→8 rows (`max-h-48`), Enter submits / Shift+Enter newline (port `handleKeyDown` L1215–1220); (4) right: mode popover button (gear-less label showing current mode, containing the Plan & Execute select + auto-approve + show-tools switches) then Send/Stop button (`bg-primary` circle, `Square` icon while streaming); (5) char counter renders only past 1800/2000.

- [ ] **Step 1: Failing tests** — Enter fires onSubmit, Shift+Enter doesn't; chip removal calls onContextChange; counter hidden at 100 chars, visible at 1900.
- [ ] **Step 2–4:** fail → implement → pass + tsc.
- [ ] **Step 5: Commit** — `feat(workspace): Composer with context chips + consolidated popovers`

## Phase D — Assembly & swap

### Task 13: `AgentWorkspace` shell — assembled behind a flag

**Files:**
- Create: `apps/web-ui/components/agent/workspace/agent-workspace.tsx`
- Modify: `apps/web-ui/app/app/agent/page.tsx`

**Interfaces:** `AgentWorkspace()` — owns: sessions state (port multi-chat/thread state from `page.tsx` + `chat-tab-bar.tsx`, replacing tabs with `SessionSidebar`; background sessions keep their `useChatSession` instances mounted — render inactive sessions' components hidden via `hidden` class, NOT unmounted, exactly as the tab implementation does today — verify how page.tsx keeps tabs alive and mirror it), layout grid `grid-cols-[auto_1fr_auto] h-[calc(100vh-<app-header-height>)]` (measure the app chrome; transcript is the only scroller), right rail collapsible (persist open state in localStorage — port the pref key from `chat-interface.tsx:534`), `showWork` toggle state per session (default true), elapsed timer (port `AgentExecutionTimer` logic L583–614 into the header's `elapsedMs`).
`page.tsx`: render `<AgentWorkspace />` when `?workspace=1` (or `NEXT_PUBLIC_AGENT_WORKSPACE=1`), else the legacy tabs UI. Mobile (<`lg`): sidebar becomes a Sheet drawer, rail hidden behind a toggle (mirror current behavior).

- [ ] **Step 1: Implement** (no new unit tests — integration covered next task; keep components ≤300 lines by splitting a `use-workspace-sessions.ts` hook out if needed).
- [ ] **Step 2: Manual verification** with `bun run dev` (requires `docker compose up -d postgres`): open `http://localhost:3001/app/agent?workspace=1`, send "list my AWS accounts" against a seeded account: thinking block streams faded and auto-collapses; tool rows compact with ✓; answer prominent; plan rail fills; stepper live; sidebar shows session with green dot; legacy UI unaffected at plain `/app/agent`.
- [ ] **Step 3: Commit** — `feat(workspace): AgentWorkspace shell behind ?workspace=1 flag`

### Task 14: Swap, delete legacy, E2E smoke

**Files:**
- Modify: `apps/web-ui/app/app/agent/page.tsx` (workspace becomes the only UI)
- Delete: `apps/web-ui/components/agent/chat-interface.tsx`, `apps/web-ui/components/agent/chat-tab-bar.tsx`, `apps/web-ui/components/agent/thread-sidebar.tsx` (superseded by SessionSidebar — first grep for other importers; if Agent Ops or deep-agent pages import any of these, port those usages before deleting)
- Create: `apps/web-ui-e2e/agent-workspace.spec.ts`

- [ ] **Step 1: Pre-delete sweep** — `grep -rn "chat-interface\|chat-tab-bar\|thread-sidebar" apps/web-ui --include="*.tsx" --include="*.ts" -l` and migrate every importer to workspace components.
- [ ] **Step 2: Swap page.tsx**, delete the three files, remove the flag.
- [ ] **Step 3: E2E smoke** (follow `apps/web-ui-e2e/navigation.spec.ts` auth/setup conventions):

```typescript
import { test, expect } from '@playwright/test';

test.describe('Agent workspace', () => {
  test('renders workspace shell', async ({ page }) => {
    await page.goto('/app/agent');
    await expect(page.getByRole('button', { name: 'New chat' })).toBeVisible();
    await expect(page.getByPlaceholder(/ask/i)).toBeVisible();
    await expect(page.getByTestId('run-rail')).toBeVisible();
  });
});
```

- [ ] **Step 4: Full verification** — `cd apps/web-ui && bun run test` all green; `bunx tsc --noEmit` no new errors vs baseline; `bun run lint` clean on changed files; manual dev-server pass of: new chat, streaming run with tools, approval flow (`Plan & Execute` without auto-approve), clarification flow, reload mid-history (typed-parts reconstruction), legacy thread from before this branch renders correctly.
- [ ] **Step 5: Commit** — `feat(agent): swap AI Ops page to workspace UI; remove legacy chat interface`

---

## Self-review notes (spec coverage)

- Spec §1 shell → Tasks 10, 11, 13; §2 theme → Global Constraints + every component task; §3 grammar → Tasks 5–8 (thinking, tool rows+grouping, memory, answer, show-work, interrupt cards); §4 rail → Task 11; §5 composer → Task 12; §6 typed stream → Tasks 1–4 (note: spec's `data-thinking` realized as reasoning parts + `data-phase` ordering — equivalent information, zero new part type; spec's "versioned parts payload" realized as server-side typed reconstruction from the unchanged persisted format — strictly safer); §7 architecture → file map above (`events/approval cards` stay in `chat/` and are restyled in place rather than moved — path differs from spec, boundaries identical); §8 errors/testing → per-task tests + Task 14 step 4; §9 phasing → Phases A–D with flag + final swap.
- Type names used consistently: `TranscriptEvent`, `AgentPhaseName`, `buildTranscript`, `groupEvents`, `buildMemoryPart`, `humanizeReflection`, `normalizeLegacyContent`, `useChatSession`, `RunState` (existing).
