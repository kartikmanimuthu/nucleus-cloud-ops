# Scheduled-Cron Delivery

> How a scheduled Agent Ops task reaches a channel: a clock ticks, the agent runs
> autonomously, and **one digest is pushed in a single direction** — server → channel.
> No reply path, no polling. Channels in scope: **Slack, Telegram**.

Related: [`README.md`](./README.md) (Agent Ops overview) ·
design + plan under [`docs/superpowers/`](../superpowers/) (`2026-07-05-scheduled-cron-delivery-*`).

---

## The autonomous path

The full pipeline for a hands-off task (`autoApprove = true`). The manual trigger endpoint
runs this **same code path** as the cron worker — so one `curl` exercises the whole thing.

```
cron tick (worker)  /  manual POST  /  dashboard "Run now"
        │
        ▼
1. Trigger route          app/api/agent-ops/scheduled-tasks/[taskId]/trigger/route.ts
     • task must be active          → else 409 { skipped: true }
     • win minute-window lock       → else 409 { skipped: true }
        │
        ▼
2. createRun              lib/agent-ops/agent-ops-service.ts
     source: 'scheduled', trigger: { taskId, taskName, scheduledAt }
        │
        ▼
3. executeAgentRun        lib/agent-ops/agent-executor.ts   (fire-and-forget)
     LangGraph: evaluator → planner → generate → tools → reflect → revise → final
     settles: completed / failed / cancelled   — or parks awaiting_* (see HIL)
        │
        ▼
4. finalizeScheduledRun   lib/agent-ops/scheduled-notifier.ts
     refresh task.lastRun* · runCount += 1 (once per run) · never throws
        │
        ▼
5. notifyScheduledRunResult   (same file)
     map status → outcome · pick adapter from task.notification.type
        │
        ▼
6. adapter.sendScheduledNotification   lib/gateway/adapters/{slack,telegram}-adapter.ts
     load THIS tenant's bot token from TenantConfig (by run.tenantId)
     build digest · POST to channelId (Slack) / chatId (Telegram) · never throws
        │
        ▼
◉ channel receives one digest — nothing waits for a reply
```

### Status → outcome → digest

| Run status | Outcome | Digest sent |
|---|---|---|
| `completed` | `result` | summary, tools used, duration, dashboard link |
| `failed` / `cancelled` | `failure` | error message, dashboard link |
| `awaiting_input` / `awaiting_approval` | `attention` | clarification / approval prompt + dashboard deep link |
| `queued` / `in_progress` | — | nothing (not settled yet) |

Destination comes from `task.notification` (`channelId` for Slack, `chatId` for Telegram).
Credentials are loaded **per-tenant at send time** by `run.tenantId` — never from the run trigger.
A `notification.type` with no adapter (e.g. `jira` today) is logged and skipped, never an error.

---

## Human-in-the-loop branch

A `plan`-mode task with `autoApprove = false` can't answer buttons over a one-way channel, so:

```
3. run parks (awaiting_approval)
      → attention digest to channel  (dashboard deep link · runCount counted here)
      → you approve on the dashboard   POST /api/agent-ops/[runId]/approve
      → resumeApprovedRun resumes from the LangGraph checkpoint, completes
      → final result digest delivered  (finalize called with countRun: false)
```

`runCount` is incremented once, at the first settle (the park). The redelivery after approval
passes `countRun: false`, so a HIL run is never double-counted.

---

## Re-sync loop (worker background process)

Independent of any single run. It's why a task created/paused/re-cronned in the UI takes effect
without restarting the worker.

```
workers/src/jobs/agent-ops-scheduler/index.ts

every 60s (setInterval, re-entrancy guarded — passes never overlap)
   → load active tasks from DB
   → diffScheduleSync(active, registered)  →  toAdd / toUpdate / toRemove   (sync.ts, pure)
   → reconcile pg-boss: schedule new · re-schedule changed · unschedule removed
```

---

## Guarantees

- **Delivery never breaks a run.** Every notifier/adapter step is wrapped and non-throwing; a dead
  token can't fail the run or the trigger request. The run record stays the source of truth.
- **No double-fire.** The minute-window lock is decided by the affected-row count of an atomic
  `INSERT … ON CONFLICT DO NOTHING`. A cron tick racing a manual trigger yields exactly one run.
- **Counted once.** `runCount` increments only on first settle; HIL redelivery uses `countRun: false`.
- **Tenant-scoped.** Task reads/writes go through the tenant client; creds load per `run.tenantId`.
  The lock is platform-level — safe, since `taskId` is globally unique.
- **Paused/deleted tasks stay put.** The trigger route refuses any task not `active`.
- **Opt-out is real.** `notification.type: none` runs normally and posts nothing.

---

## Testing

### Automated

```bash
cd apps/web-ui && bunx vitest run \
  tests/agent-ops/scheduled-notifier.test.ts \
  tests/agent-ops/scheduled-trigger.test.ts \
  tests/gateway/adapters/slack-adapter.test.ts \
  tests/gateway/adapters/telegram-adapter.test.ts \
  lib/db/repositories/scheduled-task/postgres.test.ts
cd apps/workers && bunx vitest run src/jobs/agent-ops-scheduler/
```

### End-to-end (fast lane)

The manual trigger is the same code as the cron tick, so this drives stage 1 → channel:

```bash
curl -i -X POST "http://localhost:3001/api/agent-ops/scheduled-tasks/<taskId>/trigger" \
  -H "x-internal-key: internal-worker-key" \
  -H "x-tenant-id: <tenantId>"
# → 200 {"runId":"…"} , then the digest lands in the configured channel
```

**Setup:** configure the channel under **Channels → {Slack,Telegram} settings** (writes
`TenantConfig` key `agent-ops-{channel}`), create a task at **Agent Ops → Scheduled tasks** with a
notification target, then trigger.

### Real cron path

For the worker to reach web-ui locally, set `WEB_UI_BASE_URL=http://localhost:3001` in the root
`.env` (the worker defaults to `:3000`, but `bun run dev` serves web-ui on `:3001`). Set a task's
cron to `* * * * *` and watch the worker logs for `Tick:` / `Triggered task …`.

### Edge guards

| Check | How | Expect |
|---|---|---|
| Paused task | pause it, then trigger | `409 { skipped: true }`, no run |
| Duplicate/lock | fire the same trigger twice in one minute | first `200`, second `409 { skipped: true }` |
| Opt-out | task with `notification: none` | run appears in dashboard, no channel message |
