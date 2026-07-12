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
| State transport | **AI SDK 7** UI Message Stream: **native tool-approval parts** for the approval flow + **typed data parts** (`data-plan`, `data-phase`, `data-guard`, `data-clarification`) for everything else — replaces text-marker smuggling |
| SDK version | **Upgrade `ai` / `@ai-sdk/*` from v5 to v7 as Phase 0** (codemod-assisted), unlocking native approvals, batch auto-resume, and fixed `useChat` stale-closure behavior |
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

### AI SDK 7 upgrade (Phase 0)

The web-ui `ai` / `@ai-sdk/*` packages upgrade from v5 to **v7** before feature work (`npx @ai-sdk/codemod v7`, then manual review of stream-helper usage and part shapes). Motivation:

- **Native tool approvals** — v7 makes approvals a first-class protocol primitive: tool parts stream with `state: 'approval-requested'` and an `approval.id`; the client responds via `useChat`'s `addToolApprovalResponse({id, approved})`; parts transition to `output-available` / `output-denied`. This replaces the custom `data-approval` part + bespoke decisions POST from the original draft.
- **Batch semantics for free** — `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses` submits the resume request only once *every* approval in the step is decided: exactly the per-tool + "run continues when all decided" card we designed.
- **`useChat` fixes** — callbacks see current props/state (kills a class of stale-closure bugs in the 2,300-line component we're decomposing); async `sendAutomaticallyWhen`.

Our server stays LangGraph (we do not adopt `ToolLoopAgent`/`WorkflowAgent` — `processStream` keeps hand-mapping `streamEvents` to UI chunks). We emit v7's native approval-request chunks from the `approval_gate` interrupt with `approval.id = toolCallId`. **Fallback:** if hand-emitting native approval chunks from a non-`streamText` server proves unsupported in practice, the custom `data-approval` part design below remains the escape hatch — same UX, more custom protocol.

### Per-tool batch approval

- At the interrupt, the server emits one v7 approval-request part per pending tool call (`approval.id = toolCallId`), plus a `data-guard` part per mutative call carrying its `GuardVerdict` (rendered inside the same card).
- The client records a decision per tool via `addToolApprovalResponse`; the SDK auto-submits the resume request when all are decided (server still validates completeness; 400 on partial batches).
- On resume: the route reads the approval responses from the submitted message; each denied id gets a `ToolMessage("Rejected by user" [+ safer-path reason])` written via `graph.updateState` (existing plumbing); then the graph resumes.
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

AI SDK 7 UI Message Stream (SSE via the v7 stream helpers). Approvals use the **native v7 approval protocol** (approval-requested tool parts → `addToolApprovalResponse` → `output-available`/`output-denied` states). On top of that, three typed custom parts:

| Part | Payload | Reconciliation |
|---|---|---|
| `data-plan` | full plan snapshot + updatedBy | stable id per run — replaced in place |
| `data-phase` | `{phase, node, ts}` | appended |
| `data-guard` | `{toolCallId, severity, action, blastRadius, reversible, saferPath}` | stable id per toolCallId |
| `data-clarification` | `{toolCallId, question, options?}` | stable id per call |

(`ask_user` stays a custom part because its answer is free text, not a boolean approve/deny.) Text/reasoning/tool-* parts continue as today, migrated to v7 shapes.

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

One branch, three reviewable phases:

0. **AI SDK 7 upgrade** — codemod-assisted bump of `ai`/`@ai-sdk/*`, adapt `processStream` chunk emission and `useChat` call sites, verify existing chat behavior is unchanged.
1. **Backend protocol + graph changes** land behind the existing UI — fixes the correctness bugs (batch approval via native v7 approvals, guard, plan emission, ask_user) with minimal UI wiring.
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
