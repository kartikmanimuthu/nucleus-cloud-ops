# Agent Ops — Reference

> A headless, multi-tenant background AI-agent platform. A **run** is one autonomous agent task,
> triggered from any source (Slack, Telegram, Discord, Jira, Webhook, scheduled cron, or direct API),
> executed by a LangGraph state machine, with full human-in-the-loop (HIL) approvals/clarifications
> and a persisted event timeline.

## Architecture at a glance

```
External platform                Gateway (per-tenant)                 Agent-Ops executor
─────────────────                ────────────────────                 ──────────────────
Slack / Telegram / Discord  ──►  /api/v1/gateway/{channel}            executeAgentRun(run, eventBus)
Jira / Webhook / API             → adapter.validateRequest()          LangGraph:
                                 → adapter.parseInbound()               evaluator → clarify/planner
                                 → agentOpsService.createRun()                    → generate → tools
                                 → NotificationRouter.attachToRun()              → reflect → revise → final
                                 → adapter.sendAck()  (instant 200)    emits events ──┐
                                 → executeAgentRun() (fire & forget)                  │
                                                                                      ▼
   ◄── results / approvals ──    NotificationRouter  ◄──────────────────────  GatewayEventBus
       (sendResult, sendClarification, sendApprovalRequest)              (keyed run:${runId})
```

Three layers, cleanly decoupled:

1. **Connectors** — platform-specific adapters (Slack, Telegram, …).
2. **Gateway** — normalizes inbound messages, creates runs, routes outbound events back to the source.
3. **Executor** — the LangGraph agent that does the work and emits events.

---

## Data model (`libs/prisma/schema.prisma`)

| Model | Lines | Purpose |
|---|---|---|
| `AgentOpsRun` | 383–418 | One run: `source`, `status`, `mode` (`plan`\|`fast`), `autoApprove`, `model`, `threadId` (LangGraph checkpoint), `trigger` (polymorphic JSON), `result`/`clarification`/`approvalRequest`, `durationMs`. 30-day TTL. |
| `AgentOpsEvent` | 423–443 | Per-run event stream: `eventType` (`planning`\|`execution`\|`tool_call`\|`tool_result`\|`reflection`\|`revision`\|`final`\|`error`), `node`, `content`, `toolName`/`toolArgs`/`toolOutput`. 30-day TTL. |
| `ScheduledTask` | 448–477 | Cron + timezone, mode/model/MCP servers, `notification` target (none\|slack\|telegram\|jira), `lastRun*`/`nextRunAt`/`runCount`. |
| `ScheduledTaskLock` | 482–492 | Distributed lock (`taskId` + `scheduledAt`) so cron never double-fires. 1-hour TTL. |

### Run lifecycle (`status`)

```
queued → in_progress → ┬─ awaiting_input      (clarification needed)
                       ├─ awaiting_approval    (plan or mutative-tool gate)
                       ├─ completed
                       ├─ failed
                       └─ cancelled
```

`threadId` is the LangGraph thread — checkpointing lets a paused/awaiting run resume from where it stopped.

---

## Key files

| Concern | Path |
|---|---|
| Type definitions (runs, triggers, configs) | `apps/web-ui/lib/agent-ops/types.ts` |
| Executor (LangGraph orchestration) | `apps/web-ui/lib/agent-ops/agent-executor.ts` (`executeAgentRun` ~:55, `resumeApprovedRun` ~:489) |
| Graph builder | `apps/web-ui/lib/agent-ops/executor-graphs.ts` |
| Tool classifier (mutative vs read-only) | `apps/web-ui/lib/agent-ops/tool-classifier.ts` |
| Run manager (AbortController for cancel) | `apps/web-ui/lib/agent-ops/run-manager.ts` |
| Service layer | `apps/web-ui/lib/agent-ops/agent-ops-service.ts` |
| Scheduled-task service + lock | `apps/web-ui/lib/agent-ops/scheduled-task-service.ts` |
| Scheduler engine (pg-boss producer) | `apps/web-ui/lib/agent-ops/scheduler-engine.ts` |
| Scheduler worker (pg-boss consumer) | `apps/workers/src/jobs/agent-ops-scheduler/index.ts` |
| **Gateway** service | `apps/web-ui/lib/gateway/gateway-service.ts` |
| Adapter interface + contracts | `apps/web-ui/lib/gateway/types.ts` |
| Adapter registry | `apps/web-ui/lib/gateway/adapter-registry.ts` |
| Event bus | `apps/web-ui/lib/gateway/event-bus.ts` |
| Notification router | `apps/web-ui/lib/gateway/notification-router.ts` |
| Adapters | `apps/web-ui/lib/gateway/adapters/{slack,telegram,discord,jira,webhook,api}-adapter.ts` |
| Run list UI | `apps/web-ui/app/app/agent-ops/page.tsx` |
| Run detail UI (event timeline + HIL) | `apps/web-ui/app/app/agent-ops/[runId]/page.tsx` |
| Channel settings UI | `apps/web-ui/app/app/channels/` + `apps/web-ui/components/channels/` |

---

## API surface

### Runs — `/api/agent-ops`
| Route | Method | Purpose |
|---|---|---|
| `/api/agent-ops` | GET | List runs (filter by `source`, `status`, `limit`) |
| `/api/agent-ops/[runId]` | GET | Fetch run + all events |
| `/api/agent-ops/[runId]/resume` | POST | Resume an `awaiting_input` run with user clarification |
| `/api/agent-ops/[runId]/approve` | POST | Approve / reject an `awaiting_approval` run |
| `/api/agent-ops/[runId]/cancel` | POST | Cancel a queued / in-progress run |

### Scheduled tasks — `/api/agent-ops/scheduled-tasks`
`GET` / `POST` (CRUD) plus `/[taskId]/trigger`, `/pause`, `/resume`, `/runs`.

### Settings — `/api/agent-ops/settings/{slack,jira,discord,telegram,webhook}`
`GET` (secrets masked) / `PUT`. Also `/api/agent-ops/mcp-settings`.

### Gateway (inbound webhooks) — `/api/v1/gateway/{channel}`
`slack`, `slack/interactions`, `telegram`, `discord`, `jira`, `webhook`, `api`, plus SSE stream
`/api/v1/gateway/stream/[runId]`. Each route is a one-liner delegating to
`getGatewayService().handleInbound(channelType, req)`.

---

## Human-in-the-loop (HIL)

Three interruption points, all resumable from the LangGraph checkpoint:

| Type | Trigger | Resume path |
|---|---|---|
| **Clarification** (`awaiting_input`) | evaluator sets `clarificationQuestion` | `POST /[runId]/resume` with `userInput` |
| **Plan approval** (`awaiting_approval`) | reaches `approval_gate` and `autoApprove=false` | `POST /[runId]/approve` → `resumeApprovedRun()` |
| **Tool approval** (`awaiting_approval`) | a mutative tool (create/delete/deploy/…) flagged by `tool-classifier.ts` | `POST /[runId]/approve` |

`autoApprove=true` skips both approval gates (clarification still possible).

---

## Scheduling (cron)

> Full walkthrough (flow diagram, HIL branch, re-sync loop, testing): [`scheduled-cron-delivery.md`](./scheduled-cron-delivery.md).

- **Web-UI side** (`scheduler-engine.ts`) is producer-only: `registerTask()` calls `boss.createQueue` + `boss.schedule`.
- **Worker side** (`agent-ops-scheduler/index.ts`) syncs active `ScheduledTask`s to pg-boss cron schedules
  (`agent-ops-task:<taskId>`) at startup **and re-syncs every 60s** (`sync.ts` diff), so tasks created,
  paused, or re-cronned after startup take effect without a worker restart.
- Each tick POSTs to `/api/agent-ops/scheduled-tasks/[taskId]/trigger` with `x-internal-key` (bypasses NextAuth) + `x-tenant-id`.
- The trigger route acquires `ScheduledTaskLock` (`taskId` + minute-rounded window) before creating the run —
  duplicate triggers in the same minute return 409 `{ skipped: true }`.

### Scheduled-run delivery (unidirectional)

After a scheduled run settles, `finalizeScheduledRun` (`lib/agent-ops/scheduled-notifier.ts`) refreshes the
task's `lastRun*` fields and dispatches **one digest** directly to the adapter named by
`task.notification.type` via `adapter.sendScheduledNotification(task, run, outcome)`:

| Run status | Outcome | Digest |
|---|---|---|
| `completed` | `result` | summary, tools used, duration, dashboard link |
| `failed` / `cancelled` | `failure` | error message, dashboard link |
| `awaiting_input` / `awaiting_approval` | `attention` | question / approval type + dashboard deep link |

Destination comes from `task.notification` (`channelId` for Slack, `chatId` for Telegram); credentials load
per-tenant from `TenantConfig` at send time. Delivery is best-effort and never affects the run. The same
finalize hook runs after dashboard approve/resume, so a parked run still reports its final result.
Supported channels: **Slack, Telegram** (`jira` type exists but delivery is not wired yet).

---

## Connectors — status & config

All credentials are stored per-tenant in `TenantConfig` under key `agent-ops-{channel}`, masked in API responses. All five connectors are production-complete.

| Channel | Inbound auth | Delivery | HIL buttons | Config keys |
|---|---|---|---|---|
| **Slack** | HMAC-SHA256 + 5-min replay window | callback | ✅ | `signingSecret`, `botToken` |
| **Telegram** | `x-telegram-bot-api-secret-token` | streaming | ✅ (inline keyboards) | `botToken`, `secretToken` |
| **Discord** | Ed25519 (tweetnacl) | streaming | ✅ | `applicationId`, `publicKey`, `botToken` |
| **Jira** | Bearer / `x-webhook-secret` | callback | ⚠️ comments only | `webhookSecret`, `baseUrl`, `apiToken`, `botAccountId` |
| **Webhook** | HMAC-SHA256 of body | callback | ❌ | `webhookSecret` |
| **API** | app-dependent | polling | ❌ | — |

The `ChannelAdapter` contract (`lib/gateway/types.ts`):

```ts
interface ChannelAdapter {
  channelType;        // 'slack' | 'telegram' | ...
  deliveryMode;       // 'streaming' | 'callback' | 'polling'
  hilCapabilities;    // { clarification, approvalButtons, threadedReplies }

  // inbound
  validateRequest(req): Promise<boolean>;
  parseInbound(req): Promise<GatewayMessage>;
  sendAck(req, runId): Promise<Response>;

  // outbound (driven by NotificationRouter)
  sendResult(run, events): Promise<void>;
  sendError(run, error): Promise<void>;
  sendClarification(run, question): Promise<void>;
  sendApprovalRequest(run, planSteps?, pendingTools?): Promise<void>;
  sendStreamChunk?(run, event): Promise<void>;   // streaming channels only

  getConfig(tenantId): Promise<Record<string, unknown>>;
}
```

`NotificationRouter` maps event-bus events to adapter calls:
`run:event → sendStreamChunk`, `run:completed → sendResult`, `run:failed → sendError`,
`hil:clarification → sendClarification`, `hil:plan_approval`/`hil:tool_approval → sendApprovalRequest`.
It checks `hilCapabilities` first and falls back to a dashboard URL when the channel can't render buttons.

---

## Setup guides (configuring existing connectors)

### Slack
1. Create a Slack app → enable **Slash Commands** + **Interactivity**.
2. Slash command request URL → `https://<host>/api/v1/gateway/slack`
   Interactivity request URL → `https://<host>/api/v1/gateway/slack/interactions`
3. Copy **Signing Secret** (Basic Information) and **Bot Token** `xoxb-…` (OAuth & Permissions; scopes `chat:write`, `commands`).
4. App UI → **Channels → Slack settings** (`/app/app/channels/slack-settings`): paste both, `enabled=true`, set `autoApprove`.
5. Run the slash command → run appears in `/app/app/agent-ops`, progress streams to the Slack thread, approvals inline.

### Telegram
1. Create a bot via **@BotFather**, copy the bot token.
2. Choose a random `secretToken`, then register the webhook:
   ```
   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<host>/api/v1/gateway/telegram&secret_token=<secretToken>
   ```
3. App UI → **Channels → Telegram settings**: paste `botToken` + `secretToken`, enable.
4. Message the bot → run executes → updates + approval buttons stream back via inline keyboards.

### Discord / Jira
Same pattern — set the platform's interaction/webhook URL to `/api/v1/gateway/{discord|jira}` and paste credentials into the matching settings page.

Note: this is the **Jira gateway channel** (triggers runs from Jira Automation, posts results as issue
comments — webhook + API token, see the `Jira` row above). It's separate from adding **Atlassian/Jira
as an MCP tool source** (giving the agent read/write access to Jira issues via the Atlassian Rovo MCP
server) — for headless auth to that server, see `apps/web-ui/content/docs/jira-integration.mdx`.

---

## Adding a brand-new channel (e.g. MS Teams, WhatsApp)

No executor changes needed — seven mechanical steps:

1. **Adapter** — `lib/gateway/adapters/teams-adapter.ts` implementing `ChannelAdapter`.
2. **Register** — `registry.register(new TeamsAdapter())` in `lib/gateway/index.ts`.
3. **Config + trigger types** — add `TeamsIntegrationConfig` / `TeamsTriggerMeta` in `lib/agent-ops/types.ts`; extend the `source` CHECK constraint in `schema.prisma` and migrate.
4. **Settings API** — `app/api/agent-ops/settings/teams/route.ts` (GET masked / PUT to `TenantConfig`).
5. **Gateway route** — `app/api/v1/gateway/teams/route.ts`: `return getGatewayService().handleInbound('teams', req)`.
6. **Settings form** — `components/channels/teams-settings-form.tsx` (RHF + Zod + sonner + TanStack Query hook).
7. **Channels page** — add the card to `app/app/channels/page.tsx`.

Set `deliveryMode` and `hilCapabilities` honestly — the router relies on them.

---

## Multi-tenancy notes

- Every run/event/task is scoped by `tenantId`; routes read it from the session or the `x-tenant-id` header (workers use the header + `x-internal-key`).
- Connector credentials live in `TenantConfig` per tenant — so each tenant brings its own Slack app / Telegram bot.
- Ownership checks enforce that a run belongs to the requesting tenant before resume/approve/cancel.
