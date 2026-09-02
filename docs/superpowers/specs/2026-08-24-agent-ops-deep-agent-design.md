# Deep Agent Framework in Agent Ops — Design

**Date:** 2026-08-24
**Branch:** `Agent-Ops-DeepAgent` (from `origin/uat` @ `589d13e7`)
**Status:** Approved design, not yet implemented

## Problem

The `deepagents` framework is implemented for AI Ops (Mission Control chat, `mode: 'deep'`)
but not for Agent Ops. Agent Ops runs on a hand-built `StateGraph`
(`createDynamicExecutorGraph`) and cannot use sub-agents, the virtual filesystem,
`write_todos`, or per-action HITL.

This design adds deep as a **third, opt-in mode** for Agent Ops, mirroring how AI Ops keeps
`fast` / `plan` / `deep` side by side. The existing plan graph is untouched and remains the
default.

## Baseline: what deep looks like today

Authoritative implementation is `apps/web-ui/lib/agent/deep-agent.ts` → `createDeepGraph()`,
reached from `/api/chat` when `mode === 'deep'`.

| Concern | Implementation |
|---|---|
| Framework | `createDeepAgent()` from `deepagents` |
| Sub-agents | Three: `aws-ops`, `research`, `code-iac` |
| Backend | `CompositeBackend(FilesystemBackend{rootDir: tenantWorkdir, virtualMode: true}, {'/memories/': StoreBackend})` |
| Durable notes | `memory: [AGENTS_MD_PATH]` (`/memories/AGENTS.md`) over `PostgresFileStore` (`agent_files`) |
| Todos | `todoListMiddleware()` — **opt-in since deepagents v0.7**; without it the `todos` channel does not exist |
| Memory | `createDeepMemoryMiddleware` wrapping `createMemoryRecallNode` / `createMemorySaveNode`, with an `onMemoryEvent(op, summary)` sink |
| Skills | `createLoadSkillTool` progressive disclosure + prompt catalog, gated by `autoLoadSkills !== false`. **No `skills:` option, no disk materialisation** |
| HITL | `interruptOn` per tool (`execute_command`, `write_file`, `edit_file`, `ask_user`) → `lib/agent/deep/hitl.ts` |
| Streaming | `streamEvents({version: 'v3'})` → `processDeepStream` |

`lib/deep-agent/` (MongoDB checkpointer, `/app/deep-agent` page, `/api/deep-agent/*`) is a
**legacy fork** nothing else imports. It is not a porting source.

### Corrections against `master-v1`

`origin/uat` includes PR #46 (`rework/deep-agent-memories`). Three things changed:

1. **Skills are no longer materialised to disk.** `materializeSkills` still exists in
   `workdir.ts` but `deep-agent.ts` no longer calls it. Skills load through the `load_skill`
   tool so the load becomes a named, persisted tool card.
2. **Deep now has automatic memory.** It reuses the *same* recall/save nodes the Agent Ops
   plan graph uses as graph nodes, wrapped as middleware.
3. **Todos are opt-in.** `todoListMiddleware()` must be passed explicitly.

`save_memory` is deliberately **excluded** from the deep toolset (only `search_memory` is
included): the middleware already saves from the full transcript, and the tool produced a
second blind write that raced the reconcile judge. Preserve this.

## Baseline: Agent Ops

`createDynamicExecutorGraph` (`lib/agent-ops/executor-graphs.ts`), driven headlessly by
`executeAgentRun` / `resumeApprovedRun` (`lib/agent-ops/agent-executor.ts`), which consumes
`streamEvents({version: 'v2'})` and writes every event to `agent_ops_events`. The UI polls
those rows over SSE (`/[runId]/stream`) and `build-steps.ts` folds them into a timeline.

Triggers: Slack, Jira, Discord, Telegram, webhook, API, cron. The workers cron job calls back
into web-ui over HTTP (`agent-ops-scheduler/index.ts:253`), so **all execution happens
in-process in web-ui** — no worker-side graph code is needed.

## Decisions

| Decision | Choice |
|---|---|
| Shape | Deep coexists as an opt-in third mode; plan stays the default |
| HITL | Per-action in the web UI; batch fan-out for channel adapters |
| Unattended runs | Honour the task's `autoApprove` flag — same semantics as plan mode today |
| Sub-agents | Extract AI Ops' three into a shared factory; one definition, no drift |
| Timeline | Add `todo` and `subagent` event types with matching renderers |
| Mode selection | Explicit selector in both the New Run dialog and the scheduled task dialog, plus a tenant `defaultMode` for channel triggers |

## Architecture

### New files

| File | Responsibility |
|---|---|
| `lib/agent/deep/subagents.ts` | `createDeepSubagents({ tools, accountContext, interruptOn })` → `SubAgent[]`. The three definitions extracted from `deep-agent.ts`, consumed by both graphs |
| `lib/agent-ops/deep-executor-graph.ts` | `createDeepExecutorGraph(config: GraphConfig)` — the Agent Ops sibling of `createDeepGraph` |
| `lib/agent-ops/deep-event-translator.ts` | v3 projections → `RecordEventParams[]`. Pure and testable |
| `lib/agent-ops/deep-run-executor.ts` | `executeDeepRun(run, eventBus)` / `resumeDeepRun(run, resumeMap, eventBus)` |
| `app/api/agent-ops/[runId]/decisions/route.ts` | `POST { decisions }` — per-action HITL resume |
| `components/agent-ops/run-timeline/todo-step.tsx` | Live checklist renderer |
| `components/agent-ops/run-timeline/subagent-step.tsx` | Collapsible per-sub-agent group |
| `components/agent-ops/deep-approval-card.tsx` | Per-action approve / reject / respond UI |

### Modified files

- `lib/agent-ops/types.ts` — `AgentMode` += `'deep'`; `AgentEventType` += `'todo' | 'subagent'`;
  `AgentOpsApprovalRequest.approvalType` += `'deep_actions'`, plus `pendingActions?: PendingAction[]`
- `lib/agent-ops/agent-executor.ts` — dispatch on `run.mode === 'deep'`; delete the dead sandbox
- `app/api/agent-ops/[runId]/approve/route.ts` — batch fan-out when the run is deep
- `components/agent-ops/run-timeline/build-steps.ts` — fold sub-agent groups, collapse todos
- `app/app/agent-ops/[runId]/page.tsx` — render the deep approval card
- `components/agent-ops/new-run-dialog.tsx`, `scheduled-task-dialog.tsx` — mode selector
- `lib/agent-ops/agent-ops-defaults.ts` — `defaultMode: AgentMode`
- `lib/gateway/types.ts` — `mode` union += `'deep'` (currently `'fast' | 'plan'`, already stale)

### Dead code to remove

`agent-executor.ts` creates `/tmp/agent-ops/<runId>` (`:92`, `:583`) and deletes it (`:392`,
`:810`) but **never passes it to any tool** — the plan graph uses the module-level
`executeCommandTool`, not a cwd-bound one. Remove it. There is therefore no filesystem
collision with deep's `tenantWorkdir`.

## Event translation

Agent Ops' UI is fed by `agent_ops_events` rows, so the translator is the DB-row analogue of
`processDeepStream`.

`GraphConfig` already carries `onSubagentEvent` and `onMemoryEvent` sinks, so those two
categories arrive as **callbacks** rather than needing projection parsing. The translator only
handles messages, tool calls, and `values.todos`.

| Source | eventType | node | payload |
|---|---|---|---|
| `messages[].text` | `execution` | `call_model` | `content` |
| `messages[].reasoning` | `execution` | `call_model` | `content`, `metadata.reasoning` |
| `toolCalls` start | `tool_call` | `tools` | `toolName`, `toolArgs` |
| `toolCalls` settle | `tool_result` | `tools` | `toolOutput` (truncated 8000), `metadata.status` |
| `values.todos` change | `todo` | `write_todos` | `metadata.todos` |
| `onSubagentEvent` | `subagent` | `task` | `metadata.{name,status,task,toolCount,tokensIn,tokensOut,summary}` |
| `onMemoryEvent('recall')` | `memory_recall` | `deep_memory` | `content` |
| `onMemoryEvent('save')` | `memory_save` | `deep_memory` | `content` |
| pending interrupt | `planning` | `deep_approval_gate` | `metadata.pendingActions` |

Three constraints:

1. **Parallel consumption is mandatory.** Each projection is consumed in its own async IIFE
   inside `Promise.all`; per-tool completion is tracked with `.then()` collected into watchers,
   never awaited in the parent loop. `deep-stream.ts` documents that awaiting `message.text`
   resolves the whole message and stalls the run.
2. **Ordering needs a sequence number.** Parallel writers collide on `createdAt` at millisecond
   precision and `getRunEvents` orders by it. Every row carries `metadata.seq` from a per-run
   counter; the timeline sorts on it.
3. **Sub-agent attribution.** Each sub-agent's own tool calls are tagged
   `metadata.subagentId` so `build-steps.ts` can group them.

Cancellation reuses `registerRun` / `isAborted`, with one watchdog loop alongside `Promise.all`
performing the throttled cross-replica DB status poll (as `agent-executor.ts:180-190` does), so
a cancel issued on another ECS replica still aborts the run.

## HITL

`autoApprove: true` → `interruptOn: undefined`. No gates, identical to AI Ops.

`autoApprove: false` → after the run settles, `getState(config)` → `hasPendingInterrupt()` →
`pendingActions()`, reused verbatim from `lib/agent/deep/hitl.ts`. Store the actions on
`approvalRequest.pendingActions` with `approvalType: 'deep_actions'`, set status
`awaiting_approval`, emit `hil:tool_approval` on the gateway bus.

**Web UI:** `POST /[runId]/decisions` → `toResumeMap(pending, decisions)` → on `ok`,
`resumeDeepRun` invokes `new Command({ resume: resumeMap })`. Rejected and answered actions
never execute, so their `syntheticOutput()` is recorded as a `tool_result` row with
`metadata.synthetic`, mirroring `syntheticDecisionResults` in the chat route.
`authz: { POST: { action: 'approve', subject: 'Agent' } }`, plus an `AuditService` entry.

**Channels:** the existing `/approve` route, when the run is deep, fans its binary action out
to a uniform decision per pending action — `approve` → `{type:'approve'}` (or
`{type:'respond'}` for `ask_user`), `reject` → `{type:'reject', message}`. **Zero adapter
changes**: Slack, Jira, Discord, Telegram and webhook keep their current buttons.

The `respond` decision type is supplied by `patches/langchain@1.5.2.patch`, so `ask_user` works
in Agent Ops exactly as in AI Ops.

## Filesystem, memory, skills

Same as AI Ops deep: `tenantWorkdir(tenantId)`, `ensureWorkdir`,
`CompositeBackend(FilesystemBackend{virtualMode: true}, {'/memories/': StoreBackend})`,
`PostgresFileStore` as store, `memory: [AGENTS_MD_PATH]`. `virtualMode` is mandatory — without
it the agent could read another tenant's credentials directory.

Skills follow the current `load_skill` progressive-disclosure model, honouring `autoLoadSkills`.
`run.selectedSkill`, when set, is injected as a pinned skill section.

Middleware order matches AI Ops:
`[todoListMiddleware(), memoryMiddleware, handleToolErrors, repairMessages]`.

Checkpointer stays the shared `getCheckpointer()` keyed on `run.threadId`, so resume works
unchanged.

**Consequence to accept explicitly:** Agent Ops deep runs and AI Ops deep chats share the
tenant's `AGENTS.md` and workdir. Operating rules learned in chat therefore apply to scheduled
runs and vice versa. This is intended — one tenant, one set of learned rules — but it is a real
behaviour change.

## Timeline UI

`TimelineStep` gains `{kind: 'todo'}` and `{kind: 'subagent', name, status, steps}`.
`buildSteps` folds events carrying `metadata.subagentId` into that sub-agent's group and
collapses the `todo` series so only the latest state renders, as one live checklist rather than
N steps. Renderers follow the existing `step-shell.tsx` pattern. The run detail page renders
`deep-approval-card.tsx` when `approvalType === 'deep_actions'`.

Because deep now runs the same recall/save nodes as the plan graph, deep timelines keep their
memory pills — no fidelity loss versus plan mode.

## Testing

| Test | Covers |
|---|---|
| `deep-event-translator.test.ts` | Interleaved sub-agents, todo collapsing, `seq` monotonicity, output truncation. The main new logic |
| `subagents.test.ts` | Factory returns the three names with correct tools and `interruptOn` wiring |
| `build-steps.test.ts` (extended) | `todo` / `subagent` folding cases |
| `decisions/route.test.ts` | Unknown and undecided action rejection, resume-map shape |

`lib/agent/deep/__tests__` already covers `actionId` / `toResumeMap`. No E2E — deep runs need
live Bedrock.

## Rollout and risk

`AgentOpsRun.mode` is a free-form `String` column, so **no Prisma migration is required**. The
deep path is entirely new files and the plan path is untouched, so rollback is "stop selecting
deep".

| Risk | Mitigation |
|---|---|
| `recursionLimit` too low — deep burns steps faster with sub-agents | Use `resolveMaxIterations` (tenant budget, 150 fallback), not AI Ops' hardcoded 100 |
| `agent_ops_events` row volume rises sharply per run | Existing 30-day TTL plus 8000-char output truncation |
| Long sub-agent silence stalls the run | PR #46 added a heartbeat to `deep-stream.ts`; assess whether the DB-row path needs the equivalent |
| Extracting sub-agents touches live AI Ops code | Pure extraction with no behaviour change, covered by `subagents.test.ts` |

## Out of scope

- Retiring the plan graph
- Per-action approval UI in Slack / Discord / Telegram Block Kit
- Removing the legacy `lib/deep-agent/` module
- Letting the evaluator choose plan vs deep autonomously
