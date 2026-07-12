# AIOps Chat Overhaul — Design

**Date:** 2026-07-12
**Status:** Approved by user (brainstorming session, visual companion mockups)
**Scope:** The AI Ops chat module (`/app/agent`) — fast + planning agents, `/api/chat`, `chat-interface.tsx`. Deep agent and Agent Ops scheduled runs are out of scope except where they share code.

## Problem

Five confirmed gaps (file:line evidence from exploration):

1. **Plan never updates in the UI.** The structured `plan: PlanStep[]` lives in LangGraph state (`agent-shared.ts:56-71`) and is correctly advanced by the generate node (`planning-agent.ts:272-282`) and revised by the reflector (`planning-agent.ts:514-516`) — but only the planner's one-time rendered text reaches the stream. The client re-parses that static text and hardcodes step 0 as `active`, everything else `pending` (`chat-interface.tsx:1146`). Steps never check off.
2. **Approving one tool runs the whole batch.** Approval is per-interrupt, not per-tool-call: clicking "Approve & Run" sends a `role:'tool'` message whose only effect is resuming the interrupt (`route.ts:256-270`); LangGraph then executes every queued `tool_call`. The `toolCallId` is ignored on the approve path. The only mitigation is prompt text telling the model not to batch (`prompt-templates.ts:209-214`).
3. **No clarification mechanism.** Chat agents cannot ask the user a question mid-run. (Agent Ops has evaluator→clarify→`awaiting_input`, but it resumes by re-running, not by interrupt resume.)
4. **No destructive-action guard.** Nothing classifies or blocks mutative tool calls in chat; with auto-approve on, the agent can terminate instances unprompted. (Agent Ops has a reusable `tool-classifier.ts` + `mutative_approval_gate` pattern.)
5. **Dated UI/UX.** Phase info is smuggled as text prefixes inside `reasoning` stream parts (`route.ts:628-639`, parsed at `chat-interface.tsx:140-175`); the run experience is a flat list of boxes; `chat-interface.tsx` is ~2,300 lines.

## Decisions (locked with user)

| Decision | Choice |
|---|---|
| UI scope | Full-page redesign |
| Layout | **Mission Control two-pane**: conversation left, persistent live run rail right |
| Stream style | **Threaded timeline** — chronological nodes on a vertical spine with status dots (consistent with Agent Ops run timeline) |
| Batch approvals | **Per-tool decisions + Approve/Reject remaining**; run resumes only when every tool in the batch is decided |
| Guard policy | **Force approval for mutative calls even when auto-approve is on**; read-only flows freely |
| Clarification | **`ask_user` tool available anytime** (fast + plan modes), interrupt-based resume |
| State transport | **Typed data parts** on the existing Vercel AI SDK UI Message Stream (`data-plan`, `data-phase`, `data-approval`, `data-clarification`) — replaces text-marker smuggling |
| Interaction cards | Amber batch-approval card, blue clarification card (chips + free text), red guard card (severity / action / blast radius / reversibility / safer path; "Approve anyway / Reject / Use safer path") — mockups approved |

## Architecture

### Graph changes (fast-agent + planning-agent)

Two new nodes between the model node (`generate`/`agent`) and `tools`:

```
generate/agent ──► guard ──► router ──► tools                    (all safe + auto-approve)
                                  └───► approval_gate ──► tools  (interrupt here)
```

**`guard` node** — runs on every turn that produced tool calls:

- **Deterministic pass:** `tool-classifier.ts` moves from `lib/agent-ops/` to a shared location under `lib/agent/` (Agent Ops re-imports from there; no behavior change). Read-only allowlist first, then mutative bash patterns, then name patterns.
- **LLM risk assessment** (reflector-tier model, single batched call) **only for calls classified mutative**: produces `{severity: LOW|MEDIUM|HIGH, action, blastRadius, reversible, saferPath}` per mutative call. Read-only runs incur zero extra LLM cost.
- Writes `guardVerdicts: Record<toolCallId, GuardVerdict>` into graph state.
- **Fail-closed:** unknown tools, classifier errors, or LLM failures ⇒ treated as mutative / HIGH.

**`approval_gate` node + router** — the graph always compiles with `interruptBefore: ["approval_gate"]` (replaces the conditional `interruptBefore: ["tools"]`). The router sends flow to `approval_gate` when ANY of:

- any tool call is classified mutative (regardless of auto-approve), or
- auto-approve is off, or
- any tool call is `ask_user`.

Otherwise flow goes straight to `tools`. This makes the destructive guard un-bypassable: auto-approve never routes mutative calls past the gate. The gate node itself is a no-op marker; the interrupt is the mechanism.

### Per-tool batch approval

- At the interrupt, the server emits one `data-approval` part: `{batchId, tools: [{toolCallId, name, args, guard?: GuardVerdict}]}`.
- The client records a decision per tool; the resume request carries `decisions: {[toolCallId]: 'approved' | 'rejected'}`. The server returns 400 on partial batches.
- On resume: each rejected id gets a `ToolMessage("Rejected by user" [+ safer-path reason])` written via `graph.updateState` (existing plumbing); then the graph resumes.
- **`collectingToolNode` change:** skip any `tool_call` that already has a `ToolMessage` result in state. This — not prompt text — is what prevents rejected/answered calls from executing.
- Prompt guidance is relaxed: the agent may batch read-only calls; the "one tool at a time" HITL handcuff is removed.

### Clarification — `ask_user` tool

- New tool in `tools.ts`: `ask_user({question: string, options?: string[]})`. It has no server-side execution body used in practice — the router always sends it to `approval_gate`.
- The server recognizes a pending `ask_user` call at the interrupt and emits `data-clarification` (`{toolCallId, question, options}`) instead of including it in the approval batch.
- The user's answer (chip click or free text) resumes the run with the answer written as that call's `ToolMessage` — identical mechanism to reject. Works at any point in the run, in both modes, regardless of auto-approve.
- Mixed batches (ask_user + normal tools in one turn) are handled: clarification card + approval card render together; resume happens once when everything is decided/answered.

### Live shared plan

- `plan: PlanStep[]` in graph state remains the single canonical plan — planner creates, generate advances, reflector revises. (Already true server-side; unchanged.)
- `processStream` watches `on_chain_end` for `planner`, `generate`, `reflect`, `revise`; whenever the node output contains a `plan`, it emits a **`data-plan` part with a stable part id** carrying the full snapshot `{steps: [{step, status}], updatedBy}`. The AI SDK reconciles same-id data parts in place ⇒ the UI updates rather than duplicating.
- The planner's "📋 Plan Created" rendered-text blob is removed; the UI renders plan state exclusively from `data-plan`.
- Phase transitions become `data-phase` parts (`{phase, node}`); the `PLANNING_PHASE_START\n`-style text markers are no longer emitted. The client keeps the legacy text parser only for rendering historical threads.

### Streaming protocol summary

Existing UI Message Stream (SSE via `createUIMessageStreamResponse`) plus four typed custom parts:

| Part | Payload | Reconciliation |
|---|---|---|
| `data-plan` | full plan snapshot + updatedBy | stable id per run — replaced in place |
| `data-phase` | `{phase, node, ts}` | appended |
| `data-approval` | `{batchId, tools: [{toolCallId, name, args, guard?}]}` | stable id per batch — replaced when decisions land |
| `data-clarification` | `{toolCallId, question, options?}` | stable id per call |

Text/reasoning/tool-* parts continue as today.

### Persistence & resume

- Data parts persist with message parts in chat history so reloaded threads show final plan state and past decisions.
- New behavior on thread load: if the graph is interrupted, a pending-state lookup (from `graph.getState()`) re-emits the outstanding `data-approval`/`data-clarification` so a mid-approval refresh restores the actionable card instead of a hung run.
- **Audit:** every approve/reject decision on a mutative call goes through `AuditService` (user, tool name, args hash, guard severity, decision, threadId).

## Frontend

### Component architecture (decomposing `chat-interface.tsx`)

New structure under `components/agent/chat/`:

| Component | Responsibility |
|---|---|
| `chat-layout.tsx` | Two-pane Mission Control shell; right rail collapses below `lg` into a header status strip (phase chip · plan progress · approvals badge) |
| `chat-thread.tsx` | Message list: user bubbles + run timelines |
| `run-timeline.tsx` | Threaded spine — phase nodes and tool nodes with status dots (done / active-pulsing / failed) |
| `run-rail.tsx` | Live execution plan with check-off, activity feed (pending approvals, guard status), run context (account · model · tools · skill · KB) |
| `approval-batch-card.tsx` | Amber card: per-tool Approve/Reject with live decision states + "Approve remaining" / "Reject remaining" |
| `clarification-card.tsx` | Blue card: question, option chips, free-text answer |
| `guard-risk-card.tsx` | Red card: severity / action / blast radius / reversibility / safer path; "Approve anyway / Reject / Use safer path" (safer-path rejects with the suggestion as the reason so the agent adapts) |
| `composer.tsx` | Input + mode/model/account/skill/KB pickers; auto-approve toggle relabeled **"Auto-approve read-only tools"** (its honest new meaning) |
| `use-run-state.ts` | Hook deriving run state (plan, current phase, pending batch, timings) from typed data parts — the single source both panes render from |

- Existing `ai-elements` primitives (`tool.tsx`, `plan.tsx`, `reasoning.tsx`, `confirmation.tsx`) are kept and restyled/extended, not rebuilt.
- Old persisted threads (text markers, no data parts) render via the legacy parser fallback.
- Styling follows existing conventions: Tailwind + `cn()`, Radix primitives, Geist, framer-motion for rail/card transitions (respecting reduced motion).

## Error handling

- Guard LLM failure / unknown tool ⇒ fail-closed (mutative, HIGH, approval required).
- Partial decision batch on resume ⇒ 400 (the UI can't submit partial batches anyway).
- Stream drop mid-run ⇒ LangGraph checkpointer holds state; pending-interrupt restore on reload.
- All-rejected batch ⇒ agent receives denials as tool results and must adapt or finish — no dead-end.
- `ask_user` with empty answer ⇒ client blocks submit; server treats empty as no-op and keeps waiting.

## Testing

- **Vitest:** guard classification incl. fail-closed paths; router matrix (safe/mutative × auto-approve on/off × ask_user); `collectingToolNode` skips resolved calls; resume decision handling incl. partial-batch 400; `data-plan` emission on planner/generate/reflect outputs; `use-run-state` derivation.
- **Playwright E2E:** mixed batch (approve one, reject one) executes only the approved tool; clarification chip answer resumes the run; plan steps visibly check off during a plan-mode run; mutative call pauses despite auto-approve on.

## Delivery

One branch, two reviewable phases:

1. **Backend protocol + graph changes** land first behind the existing UI — fixes the correctness bugs (batch approval, guard, plan emission, ask_user) with minimal UI wiring.
2. **Redesigned UI** switches over to the typed parts and new layout.

## Out of scope

- Deep-agent graph changes (only fast + planning).
- Agent Ops scheduled-run UI (already has its own timeline; shares the relocated classifier).
- Per-tenant approval policies / RBAC-gated severity thresholds (listed as future work).

## Appendix: Future AIOps ideas (non-normative, surfaced during design)

- Per-tenant approval policy: which roles may approve HIGH-severity actions; org-level read-only "safe mode".
- Dry-run / cost-impact preview attached to mutative approvals (what changes, projected cost delta).
- Event-triggered runs (CloudWatch alarm → agent run) complementing existing cron scheduling.
- Multi-account fan-out queries in chat ("check certs across all prod accounts").
- Run permalinks / shareable post-mortem summaries; export run to Slack.
- Approval analytics: how often the guard fires, rejection rates, per-tool risk history.
