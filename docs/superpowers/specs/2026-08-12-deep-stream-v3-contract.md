# Deep stream v3 migration — the UI contract

Step 1 of the #3 plan. This is the checklist `processDeepStream` must satisfy and the
spec its tests are written against. Nothing here is aspirational: every row was read out
of the current `processStream` in `apps/web-ui/app/api/chat/route.ts`.

## Safety property

`processStream` is **not modified**. Fast and Plan keep executing it byte-for-byte.
Deep gets a new `processDeepStream`, selected by one conditional:

```ts
mode === 'deep' ? processDeepStream(...) : processStream(...)
```

Reverting = flipping that conditional. Fast/plan cannot regress because their code
does not change.

## The contract

Every chunk the client can receive, the condition that produces it, and where deep gets
it from on v3.

| # | Chunk | Emitted when | Source today | Source on v3 |
|---|---|---|---|---|
| 1 | `start` | stream opens | `:932` | same |
| 2 | `data-active-skill` | a skill was resolved for the run | `:937` | same (pre-stream, unchanged) |
| 3 | `text-start/delta/end` "Executing approved tool(s)…" | `isResumedFromApproval` | `:947-949` | same |
| 4 | `tool-input-start` + `tool-input-available` + `tool-output-available` (synthetic) | rejected tools and `ask_user` answers on resume — they never execute, so no tool events fire | `:960-962` | same |
| 5 | `data-usage` | subagent model end | `:1002` | `stream.subagents` token totals |
| 6 | `data-usage` | main model end, when in/out tokens present | `:1104` | run usage events |
| 7 | `data-phase` | every `on_chat_model_start`, from `getPhaseFromNode` | `:1010` | **drop** — deep has no named phases (see Notes) |
| 8 | `data-phase` `('planning','deep_todos')` | deep emitted todos | `:1306` | derived from `stream.values.todos` |
| 9 | `text-start/delta/end` | live prose from execution/final phases | `:1036,1064,1108` | `stream.messages` |
| 10 | `text-start/delta/end` (buffered flush) | buffered phase produced prose | `:1076-1077,1151-1153` | `stream.messages` (deep streams live; no buffering) |
| 11 | `reasoning-start/delta/end` | reflection / planning / other buffered phases, humanized | `:1131-1148` | **drop** — deep has no reflector/planner nodes |
| 12 | `data-memory` | `currentPhase` is `memory_recall`/`memory_save` **and** run text non-blank | `:1116` | `method:"custom"` events from `runtime.writer` |
| 13 | `data-memory` | via `memorySinkRef` callback | `:913` | **delete** — replaced by 12 |
| 14 | `tool-input-start` + `tool-input-available` | HITL: pending tool calls at `on_chat_model_end` | `:1167-1168` | `stream.toolCalls` |
| 15 | `tool-input-start` + `tool-input-available` | `autoApprove` **or** deep-ungated tool, at `on_tool_start`, keyed by `run_id` | `:1202-1203` | `stream.toolCalls` (framework pairs them) |
| 16 | `tool-input-start` + `tool-input-available` | resumed-from-approval, keyed by **original** `tool_call_id` | `:1216-1217` | `stream.toolCalls` + resume map |
| 17 | `tool-output-available` | `on_tool_end`, id resolved per the three cases above | `:1257` | `stream.toolCalls` |
| 18 | `data-plan` | plan mode: node output carries `plan` | `:1301` | n/a (plan mode only) |
| 19 | `data-plan` | deep: node output carries `todos` | `:1305` | `stream.values.todos` |
| 20 | `data-approval` | interrupt pending, non-`ask_user` calls | `:1346` | `__interrupt__` / `state.tasks[].interrupts` |
| 21 | `data-clarification` | interrupt pending, `ask_user` calls | `:1351` | same |
| 22 | `data-subagent` | `subagentSinkRef` + heartbeat re-emission | `:912,927` | `stream.subagents` |
| 23 | `text-start/delta(' ')/end` | nothing else was emitted — AI SDK requires text or a pending tool call | `:1371-1373` | same |
| 24 | `finish` | normal completion | `:1377` | same |
| 25 | `error` | caught stream error | `:1404` | same |

## Notes that decide behaviour

- **Rows 7 and 11 are dropped for deep, deliberately.** They are driven by
  `getPhaseFromNode`, which matches node names produced by the fast/plan graphs
  (`planner`, `reflection`, `revision`, …). Deep has none of those. The
  `DeepMemoryMiddleware.before/after` matching added to that function is the string
  matching this migration removes.
- **Row 15 carries the bug fixed in the previous commit**: deep gates per-tool via
  `DEEP_INTERRUPT_TOOLS`, so an ungated tool executes with `autoApprove` off and never
  passes through the approval flow that emits its input. On v3 this class of mismatch
  cannot occur — `stream.toolCalls` pairs input and output itself.
- **Row 16 is the highest-risk row.** `ActionRequest` carries no id
  (`langchain/dist/agents/middleware/hitl.d.ts:158-171`) and the docs map decisions
  positionally, so the original tool_call_id has to be recovered by zipping the last AI
  message's `tool_calls` (filtered by `interruptOn`) against `actionRequests`. Rows 20,
  21 and 4 depend on the same zip.
- **Ordering matters for rows 20/21**: `deriveRunState` resets stale clarifications when
  a `data-approval` arrives, so the approval part must precede clarifications from the
  same interrupt. An empty-tools `data-approval` is still emitted for an `ask_user`-only
  interrupt, or the previous turn's batch resurrects and deadlocks the submit.

## Verified v3 facts this rests on

Measured, not inferred (see `docs/research/deepagents-js-api.md` §11b):

- `await agent.streamEvents(input, { version: "v3" })` → `GraphRunStream` with
  `messages`, `subagents`, `toolCalls`, `values`, `extensions`; async-iterable.
  **Must be awaited** — without `await` it is not iterable and has no projections.
- `runtime.writer` is a function on the middleware runtime.
- Writer payloads are invisible on v2 and surface on v3 as
  `{"type":"event","method":"custom","params":{"data":{"payload":…}}}`.

## Step order

Each step commits separately, so any one is revertible without losing the others.

1. **This document.**
2. `processDeepStream` skeleton on v3 — rows 1, 9, 23, 24, 25 only.
3. Tool cards — rows 14, 15, 17.
4. Subagent cards — rows 5, 22.
5. Plan rail — rows 8, 19.
6. Memory cards — row 12; delete row 13 and the `getPhaseFromNode` deep matching.
7. Approval / clarification / resume — rows 3, 4, 16, 20, 21.
8. Verification matrix.

## Verification matrix (step 8)

Manual, in the UI, deep mode:

1. auto-approve **on**, simple question → text only, no stray cards
2. auto-approve **on**, AWS query → tool cards pair correctly
3. auto-approve **off**, read-only tool (`aws_read`) → runs, card pairs, **no "No tool invocation found"**
4. auto-approve **off**, `execute_command` → approval card → Approve → executes under the original card
5. auto-approve **off** → Reject with a reason → agent adapts, does not retry verbatim
6. `ask_user` → clarification → answer → run resumes
7. multi-step task → plan rail populates and updates
8. delegated task → subagent card opens and resolves
9. reload mid-approval → card still present and decidable
10. **Fast and Plan**: same thread, verify approval, plan rail, subagent and memory cards behave exactly as before
