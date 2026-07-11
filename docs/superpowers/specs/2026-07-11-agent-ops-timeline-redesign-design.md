# Agent Ops Run Timeline Redesign — Design

**Date:** 2026-07-11
**Branch:** `agent-ops-right-size`
**Status:** Approved (brainstorm with user; layout chosen visually)

## Problem

The Agent Ops run-detail page (`apps/web-ui/app/app/agent-ops/[runId]/page.tsx`, 574-line
single component) renders every `AgentOpsEvent` as a full-width block in a flat list:
tool calls and their results are separate blocks, verbose output is expanded by default,
and there is no phase structure. It refreshes by silent 5-second full re-fetch.

Worse, the timeline *cannot* show the agent's cognitive machinery: the
`memory_recall`/`memory_save` graph nodes are skipped by the executor's node→event map,
and skill/KB selection is buried in a `planning` event's metadata. Users conclude memory
and skills aren't wired into Agent Ops at all (they are — it's purely an observability gap).

The Agent Ops list page (`apps/web-ui/app/app/agent-ops/page.tsx`) additionally has a
broken hero header (title/subtitle wrap one word per line) and bare run cards.

## Decisions made with the user

| Question | Decision |
| --- | --- |
| Scope | Run-detail page **and** list page. `[runId]/respond` page is out of scope. |
| Live updates | **SSE stream** (DB-backed), with TanStack Query polling fallback. |
| Layout | **Hybrid A+B** (chosen from visual mockups): grouped step timeline (Devin-style collapsed one-line steps, tool call+result merged, contiguous work folded into groups) with the agent's thinking rendered as **narrative bubbles** between steps (Claude-app style). |

## Goals

1. Every cognitive step visible: memory recall (with hit counts/keys/distances), skill +
   KB selection, tool calls, thinking, reflections, revisions, final, memory save.
2. Modern agentic-AI reading experience: scannable collapsed steps, narrative thinking,
   live streaming with entry animations, auto-collapse of verbose output.
3. Repo-convention alignment: TanStack Query hooks, sonner toasts, framer-motion,
   existing Radix/shadcn primitives. No new UI framework or component library.

## Non-goals

- `[runId]/respond` deep-link page redesign (stays functional via unchanged APIs/types).
- Channel streaming (emitting `run:event` to Slack/Telegram adapters) — separate effort.
- Memory save on failed/cancelled runs — separate effort.
- Removing the existing `GET /api/agent-ops/[runId]` polling route (kept as fallback).

---

## Part 1 — Backend: complete event coverage

### 1.1 New event types

`AgentEventType` (`apps/web-ui/lib/agent-ops/types.ts`) gains:

```ts
| 'memory_recall'   // recorded from the memory_recall node
| 'memory_save'     // recorded from the memory_save node
| 'evaluation'      // replaces the evaluator's generic 'planning' event
```

Existing eight types are unchanged; old runs render as before.

### 1.2 Structured memory stats from the shared memory nodes

`lib/agent/memory-nodes.ts` currently returns only `memoryContext: string` — nothing
structured to record. Both nodes additionally return a `memoryStats` state field:

```ts
// recall
memoryStats: {
  phase: 'recall';
  facts: Array<{ key: string; distance?: number }>;
  rules: Array<{ key: string; distance?: number }>;
  episodes: Array<{ key: string; distance?: number }>;
  injected: boolean;            // memoryContext non-empty
}
// save
memoryStats: {
  phase: 'save';
  savedFacts: number;
  savedRules: number;
  episodeCaptured: boolean;
  reconcileActions?: Record<string, number>;  // e.g. { ADD: 2, REINFORCE: 1 }
}
```

LangGraph throws `InvalidUpdateError` for undeclared channels, so the `memoryStats`
channel is **declared in every graph state that uses these nodes**: the Agent Ops
executor state (`lib/agent-ops/executor-state.ts`, alongside its existing
`memoryContext` channel), the chat agents' `ReflectionState` (`lib/agent/agent-shared.ts`),
and the shared `MemoryNodeState` type (`lib/agent/memory/types.ts`, as optional).
Chat agents simply ignore it — pure additive, zero behavior change.

### 1.3 Executor records the new events

`agent-executor.ts`'s stream loop maps node updates to `recordEvent` calls; it currently
skips `memory_recall`/`memory_save`. Changes (both the initial-run and resume loops):

- `memory_recall` node update → `recordEvent({ eventType: 'memory_recall', node,
  content: "Recalled N memories — X facts · Y rules · Z episodes" (or "No relevant
  memories found"), metadata: memoryStats })`.
- `memory_save` node update → `recordEvent({ eventType: 'memory_save', node,
  content: "Saved N memories · episode captured", metadata: memoryStats })`.
- Evaluator node update → the existing recordEvent switches `eventType` to
  `'evaluation'` with metadata `{ mode, skillId, skillName, knowledgeBaseIds,
  requiresApproval }`. `RequestEvaluation` gains `skillName` (the evaluator already
  holds the loaded skill list; carry the display name through).

Per-step duration is **computed client-side** from adjacent event timestamps — not stored.

### 1.4 SSE stream route

New `GET /api/agent-ops/[runId]/stream/route.ts`:

- Auth/tenant handling identical to the existing `GET /api/agent-ops/[runId]` route.
- **DB-backed** (replica-safe — the in-process event bus can't be trusted across ECS
  replicas): a server loop every ~1.5s reads `AgentOpsEvent` rows newer than the cursor
  (ordered by SK/sequence) and the run row; pushes frames:
  - `event: run-event` — one frame per new `AgentOpsEvent` (JSON).
  - `event: status` — whenever run status/result/error changes.
  - `: heartbeat` comment every 15s.
- Closes after pushing the terminal `status` frame (completed/failed/cancelled), or at a
  15-minute hard cap (client transparently reopens if the run is still active).
- `export const runtime = 'nodejs'` + `dynamic = 'force-dynamic'`; `ReadableStream`
  response with `text/event-stream` headers; loop aborts on `request.signal`.

---

## Part 2 — Frontend

### 2.1 Component structure

New directory `apps/web-ui/components/agent-ops/run-timeline/`; the `[runId]/page.tsx`
shrinks to a thin shell (header + HIL/result panels + `<RunTimeline>`).

| File | Responsibility |
| --- | --- |
| `run-header.tsx` | Sticky compact header replacing the five metadata cards: animated status pill, truncating task description, chip row (source · mode · skill · account · duration · tokens ↑↓), actions (Cancel / Export PDF / live indicator). |
| `timeline.tsx` | Renders `TimelineStep[]` from `buildSteps`; owns auto-scroll (follows newest step; pins on user scroll-up with a "Jump to latest ↓" chip); framer-motion entry animations; running-step pulse. |
| `build-steps.ts` | **Pure function** `buildSteps(events: AgentOpsEvent[], runStatus): TimelineStep[]`. Unit-testable grouping logic (see 2.2). |
| `memory-step.tsx` | "Recalled 4 memories — 2 facts · 1 rule · 1 episode" one-liner; expands to per-item keys + distances. Save variant at the end of the run. |
| `evaluation-step.tsx` | "Evaluated request" with pills: mode, skill name, KB names/ids, approval-required. |
| `tool-step.tsx` | Merged call+result: collapsed one-liner (icon, tool name, ✓ / ✗ / ● running, duration); expands to args (pretty JSON) + output, each in scrollable `overflow-auto` blocks with copy buttons. |
| `thinking-bubble.tsx` | B-style narrative bubble for thinking content, rendered between steps (markdown, muted/italic styling). |
| `reflection-step.tsx` | Reflection/revision steps with verdict pill (e.g. "needs revision"). |
| `final-step.tsx` | Final summary step (markdown), visually distinct terminal marker. |
| `working-group.tsx` | Collapsible group wrapper: "Working — n steps · duration". |
| `use-run-stream.ts` | Hook: opens the SSE stream while run is active; appends frames into the TanStack Query cache; falls back to 2s polling on stream error (with stream retry/backoff); stops all refetching on terminal status. |

Data hooks in `apps/web-ui/lib/queries/agent-ops.ts` (+ `query-keys.ts` entries):
`useAgentOpsRuns(filters)`, `useAgentOpsRunDetail(runId)`, and mutations
(`useCancelRun`, `useApproveRun`, `useResumeRun`) with cache invalidation and sonner
toasts — replacing all hand-rolled `fetch` + `setInterval` in both pages.

### 2.2 Grouping algorithm (`buildSteps`)

1. **Pairing:** each `tool_call` pairs with the next `tool_result` whose `toolName`
   matches (in order) → one `ToolStep`. An unpaired `tool_call` is `running` if the run
   is active, else `unknown-outcome`.
2. **Thinking promotion:** `execution` events with `metadata.contentType === 'thinking'`
   (and generate-node narration) → `ThinkingBubble` items in-place.
3. **Structural steps:** `memory_recall`, `evaluation`, `planning`, `reflection`,
   `revision`, `final`, `memory_save`, `error` map 1:1 to dedicated steps.
4. **Folding:** contiguous runs of ToolStep/ThinkingBubble between structural steps
   form a `WorkingGroup` (header: step count + summed duration). The group containing
   the running step or an error is auto-expanded; earlier groups are collapsed.
5. **Defaults:** every step collapsed except the currently-running step and errors.
6. **Compatibility:** runs recorded before the new event types simply lack
   memory/evaluation steps; everything else renders identically.

### 2.3 HIL panels

Clarification and approval panels keep their exact logic/endpoints but move **inline to
the bottom of the timeline** where the run paused, so "agent asked → you answer" reads
in sequence. Restyled to match the step design language.

### 2.4 List page

- Fix the broken hero header (constrained-width flex bug causing one-word-per-line wrap).
- Run cards: status icon + colored accent edge, task preview (2-line clamp), chips
  (source, mode, skill when present), relative time + duration, live pulse on
  in-progress. Existing source/status filters and stats cards stay.
- Data via the new TanStack Query hooks (`refetchInterval` only while any run is active).

### 2.5 PDF export

`export-pdf.ts` gains styling entries for the three new event types so exported runs
include memory/evaluation steps. No structural change.

---

## Part 3 — Error handling

- **SSE failure** → hook closes the stream, falls back to 2s polling, retries the
  stream with exponential backoff (cap 30s). Malformed frames are dropped silently.
- **Terminal state** → stream closed server-side; client stops polling entirely.
- **Action failures** (cancel/approve/resume) → sonner error toasts with the API error
  string (today they're swallowed).
- **Run not found** → existing empty-state retained.

## Part 4 — Testing

- **Unit (vitest):** `build-steps.test.ts` — pairing, unmatched running call, folding,
  thinking promotion, structural mapping, pre-redesign event streams (compat).
- **Executor:** extend agent-executor tests to assert `memory_recall`/`memory_save`/
  `evaluation` events are recorded with expected metadata when nodes emit `memoryStats`.
- **Memory nodes:** assert `memoryStats` is returned and that chat graphs still compile
  (channel declared in `ReflectionState`).
- **Regression:** web-ui tsc stays at its pre-existing baseline (182); existing
  agent-ops tests keep passing.
- Manual smoke: live run via scheduled task; verify streaming, HIL inline panels,
  old-run rendering, list page.

## Rollout / compatibility

- No schema migration: `AgentOpsEvent` already stores arbitrary `metadata` JSON; new
  event types are additive strings.
- Old runs and the untouched `respond` page keep working (types are additive).
- No feature flag: the pages are self-contained; fallback path (polling) is the
  pre-existing behavior.
