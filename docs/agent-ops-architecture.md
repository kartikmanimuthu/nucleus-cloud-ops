# Agent Ops Architecture

A headless, multi-tenant agent runtime. Any trigger — Slack, Telegram, Jira, the
in-app UI, or a cron schedule — funnels into one execution path. Understanding the
scheduler is the fastest way to understand the whole system, because it reuses every
part of it.

| | |
| --- | --- |
| **Scope** | agent-ops runtime + scheduler |
| **Services** | `apps/web-ui` · `apps/workers` |
| **Persistence** | PostgreSQL · pg-boss |

---

## 1. The core idea

Something submits a task → the system creates a **run** → a LangGraph agent executes
it (with optional human gates) → the result is delivered back to wherever the task
came from.

The delivery target is deliberately pluggable. Slack, Telegram, Discord, Jira, a
webhook, the in-app dashboard, and the cron scheduler are all just *front-ends* over
the same run. A run only records *where* it came from via a `source` field — the
machinery downstream is identical.

| `apps/web-ui` — the brain (Next.js) | `apps/workers` — the clock (pg-boss) |
| --- | --- |
| Run creation & the executor graph | Cron sweeper (every 30s) |
| Human-in-the-loop resume endpoints | Per-tenant fan-out & atomic claim |
| Channel adapters & delivery | Fires HTTP triggers into web-ui |
| Schedule CRUD | Never runs the agent itself |
| pg-boss *producer only* | |

Both share one PostgreSQL database and one pg-boss instance. The worker's only job is
to decide *when*; web-ui decides *what* and *how*.

---

## 2. The run lifecycle

A run is the central record — `AgentOpsRun` (`libs/prisma/schema.prisma:385`). Its
status walks a fixed state machine:

```
queued ──▶ in_progress ──▶ ┌ awaiting_input     ┐ ──▶ ┌ completed ┐
                           └ awaiting_approval  ┘      │ failed    │
                                                       └ cancelled ┘
```

| State | Meaning |
| --- | --- |
| `queued` | enqueued, not started |
| `in_progress` | agent executing |
| `awaiting_input` / `awaiting_approval` | parked on a human |
| `completed` | terminal success |
| `failed` / `cancelled` | terminal stop |

Alongside status, each run carries a `source`, a `mode` (`fast` or `plan`), an
`autoApprove` flag, and a `threadId` keying its LangGraph checkpoint. As it runs it
emits an ordered stream of `AgentOpsEvent` rows — `planning`, `tool_call`,
`tool_result`, `reflection`, `final`. That event log is the single source the UI
timeline and the channel digests both read from.

---

## 3. How a run executes

Entry is the gateway (`lib/gateway/gateway-service.ts → handleInbound`): validate &
parse via a channel adapter, `createRun`, subscribe the channel to the run's events,
then fire-and-forget `executeAgentRun(run)`.

Execution builds a **single dynamic graph** (`lib/agent-ops/executor-graphs.ts`) —
distinct from the AI Ops fast/planning/deep agents. An `evaluator` node classifies
each request into `fast`, `plan`, or `end` at runtime, so the mode is chosen
dynamically rather than fixed up front. Long-term memory is wired as the **first**
node (`memory_recall`) and **last** node (`memory_save`), so runs learn across time.

```
START → memory_recall → evaluator ─┬─ clarify → END          # needs input
                                   ├─ planner → approval_gate → generate…
                                   └─ generate → tools → reflect → revise → final
generate/revise → mutative_approval_gate → END   # pauses on write
final → memory_save → END
```

Read-only tools always run. *Mutating* tools (classified in `tool-classifier.ts`) hit
a gate. When `autoApprove=false`, the graph is compiled with
`interruptBefore: ["approval_gate", "mutative_approval_gate"]` — that interrupt is the
mechanism behind the `awaiting_*` states.

---

## 4. Human-in-the-loop

Two flavors of pause — and, importantly, they resume through *different* mechanisms.

| State | Meaning | Resume endpoint | Resume mechanism |
| --- | --- | --- | --- |
| `awaiting_input` | Agent needs clarification from the user. | `POST /api/agent-ops/[runId]/resume` | **Fresh re-run** with an enriched task description. |
| `awaiting_approval` | A plan or a mutating action needs sign-off. | `POST /api/agent-ops/[runId]/approve` | **True checkpoint resume** — reloads LangGraph state, injects approval, continues. |

Both surface in two UI pages that must stay in sync: the in-app run detail
(`app/app/agent-ops/[runId]/page.tsx`) and the channel deep-link fallback
(`[runId]/respond/page.tsx`) for channels that can't render native approval buttons.

---

## 5. Delivery

Delivery is event-driven. The `notification-router` listens for run events
(`run:completed`, `hil:plan_approval`, …) and calls the source adapter's `sendResult`
/ `sendApprovalRequest`.

Each adapter formats for its medium — Slack Block Kit buttons, Telegram MarkdownV2
with a hard **4096-character cap** (truncated on the raw detail so an escape sequence
is never cut mid-way), Discord, Jira comments, generic webhooks. Because delivery is
decoupled behind the event bus, adding a channel means adding an adapter, not touching
the executor.

---

## 6. Scheduling — the best lens on all of it

Here is the payoff: the scheduler adds almost *no* new machinery. It is just another
trigger. That is exactly why walking it teaches you the whole architecture.

A scheduled task (`ScheduledTask`, `libs/prisma/schema.prisma:451`) is a user-defined
row: a `cronExpression`, `timezone`, the task prompt, `mode`, `autoApprove`, target
MCP servers & knowledge bases, and a `notification` destination. The end-to-end flow:

1. **Sweep — the worker.** `agent-ops-scheduler/index.ts` runs `sweep()` every 30s,
   loads active tasks, and uses `croner` to find any due in the last 60s.
2. **Enqueue — with dedup.** `boss.send('agent-ops-tick', …)` with
   `singletonKey: 'task:<taskId>'` — the first dedup layer, collapsing concurrent
   sweeps and replicas into one job.
3. **Trigger — HTTP into web-ui.** The tick handler `POST`s to
   `/scheduled-tasks/[taskId]/trigger` with `x-internal-key` + `x-tenant-id`. The
   route re-checks the task is still `active` (stale-tick 409) and grabs a per-minute
   `ScheduledTaskLock` — the second dedup layer.
4. **Create + execute — the shared path.** The route calls the identical
   `createRun({ source: 'scheduled', … })` and `executeAgentRun(run)` used by the UI
   and Slack. Fire-and-forget; returns `{ runId, status }` immediately.
5. **Finalize + deliver.** On completion, `finalizeScheduledRun` updates `lastRun*` /
   `runCount` and hands the digest to the same channel adapters via
   `sendScheduledNotification`.

So a scheduled run produces the **same** `AgentOpsRun`, the **same** event stream, the
**same** executor graph, the **same** HIL gates, and the **same** delivery adapters as
any interactive run — distinguished only by `source='scheduled'`. It even shows up in
the same run-history views.

Which is why studying scheduling forces you to walk the entire spine of the system in
one pass:

| Scheduling concern | What it teaches about the core architecture |
| --- | --- |
| Cron sweep + `singletonKey` + `ScheduledTaskLock` | The worker↔web-ui split, and idempotency across multiple replicas. |
| `x-internal-key` / `x-tenant-id` on the trigger | How multi-tenancy flows without a user session — `getTenantClient(tenantId)` auto-scopes every query. |
| Reusing `createRun` + `executeAgentRun` | That triggers are interchangeable front-ends over one run pipeline. |
| `autoApprove` on a schedule | Why the HIL gate design matters — an unattended run either auto-approves or parks in `awaiting_approval` and pings a channel. |
| `notification.type` + adapters | The event-bus / adapter delivery decoupling. |

---

## 7. One caveat

> **Likely vestigial code.** `lib/agent-ops/scheduler-engine.ts` still registers
> per-task pg-boss schedules (`agent-ops-task:<taskId>`), but the worker wires **no
> consumer** for those queues — the 30s sweeper is authoritative. This path looks dead
> and is worth confirming before it's mistaken for a live mechanism.

---

## 8. File reference

| Concern | Path |
| --- | --- |
| Types / models / statuses | `apps/web-ui/lib/agent-ops/types.ts` |
| Executor (run + resume) | `apps/web-ui/lib/agent-ops/agent-executor.ts` |
| LangGraph executor graph | `apps/web-ui/lib/agent-ops/executor-graphs.ts` |
| Mutative-tool classifier | `apps/web-ui/lib/agent-ops/tool-classifier.ts` |
| Gateway orchestrator | `apps/web-ui/lib/gateway/gateway-service.ts` |
| Notification router | `apps/web-ui/lib/gateway/notification-router.ts` |
| Channel adapters | `apps/web-ui/lib/gateway/adapters/*.ts` |
| HIL pages | `apps/web-ui/app/app/agent-ops/[runId]/{page,respond}.tsx` |
| Worker cron sweeper | `apps/workers/src/jobs/agent-ops-scheduler/index.ts` |
| Atomic per-tenant claim | `apps/workers/src/jobs/scheduler/services/pg-service.ts` |
| Trigger endpoint | `apps/web-ui/app/api/agent-ops/scheduled-tasks/[taskId]/trigger/route.ts` |
| Digest delivery | `apps/web-ui/lib/agent-ops/scheduled-notifier.ts` |
| Data models | `libs/prisma/schema.prisma:385-496` |
