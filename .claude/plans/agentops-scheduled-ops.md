# Scheduled Tasks for Agent Ops

## Context

Agent Ops currently supports only on-demand runs triggered via Slack, Jira, or API. Users need recurring background tasks — e.g., "Every day at 9am, review master payer account cost anomalies." This feature adds a complete scheduled task system: CRUD management, in-process cron scheduling, automatic agent execution, and notification delivery to Slack/Jira.

---

## Architecture Decision: In-Process Scheduler (`croner`)

**Why not EventBridge?** Requires CDK changes, IAM for callback URLs, and split-brain between EventBridge rules and DynamoDB records.
**Why not DynamoDB TTL?** TTL deletion can delay up to 48 hours — unsuitable for precise scheduling.
**Chosen:** `croner` (lightweight, zero-dep, IANA timezone support) running in-process on the Next.js server. DynamoDB is the source of truth; on startup, all active tasks are loaded and registered. A conditional-write execution lock prevents duplicate runs across ECS instances.

---

## DynamoDB Schema (Same AgentOpsTable)

### ScheduledTask Entity
| Attribute | Pattern | Notes |
|-----------|---------|-------|
| PK | `TENANT#<tenantId>` | Same partition as runs |
| SK | `SCHED#<taskId>` | UUID v4 |
| GSI1PK | `TYPE#SCHEDULED_TASK` | List all tasks across tenants |
| GSI1SK | `<tenantId>#<taskId>` | Sort by tenant |

**Fields:** taskId, tenantId, name, description, cronExpression, timezone, taskStatus (`active|paused|deleted`), mode, autoApprove, model?, accountId?, accountName?, mcpServerIds?, notification `{type, channelId?, channelName?, projectKey?, issueKey?}`, lastRunId?, lastRunAt?, lastRunStatus?, nextRunAt?, runCount, createdAt, updatedAt, createdBy

### Execution Lock (ephemeral, prevents duplicate runs)
| PK | `SCHED_LOCK#<taskId>` |
| SK | `EXEC#<scheduledIsoTimestamp>` |
| ttl | epoch + 3600 (1hr auto-cleanup) |

### Run Linkage
- New `TriggerSource`: `'scheduled'`
- New `ScheduledTriggerMeta`: `{ taskId, taskName, scheduledAt }`
- Runs from scheduled tasks use `source: 'scheduled'`, `GSI1PK: SOURCE#scheduled`

---

## Files to Create

### 1. `web-ui/lib/agent-ops/models/scheduled-task.ts`
Dynamoose model following `agent-ops-run.ts` pattern. Schema maps all ScheduledTask fields. Same table (`AGENT_OPS_TABLE_NAME`), `create: false`.

### 2. `web-ui/lib/agent-ops/scheduled-task-service.ts`
CRUD service following `agent-ops-service.ts` pattern:
- `createScheduledTask(params)` — generate taskId, compute nextRunAt via croner, write to DDB, register with scheduler
- `getScheduledTask(tenantId, taskId)` — PK/SK get
- `listScheduledTasks(tenantId)` — query PK begins_with `SCHED#`, filter out deleted
- `updateScheduledTask(tenantId, taskId, updates)` — partial update, recompute nextRunAt if cron changes
- `pauseScheduledTask(tenantId, taskId)` — set paused, clear nextRunAt, unregister
- `resumeScheduledTask(tenantId, taskId)` — set active, compute nextRunAt, register
- `deleteScheduledTask(tenantId, taskId)` — soft-delete with TTL
- `updateLastRun(tenantId, taskId, runId, status)` — after run completes
- `tryAcquireExecutionLock(taskId, scheduledAt)` — conditional PutItem

### 3. `web-ui/lib/agent-ops/scheduler-engine.ts`
Singleton (globalThis pattern like run-manager.ts):
- `initializeScheduler()` — load all active tasks from DDB, register croner jobs
- `registerTask(task)` — create croner job with timezone, store in Map
- `unregisterTask(taskId)` — stop croner job
- `handleTick(task, scheduledAt)` — acquire lock → create run → fire-and-forget executeAgentRun → post-run: updateLastRun + notify
- `shutdownScheduler()` — stop all jobs

### 4. `web-ui/lib/agent-ops/scheduled-notifier.ts`
Post-run notification for scheduled tasks:
- Slack: post new message to `notification.channelId` using bot token (reuse patterns from `slack-notifier.ts`)
- Jira: add comment to `notification.issueKey` (reuse `jira-notifier.ts`)
- None: results only in web UI

### 5. `web-ui/instrumentation.ts`
Next.js instrumentation hook to start scheduler on server boot:
```typescript
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initializeScheduler } = await import('./lib/agent-ops/scheduler-engine');
    await initializeScheduler();
  }
}
```

### 6. API Routes — `web-ui/app/api/agent-ops/scheduled-tasks/`

| Method | Route | Handler |
|--------|-------|---------|
| GET | `/api/agent-ops/scheduled-tasks` | List tasks for tenant |
| POST | `/api/agent-ops/scheduled-tasks` | Create task |
| GET | `/api/agent-ops/scheduled-tasks/[taskId]` | Get task detail |
| PATCH | `/api/agent-ops/scheduled-tasks/[taskId]` | Update task |
| DELETE | `/api/agent-ops/scheduled-tasks/[taskId]` | Soft-delete |
| POST | `.../[taskId]/pause` | Pause task |
| POST | `.../[taskId]/resume` | Resume task |
| GET | `.../[taskId]/runs` | Run history for task |
| POST | `.../[taskId]/trigger` | Manual trigger (run now) |

### 7. Frontend Pages

**`web-ui/app/agent-ops/scheduled-tasks/page.tsx`** — List page:
- Back nav to /agent-ops
- Stats: active count, paused count, total runs
- "New Scheduled Task" button → opens dialog
- Task list: name, human-readable schedule, status badge, last run, next run, notification channel, actions (pause/resume, edit, delete, run now)

**`web-ui/app/agent-ops/scheduled-tasks/[taskId]/page.tsx`** — Detail page:
- Task info card (name, description, schedule, timezone, config)
- Run history list (reuse same run row UI from main page, filtered by taskId)
- Actions: edit, pause/resume, delete, run now

### 8. Frontend Components

**`web-ui/components/agent-ops/scheduled-task-dialog.tsx`** — Create/Edit dialog:
- Task name (text input)
- Description/objective (textarea)
- Schedule: preset selector + custom cron input + timezone dropdown
- Mode: plan/fast toggle
- Auto-approve: switch with warning
- Account: optional dropdown
- Notification: None / Slack channel / Jira issue
- MCP servers: optional

**`web-ui/components/agent-ops/cron-picker.tsx`** — Cron schedule picker:
- Presets: hourly, daily 9am, weekdays 9am, weekly Monday 8am, custom
- Custom: raw cron input with `cronstrue` human-readable preview
- Timezone dropdown (common IANA zones)

---

## Files to Modify

### `web-ui/lib/agent-ops/types.ts`
- Add `'scheduled'` to `TriggerSource`
- Add `ScheduledTriggerMeta` interface
- Add to `TriggerMetadata` union
- Add `ScheduledTaskStatus`, `ScheduledTaskNotification`, `ScheduledTask` interfaces

### `web-ui/lib/agent-ops/models/agent-ops-run.ts`
- Add `'scheduled'` to source enum
- Add scheduled trigger fields to trigger schema: `taskId: String, taskName: String, scheduledAt: String`

### `web-ui/lib/agent-ops/agent-executor.ts`
- Add `deriveUserId` case: `if (source === 'scheduled') return 'scheduled-' + trigger.taskId`

### `web-ui/lib/agent-ops/agent-ops-service.ts`
- No changes needed — `createRun` already accepts generic params; `listRuns` filters in-memory

### `web-ui/app/agent-ops/page.tsx`
- Add "Scheduled Tasks" button in header (Clock icon, navigates to `/agent-ops/scheduled-tasks`)
- Add `'scheduled'` to source filter dropdown
- Add `scheduled: Clock` to `SOURCE_ICONS` map
- Update subtitle text to include "scheduled"

### `web-ui/next.config.ts` (or `.js`)
- Add `experimental: { instrumentationHook: true }` if not already set

---

## New Dependencies

```bash
cd web-ui && npm install croner cronstrue
```
- `croner`: ~15KB, in-process cron with timezone support, provides `.nextRun()` for computing nextRunAt
- `cronstrue`: cron expression → human-readable text for UI display

---

## Implementation Sequence

**Phase 1 — Data Layer** (~types, model, service~)
1. Update `types.ts` with scheduled task types + new TriggerSource
2. Create `models/scheduled-task.ts`
3. Create `scheduled-task-service.ts`
4. Update `models/agent-ops-run.ts` source enum + trigger fields

**Phase 2 — Scheduler Engine**
5. Install `croner` + `cronstrue`
6. Create `scheduler-engine.ts`
7. Create `scheduled-notifier.ts`
8. Create `instrumentation.ts`
9. Update `agent-executor.ts` (deriveUserId for scheduled)
10. Enable instrumentation in `next.config`

**Phase 3 — API Routes**
11. Create all route files under `api/agent-ops/scheduled-tasks/`

**Phase 4 — Frontend**
12. Create `cron-picker.tsx`
13. Create `scheduled-task-dialog.tsx`
14. Create `scheduled-tasks/page.tsx` (list)
15. Create `scheduled-tasks/[taskId]/page.tsx` (detail)
16. Update `agent-ops/page.tsx` (nav button + scheduled source filter)

---

## Verification

1. **Unit:** Verify `scheduled-task-service.ts` CRUD operations work with DynamoDB local or mock
2. **Scheduler:** Create a task with `*/1 * * * *` (every minute), verify it triggers a run, verify execution lock prevents duplicates
3. **UI:** Navigate to Scheduled Tasks page, create a task, verify it appears in list with correct next run time
4. **Notification:** Configure Slack channel on a task, trigger manually, verify result posted to channel
5. **Edit/Pause:** Edit cron expression, verify nextRunAt updates; pause task, verify no new runs; resume, verify runs resume
6. **Run History:** Click task detail, verify run history shows only runs from that task
7. **Build:** `cd web-ui && npm run build` — ensure no TypeScript errors


---



[DONE]

Built: Full scheduled task system — data layer, in-process cron scheduler, 6 API routes, 2 frontend pages, 2 components, and all wiring.

Files:
- lib/agent-ops/types.ts — added 'scheduled' to TriggerSource, ScheduledTriggerMeta, ScheduledTask, ScheduledTaskStatus, ScheduledTaskNotification
- lib/agent-ops/models/agent-ops-run.ts — added 'scheduled' to source enum + scheduled trigger fields
- lib/agent-ops/models/scheduled-task.ts — new Dynamoose model (same table)
- lib/agent-ops/scheduled-task-service.ts — full CRUD + tryAcquireExecutionLock (conditional DDB PutItem)
- lib/agent-ops/scheduler-engine.ts — globalThis singleton, croner jobs, lock → run → notify flow
- lib/agent-ops/scheduled-notifier.ts — Slack channel + Jira issue post-run notifications
- instrumentation.ts — Next.js server boot hook
- lib/agent-ops/agent-executor.ts — deriveUserId case for 'scheduled'
- next.config.mjs — experimental.instrumentationHook: true
- app/api/agent-ops/scheduled-tasks/ — 6 route files (list/create, get/patch/delete, pause, resume, runs, trigger)
- components/agent-ops/cron-picker.tsx — preset + custom cron + cronstrue preview + timezone
- components/agent-ops/scheduled-task-dialog.tsx — create/edit dialog
- app/agent-ops/scheduled-tasks/page.tsx — list page with stats + actions
- app/agent-ops/scheduled-tasks/[taskId]/page.tsx — detail page with run history
- app/agent-ops/page.tsx — added Scheduled Tasks nav button + scheduled source filter

Test: Create a task with */1 * * * *, verify it fires after 1 min and a run appears in /agent-ops?source=scheduled. Duplicate-run protection: spin up 2 instances, both will attempt the lock but only one proceeds.