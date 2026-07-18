# AI Ops Workspace Redesign — Design Spec

**Date:** 2026-07-18
**Branch:** `ai-ops-ui-refactoring`
**Status:** Approved by user (theme, plumbing depth, thinking UX, and page shell each confirmed individually; full design approved 2026-07-18)

## Problem

The AI Ops chat ("Mission Control", `/app/agent`) renders the agent's internal machinery at
full visual volume and the answer at the same or lower volume — the inverse of
industry-standard agentic UIs (Claude, Devin, ChatGPT). Specific defects observed in
production screenshots:

1. Phase banners (`MEMORY RECALL`, `PLANNING`, `EXECUTION`, `REFLECTION`, `MEMORY SAVE`)
   are full-width, all-caps, six-color headers. Nothing reads as important.
2. Raw internals leak into the transcript: reflector JSON (`"isComplete": false, ...`)
   rendered as text; tool inputs shown as double-escaped JSON.
3. One tool call = one bordered card + one repeated avatar + a repeated
   "Executing approved tool(s)..." caption. Ten calls ≈ two screens of scroll.
4. Contradictory status: rail says "Saving memory", plan badge says "Generating…",
   plan list shows 19/19 complete — simultaneously.
5. Plan rail steps are full verbatim CLI instructions; unscannable.
6. Composer crams 6+ pickers with truncated labels plus loose toggles.
7. Card-in-card nesting, double scrollbars, ALL-CAPS microcopy.

Root cause: presentation is welded to sentinel-string parsing
(`PLANNING_PHASE_START` etc. regexed out of streamed reasoning text) inside a
2,903-line `components/agent/chat-interface.tsx` monolith.

## Decisions (user-confirmed)

| Decision | Choice |
|---|---|
| Visual theme | **Devin-style product workspace** on existing shadcn/Tailwind tokens, light + dark |
| Streaming depth | **Full typed stream** — backend emits typed data parts; legacy sentinel threads get a quarantined client fallback |
| Internal narration | **Unified faded "Thinking" blocks** (Claude-style `▸ Thought for 12s`), auto-collapse, humanized prose (no raw JSON) |
| Session navigation | **Left session sidebar** with live status dots, replacing the browser-style tab bar |

## 1. Page shell & layout

Full-height 3-column workspace replacing the floating card + tab bar:

- **Left — session sidebar** (~260px, collapsible; hidden below `lg` behind a drawer):
  `+ New chat`, search, sessions grouped by date (Today / Yesterday / Older).
  Live status dots: green pulse = streaming, amber = awaiting approval/input.
  Concurrent sessions continue streaming in the background (existing multi-chat state
  is retained; only navigation changes). Replaces `ChatTabBar` + history popover.
- **Center — transcript** with slim header: session title, live phase stepper
  (`Plan ✓ · Execute ● 12/19 · Reflect · Revise`), elapsed timer, overflow menu
  (export, copy, convert-to-scheduled-task, delete — moved from the composer icon strip).
- **Right — run rail** (~300px, collapsible): Plan + Activity (see §4).
- Exactly one scroll container (the transcript). No nested cards, no double scrollbars.
  Transcript content column capped at ~48rem; expanded tool output may go wider.

## 2. Theme & visual language

- Existing shadcn/Tailwind token system; works in current light and dark modes.
  No new palette.
- **One accent** (existing `primary`) for active/running states with subtle pulse.
  Semantic green ✓ / red ✗ / amber ⚠ for terminal states only.
  The six-color phase rainbow is deleted.
- Geist Sans for everything; Geist Mono only in tool commands, I/O, code.
- Sentence case everywhere. Process chrome is `text-xs text-muted-foreground`.
- Depth via borders + `bg-muted/40` tints, not shadows. Process rows are borderless
  (hover state only); only answer blocks and interrupt cards get borders.

## 3. Transcript grammar

One avatar per agent turn, one container, ordered event list inside:

- **Thinking block**: all internal narration (planning commentary, reflection analysis,
  revision notes) collapses into a faded italic row `▸ Thought for 12s`.
  Streams expanded while live (shimmer), auto-collapses when the stretch ends.
  Expanded view: prose + small phase tag (`planning` / `reflection` / `revision`).
  Reflector JSON is humanized server-side (§6) — raw JSON never renders.
  Built on `components/ai-elements/reasoning`, restyled.
- **Tool rows**: one 28–32px row per call:
  `▸ ⚙ execute_command  aws lambda list-functions…  ✓ 2.3s`
  (icon, name, mono argument preview, status, duration). Expand → syntax-highlighted
  input/output panes; input decoded once (no escaped JSON). Consecutive *completed*
  calls collapse into `▸ Ran 6 commands ✓`; failed rows are never grouped away.
  Rejected tools render red (existing behavior, restyled).
- **Memory rows**: `▸ 🧠 Recalled 3 memories` / `▸ 💾 Saved 3 memories`, expandable
  to items. N consecutive saves = one row with count.
- **Interrupt cards**: existing `approval-batch-card`, `clarification-card`,
  `guard-risk-panel` survive restyled — the only high-emphasis elements in the flow.
- **Answer block**: full-opacity markdown, visual protagonist.
  All "Executing approved tool(s)..." captions deleted.
- **"Show work" toggle** per session: collapses all process rows to one-line summaries
  for an answers-only reading view.

## 4. Right rail

- **Plan**: short auto-derived step titles (first clause, ~8 words; full text on
  expand), progress bar + `n/N`, current step highlighted with spinner, completed
  dimmed with check. Badge, list, and stepper all derive from the same typed plan
  state — contradictory status is structurally impossible.
- **Activity**: current phase + current tool + transient states ("Saving memory…").
  Status has exactly one home per surface (stepper in header, detail in rail).
- Clicking a plan step scrolls the transcript to that step's events
  (events carry `stepIndex` when the executor provides it).

## 5. Composer

- Context chips above the input: account, model, skill — compact removable pills,
  full names in tooltips.
- One `+` popover: knowledge base, tool selection, attach images.
- One compact mode control left of Send (popover): Plan & Execute mode,
  auto-approve read-only tools, show tools.
- Input auto-grows 1→8 lines; char counter appears only near the limit.

## 6. Data flow — typed stream

`app/api/chat/route.ts` stops embedding sentinels in reasoning text and emits typed
UI-message parts (extending the existing typed `tool-input-*`/`tool-output-*` chunks
and the history-only `data-plan` pattern):

| Part | Payload | Replaces |
|---|---|---|
| `data-phase` | `{ phase, status }` | `*_PHASE_START` sentinels |
| `data-thinking` | reasoning deltas tagged with originating phase | reasoning-with-sentinels |
| `data-plan` | `{ steps: [{ title, detail, status }], revision }` — emitted live | client text-parsing of plan |
| `data-memory` | `{ op: 'recall' \| 'save', items }` | `MEMORY_*_PHASE_START` blocks |
| `tool-*` | unchanged (already typed) | — |

- Reflector output: the route already parses reflector JSON for plan updates; reuse
  that parse and emit only `analysis`/`suggestions` prose as `data-thinking`
  (tag `reflection`). Raw JSON never streams.
- **History**: the reload route reconstructs the same typed parts; persistence gains a
  versioned `parts` payload.
- **Legacy compat**: threads persisted with sentinel text run through a one-shot
  client normalizer (`lib/agent-chat/legacy-normalizer.ts`) producing the same typed
  events — the only file that knows sentinels. Threads with neither render as plain
  markdown (today's behavior).

## 7. Component architecture

Decompose `chat-interface.tsx` (2,903 lines); target ≤ ~300 lines/file:

```
components/agent/workspace/
  agent-workspace.tsx        — 3-column shell, session state
  session-sidebar.tsx        — list, search, status dots
  transcript-header.tsx      — title, stepper, timer, overflow menu
  transcript.tsx             — scroll container, message list
  agent-turn.tsx             — one turn: event list + answer
  events/thinking-block.tsx  — faded collapsible (wraps ai-elements/reasoning)
  events/tool-row.tsx        — row + expand + grouping
  events/memory-row.tsx
  events/approval-batch-card.tsx / clarification-card.tsx / guard-risk-panel.tsx (moved, restyled)
  run-rail.tsx               — evolved plan + activity
  composer.tsx               — input, chips, + popover, mode control
lib/agent-chat/
  events.ts                  — RunEvent types (shared with API route)
  legacy-normalizer.ts       — sentinel→typed fallback for old threads
  use-chat-session.ts        — per-session useChat wiring, approval state
```

`chat-interface.tsx` and `chat-tab-bar.tsx` are deleted at the end of the migration.

## 8. Errors, edge cases, testing

- Stream drop/resume, HITL interrupts mid-phase, rejected tools: all render from
  typed events with explicit statuses — no inference from text.
- Tests:
  - Vitest: `events.ts` reducers; `legacy-normalizer` (fast-check property tests
    over sentinel corpora); tool-row grouping; thinking auto-collapse.
  - Existing `__tests__` for approval/clarification cards updated in place.
  - Playwright smoke: send message → thinking block, tool row, and answer render.

## 9. Implementation approach

Build the new workspace alongside the old UI (new components + route-level flag),
migrate the stream to typed parts with the legacy path intact, swap the page, delete
the old components. Each phase leaves the app shippable:

1. Typed stream + `RunEvent` model (+ legacy normalizer)
2. Transcript grammar (agent-turn, thinking, tool rows, memory rows, answer)
3. Shell (session sidebar, transcript header/stepper, run rail)
4. Composer + polish (show-work toggle, animations, empty states)
5. Swap page over; delete `chat-interface.tsx`, `chat-tab-bar.tsx`, legacy styles
