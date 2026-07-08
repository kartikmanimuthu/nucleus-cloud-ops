# Scheduled-Cron Agent Ops — End-to-End Channel Delivery (Design)

**Date:** 2026-07-05
**Status:** Approved
**Branch:** `agent-ops`

## 1. Problem

Agent Ops scheduled tasks (pg-boss cron → `executeAgentRun`) run autonomously, but their
results never reach the configured channel. The delivery chain is broken in four places:

1. `notifyScheduledRunResult` (`apps/web-ui/lib/agent-ops/scheduled-notifier.ts`) emits
   `run:completed` / `run:failed` onto the global `GatewayEventBus`, but the trigger route
   never attaches a `NotificationRouter` subscriber — the event evaporates.
2. Even with a subscriber, `NotificationRouter` picks the adapter from `run.source`
   (`'scheduled'`), which has no registered adapter — `registry.get('scheduled')` throws.
3. Even with the right adapter, all outbound methods derive the destination from
   `run.trigger` (Slack `channelId`/`responseUrl`, Telegram `chatId`). A scheduled run's
   trigger is `{taskId, taskName, scheduledAt}` — no destination.
   `ScheduledTaskNotification.channelId` is stored but never read by delivery code.
4. The scheduler worker (`apps/workers/src/jobs/agent-ops-scheduler/index.ts`) registers
   pg-boss consumers only for tasks that exist at worker startup. Tasks created afterwards
   get a queue + schedule (web-ui `registerTask`) but no consumer — they never fire until
   the workers container restarts.

Secondary defects on the same path:

- HIL on scheduled runs is silent: a run that parks in `awaiting_approval` /
  `awaiting_input` notifies no one, and the current notifier would report any
  non-`completed` status as a failure.
- When a parked scheduled run is later approved from the dashboard, the final result is
  never delivered, and `ScheduledTask.lastRunStatus` freezes at `awaiting_approval`.
- `tryAcquireExecutionLock` exists on the scheduled-task repository (backed by
  `scheduled_task_locks`) but the trigger route never calls it — the double-fire
  protection described in `docs/agent-ops/README.md` is not enforced.

## 2. Goal

A working Hermes-style autonomous loop for scheduled tasks: **cron fires → agent does the
work autonomously → one digest message is pushed to the configured channel** (server →
client, unidirectional), using per-tenant credentials resolved dynamically at send time.

Channels in scope for v1: **Slack and Telegram**.

HIL policy: **respect the task's `autoApprove` flag**. A run that parks in `awaiting_*`
pushes a "needs your attention" message with a dashboard deep link; after dashboard
approval, the final result is still delivered to the channel.

## 3. Approach

**Direct dispatch** — no event bus. A scheduled run produces exactly one outcome message,
so pub/sub indirection adds nothing. `notifyScheduledRunResult(task, run)` resolves the
adapter from `task.notification.type` and calls one new destination-explicit method on the
adapter. Each adapter owns its own formatting and loads tenant credentials itself.

Alternatives rejected:

- *Event bus + scheduled-aware router*: would also enable mid-run streaming, but requires
  touching router, registry, and trigger route anyway — more moving parts for one message.
- *Delivery as a pg-boss job*: durable retries, but delivery code would live in
  `apps/workers`, which cannot import web-ui adapters (`@/lib/...`) — would duplicate the
  Slack/Telegram clients.

## 4. Design

### 4.1 Types (`apps/web-ui/lib/agent-ops/types.ts`)

```ts
export interface ScheduledTaskNotification {
    type: 'none' | 'slack' | 'jira' | 'telegram';   // + 'telegram'
    channelId?: string;    // slack
    channelName?: string;  // slack (display)
    chatId?: string;       // telegram (new)
    projectKey?: string;   // jira (existing, delivery not wired in v1)
    issueKey?: string;     // jira
}
```

`ScheduledTask.notification` is a JSON column (`schema.prisma:463`) — **no migration**.

### 4.2 Adapter contract (`apps/web-ui/lib/gateway/types.ts`)

One new optional method plus an outcome type:

```ts
export type ScheduledOutcome = 'result' | 'failure' | 'attention';

interface ChannelAdapter {
    // ...existing members...
    sendScheduledNotification?(
        task: ScheduledTask,
        run: AgentOpsRun,
        outcome: ScheduledOutcome,
    ): Promise<void>;
}
```

The adapter reads the **destination** from `task.notification` (`channelId` / `chatId`)
and **credentials** from `TenantConfig` via `run.tenantId` (existing `loadConfig`
helpers) — per-tenant credentials resolved dynamically at send time.

### 4.3 Adapter implementations

- **Slack** (`adapters/slack-adapter.ts`): Block Kit digest — task name, outcome, result
  summary (or error / attention question), duration, tools used, dashboard deep link —
  posted via `chat.postMessage` to `notification.channelId` with the tenant `botToken`.
- **Telegram** (`adapters/telegram-adapter.ts`): MarkdownV2 digest with the same fields
  via `sendMessage` to `notification.chatId` with the tenant `botToken`.

Both log-and-return on missing config/destination; neither throws.

### 4.4 Notifier rewrite (`apps/web-ui/lib/agent-ops/scheduled-notifier.ts`)

```
notifyScheduledRunResult(task, run):
    notification.type == 'none' | missing  → skip
    adapter = registry.get(notification.type)        // slack | telegram
    adapter missing or no sendScheduledNotification  → warn + skip (e.g. 'jira' in v1)
    outcome = completed → 'result'
              failed | cancelled → 'failure'
              awaiting_input | awaiting_approval → 'attention'  (dashboard link)
    adapter.sendScheduledNotification(task, run, outcome)
    // wrapped: never throws — delivery failure never affects the run
```

### 4.5 Close the HIL loop (approve/resume routes)

`POST /api/agent-ops/[runId]/approve` (and the resume path it drives) gets a
post-completion hook: after `resumeApprovedRun` settles, if `run.source === 'scheduled'`,
reload the run, load the task from `trigger.taskId`, call `notifyScheduledRunResult`, and
`updateLastRun` so `lastRunStatus` reflects the terminal state instead of freezing at
`awaiting_approval`. A re-parked run (tool-approval after plan-approval) sends another
'attention' digest — acceptable.

### 4.6 Trigger route hardening (`.../scheduled-tasks/[taskId]/trigger/route.ts`)

Before creating the run, acquire
`tryAcquireExecutionLock(taskId, minuteRounded(now))`; if not acquired, return 409 with
`{ skipped: true }`. Guards a cron tick racing a manual trigger across containers.

### 4.7 Worker re-sync (`apps/workers/src/jobs/agent-ops-scheduler/index.ts`)

A 60-second re-sync loop diffs active `ScheduledTask` rows against the queues registered
in memory:

- new task → `createQueue` + `work` + `schedule`
- paused/deleted task → `unschedule` (consumer may stay; queue is idle)
- changed `cronExpression`/`timezone` → re-`schedule` (pg-boss upserts by queue name)

The diff itself is a pure function (`diffScheduleSync(active, registered)`) so it is
unit-testable. This is what makes the flow end-to-end: create a task in the UI and it
fires without a workers restart.

### 4.8 UI (`apps/web-ui/components/agent-ops/scheduled-task-dialog.tsx`)

Notification section gains a **Telegram** option with a chat-ID field (RHF + Zod,
matching the existing Slack fields).

## 5. Error handling philosophy

Delivery is **best-effort and never affects the run**: every notifier/adapter failure
logs and degrades (same "non-fatal by contract" convention as the memory layer). The run
record and event timeline in the dashboard remain the source of truth.

## 6. Testing

Vitest, colocated per repo convention:

- Notifier: outcome mapping (all six statuses), adapter dispatch by type, `none`/missing
  adapter/missing method skips, never-throws invariant.
- Adapters: `sendScheduledNotification` destination + payload formatting with mocked
  `fetch`; missing token / missing destination no-ops.
- Worker: `diffScheduleSync` pure-function cases (new / removed / changed / unchanged).
- Trigger route: lock-acquired vs lock-held behavior (mocked repository).

## 7. Non-goals

- Mid-run streaming to channels for scheduled runs — one digest only (unidirectional).
- Email/SES delivery — next iteration.
- Jira scheduled delivery — `'jira'` stays in the enum; notifier warns; small follow-up.
- Inbound tenant-identity mapping (Slack `team_id` / Telegram chat-id → tenant) —
  separate effort; does not block this path because scheduled tasks are created under the
  real tenant id.
- Crash recovery for orphaned `in_progress` runs — tracked separately.
