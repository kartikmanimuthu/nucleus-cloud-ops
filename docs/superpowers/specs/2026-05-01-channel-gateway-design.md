# Channel Gateway — Design Spec

**Date:** 2026-05-01
**Status:** Approved
**Branch:** agent-ops-channel

## Problem

The Agent Ops executor is tightly coupled to Slack and Jira. The executor calls `postResultToSlack()` and `postResultToJira()` directly. Each trigger endpoint (`/api/v1/trigger/slack`, `/jira`, `/api`) duplicates orchestration logic — validation, run creation, HIL resume, result delivery. Adding a new channel (Discord, Telegram, webhook) means duplicating all of this again.

## Goal

Decouple channel-specific logic from the agent executor via a Channel Gateway. Channels become plug-and-play adapters behind a unified interface. The executor emits events to an in-process event bus; a notification router dispatches to the originating channel's adapter. New channels require one new adapter file and one registry line.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Deployment | Inside Next.js (lib module + API routes) | Reuses existing auth, Prisma, LangGraph. No inter-service overhead. |
| Streaming transport | SSE (Server-Sent Events) | HTTP-native, works through CloudFront, simple. WebSocket adds sticky session complexity. |
| Channels in scope | Slack, Jira (refactor), Discord, Telegram, Generic Webhook, API | Full coverage. Slack/Jira refactored from existing code; Discord/Telegram/Webhook new. |
| HIL pattern | Channel-first with dashboard fallback | Native buttons/threads where supported; dashboard URL for channels that can't handle HIL. |
| Adapter registration | Static registry | TypeScript classes in a Map. Type-safe, no runtime overhead. Adding a channel = one file + one register() call. |
| Architecture approach | Gateway-as-Middleware | Thin orchestration layer with in-process EventEmitter. Minimal executor changes. Evolve to queue-mediated later if needed. |

---

## Architecture

```
                         ┌─────────────────────────────────────────────┐
                         │              INBOUND                        │
                         │                                             │
  Slack ──→ POST /api/v1/gateway/slack ──┐                            │
  Jira  ──→ POST /api/v1/gateway/jira  ──┤                            │
  Discord → POST /api/v1/gateway/discord ─┤   ChannelAdapter           │
  Telegram→ POST /api/v1/gateway/telegram ┤   .parseInbound(req)       │
  Webhook → POST /api/v1/gateway/webhook ─┤   .validateRequest(req)    │
  API    → POST /api/v1/gateway/api ──────┘                            │
                         │                                             │
                         ▼                                             │
              ┌─────────────────────┐                                  │
              │   Gateway Service   │                                  │
              │                     │                                  │
              │  • Normalize input  │                                  │
              │  • Create/resume run│                                  │
              │  • Route to executor│                                  │
              │  • Manage event bus │                                  │
              └──────────┬──────────┘                                  │
                         │                                             │
                         ▼                                             │
              ┌─────────────────────┐                                  │
              │   Agent Executor    │  (unchanged — LangGraph pipeline)│
              │   executeAgentRun() │                                  │
              └──────────┬──────────┘                                  │
                         │                                             │
                         ▼                                             │
              ┌─────────────────────┐                                  │
              │   Event Bus         │  (in-process EventEmitter)       │
              │                     │                                  │
              │  Events:            │                                  │
              │  • run:started      │                                  │
              │  • run:event        │                                  │
              │  • run:completed    │                                  │
              │  • run:failed       │                                  │
              │  • hil:clarification│                                  │
              │  • hil:approval     │                                  │
              └──────────┬──────────┘                                  │
                         │                                             │
                         ▼              OUTBOUND                       │
              ┌─────────────────────┐                                  │
              │ Notification Router │                                  │
              │                     │                                  │
              │ • Reads run.source  │                                  │
              │ • Picks adapter     │                                  │
              │ • Calls adapter     │                                  │
              │   .sendResult()     │                                  │
              │   .sendClarification│                                  │
              │   .sendApproval()   │                                  │
              └──────────┬──────────┘                                  │
                         │                                             │
  Slack  ◄── adapter.sendResult() ────┤                                │
  Jira   ◄── adapter.sendResult() ────┤                                │
  Discord◄── adapter.sendResult() ────┤  ChannelAdapter                │
  Telegram◄─ adapter.sendResult() ────┤  .formatResult()               │
  Webhook◄── adapter.sendResult() ────┤  .formatClarification()        │
  SSE    ◄── GET /api/v1/gateway/stream/[runId]                        │
                         │                                             │
                         └─────────────────────────────────────────────┘
```

---

## ChannelAdapter Interface

```typescript
type ChannelType = 'slack' | 'jira' | 'discord' | 'telegram' | 'webhook' | 'api';

type DeliveryMode = 'streaming' | 'callback' | 'polling';

interface GatewayMessage {
  channelType: ChannelType;
  tenantId: string;
  taskDescription: string;
  userId?: string;
  mode?: 'fast' | 'plan';
  autoApprove?: boolean;
  accountId?: string;
  mcpServerIds?: string[];
  replyContext?: ReplyContext;
  channelMeta: Record<string, unknown>;
}

interface ReplyContext {
  runId: string;
  action: 'clarification_response' | 'approve' | 'reject';
  content?: string;
}

interface ChannelAdapter {
  readonly channelType: ChannelType;
  readonly deliveryMode: DeliveryMode;
  readonly hilCapabilities: {
    clarification: boolean;
    approvalButtons: boolean;
    threadedReplies: boolean;
  };

  // Inbound
  validateRequest(req: NextRequest): Promise<boolean>;
  parseInbound(req: NextRequest): Promise<GatewayMessage>;
  sendAck(req: NextRequest, runId: string): Promise<Response>;

  // Outbound — result delivery
  sendResult(run: AgentOpsRun, events: AgentOpsEvent[]): Promise<void>;
  sendError(run: AgentOpsRun, error: string): Promise<void>;

  // Outbound — HIL
  sendClarification(run: AgentOpsRun, question: string): Promise<void>;
  sendApprovalRequest(run: AgentOpsRun, planSteps?: string[], pendingTools?: string[]): Promise<void>;

  // Outbound — streaming (optional, only for streaming-capable channels)
  sendStreamChunk?(run: AgentOpsRun, event: AgentOpsEvent): Promise<void>;

  // Config — returns channel credentials/settings from TenantConfigService
  // ChannelConfig is adapter-specific: SlackConfig has botToken + signingSecret,
  // DiscordConfig has applicationId + publicKey + botToken, etc.
  getConfig(tenantId: string): Promise<Record<string, unknown>>;
}
```

### Adapter Capability Matrix

| Channel | deliveryMode | validateRequest | sendAck | sendStreamChunk | clarification | approvalButtons | threadedReplies |
|---------|-------------|-----------------|---------|-----------------|:---:|:---:|:---:|
| Slack | `callback` | HMAC-SHA256 | 200 OK within 3s | N/A | yes | yes (Block Kit) | yes |
| Jira | `callback` | Bearer token | 200 OK with runId | N/A | yes (comments) | no (text keywords) | yes (issue thread) |
| Discord | `streaming` | Ed25519 signature | Deferred response (type 5) | Edit message progressively | yes | yes (button components) | yes |
| Telegram | `streaming` | Secret token header | sendMessage "Processing..." | editMessageText progressively | yes | yes (inline keyboards) | yes (reply chains) |
| Webhook | `callback` | HMAC (configurable) | 200 OK with runId | N/A | no | no | no |
| API | `polling` | Session/Bearer/API key | 200 OK with runId + threadId | N/A (client uses SSE) | no | no | no |

---

## Event Bus

Thin wrapper around Node.js `EventEmitter`, scoped per-run:

```typescript
type GatewayEventType =
  | 'run:started'
  | 'run:event'
  | 'run:completed'
  | 'run:failed'
  | 'run:cancelled'
  | 'hil:clarification'
  | 'hil:plan_approval'
  | 'hil:tool_approval';

interface GatewayEvent {
  type: GatewayEventType;
  runId: string;
  tenantId: string;
  timestamp: Date;
  data: {
    event?: AgentOpsEvent;
    run?: AgentOpsRun;
    question?: string;
    planSteps?: string[];
    pendingTools?: string[];
    error?: string;
  };
}

class GatewayEventBus {
  private emitter = new EventEmitter();

  emit(event: GatewayEvent): void;
  subscribe(runId: string, handler: (event: GatewayEvent) => void): () => void;
  subscribeOnce(runId: string, type: GatewayEventType, handler: (event: GatewayEvent) => void): void;
  cleanup(runId: string): void;
}
```

Singleton instance via `getGatewayEventBus()`. In-process, no external dependency.

---

## Notification Router

Subscribes to the event bus and dispatches to the originating channel's adapter:

```typescript
class NotificationRouter {
  constructor(
    private eventBus: GatewayEventBus,
    private adapterRegistry: AdapterRegistry
  ) {}

  attachToRun(run: AgentOpsRun): () => void {
    return this.eventBus.subscribe(run.runId, async (event) => {
      const adapter = this.adapterRegistry.get(run.source as ChannelType);

      switch (event.type) {
        case 'run:event':
          if (adapter.sendStreamChunk && adapter.deliveryMode === 'streaming') {
            await adapter.sendStreamChunk(run, event.data.event!);
          }
          break;

        case 'run:completed':
          // fetchRunEvents = existing AgentOpsEvent repository query (getEventsByRunId)
          const events = await fetchRunEvents(run.runId);
          await adapter.sendResult(run, events);
          break;

        case 'run:failed':
          await adapter.sendError(run, event.data.error!);
          break;

        case 'run:cancelled':
          await adapter.sendError(run, 'Run was cancelled.');
          break;

        case 'hil:clarification':
          if (adapter.hilCapabilities.clarification) {
            await adapter.sendClarification(run, event.data.question!);
          } else {
            const url = buildDashboardRespondUrl(run.runId);
            await adapter.sendError(run, `This run needs your input: ${url}`);
          }
          break;

        case 'hil:plan_approval':
          if (adapter.hilCapabilities.approvalButtons) {
            await adapter.sendApprovalRequest(run, event.data.planSteps);
          } else {
            const url = buildDashboardRespondUrl(run.runId);
            await adapter.sendError(run, `This run needs approval: ${url}`);
          }
          break;

        case 'hil:tool_approval':
          if (adapter.hilCapabilities.approvalButtons) {
            await adapter.sendApprovalRequest(run, undefined, event.data.pendingTools);
          } else {
            const url = buildDashboardRespondUrl(run.runId);
            await adapter.sendError(run, `This run needs tool approval: ${url}`);
          }
          break;
      }
    });
  }
}
```

---

## Gateway Service

The orchestrator that ties adapters, event bus, and executor together:

```typescript
class GatewayService {
  constructor(
    private registry: AdapterRegistry,
    private eventBus: GatewayEventBus,
    private router: NotificationRouter
  ) {}

  async handleInbound(channelType: ChannelType, req: NextRequest): Promise<Response> {
    const adapter = this.registry.get(channelType);

    // 1. Validate
    const valid = await adapter.validateRequest(req);
    if (!valid) return NextResponse.json({ error: 'Invalid request' }, { status: 401 });

    // 2. Parse
    const message = await adapter.parseInbound(req);

    // 3. HIL resume?
    if (message.replyContext) {
      return this.handleResume(adapter, message);
    }

    // 4. Create run
    const run = await createAgentOpsRun({
      tenantId: message.tenantId,
      source: channelType,
      taskDescription: message.taskDescription,
      mode: message.mode,
      autoApprove: message.autoApprove,
      trigger: message.channelMeta,
    });

    // 5. Attach notification router
    const detach = this.router.attachToRun(run);

    // 6. Ack immediately
    const ackResponse = await adapter.sendAck(req, run.runId);

    // 7. Fire-and-forget execution
    executeAgentRun(run, this.eventBus)
      .finally(() => {
        detach();
        this.eventBus.cleanup(run.runId);
      });

    return ackResponse;
  }

  private async handleResume(adapter: ChannelAdapter, message: GatewayMessage): Promise<Response> {
    const { runId, action, content } = message.replyContext!;

    if (action === 'approve') {
      await resumeApprovedRun(runId, this.eventBus);
    } else if (action === 'reject') {
      await cancelRun(runId);
    } else if (action === 'clarification_response') {
      await resumeWithClarification(runId, content!, this.eventBus);
    }

    return NextResponse.json({ success: true });
  }
}
```

---

## Adapter Registry

```typescript
class AdapterRegistry {
  private adapters = new Map<ChannelType, ChannelAdapter>();

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.channelType, adapter);
  }

  get(channelType: ChannelType): ChannelAdapter {
    const adapter = this.adapters.get(channelType);
    if (!adapter) throw new GatewayError(`No adapter registered for channel: ${channelType}`);
    return adapter;
  }

  has(channelType: ChannelType): boolean {
    return this.adapters.has(channelType);
  }

  list(): ChannelType[] {
    return Array.from(this.adapters.keys());
  }
}
```

Bootstrap in `lib/gateway/index.ts`:

```typescript
const registry = new AdapterRegistry();
registry.register(new SlackAdapter());
registry.register(new JiraAdapter());
registry.register(new DiscordAdapter());
registry.register(new TelegramAdapter());
registry.register(new WebhookAdapter());
registry.register(new ApiAdapter());
```

---

## SSE Streaming Endpoint

```typescript
// app/api/v1/gateway/stream/[runId]/route.ts
export async function GET(req: NextRequest, { params }: { params: { runId: string } }) {
  // Auth check (session or bearer token)
  const stream = new ReadableStream({
    start(controller) {
      const unsubscribe = eventBus.subscribe(params.runId, (event) => {
        controller.enqueue(`data: ${JSON.stringify(event)}\n\n`);
        if (event.type === 'run:completed' || event.type === 'run:failed') {
          controller.close();
          unsubscribe();
        }
      });
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    }
  });
}
```

---

## HIL Flow — Channel-First with Dashboard Fallback

```
Executor hits interrupt
        │
        ▼
EventBus emits hil:clarification or hil:plan_approval or hil:tool_approval
        │
        ▼
NotificationRouter checks adapter.hilCapabilities
        │
        ├── Adapter supports it?
        │       YES → adapter.sendClarification() or adapter.sendApprovalRequest()
        │              (channel-native: Slack buttons, Discord buttons, Telegram keyboards)
        │              + append dashboard link as fallback
        │
        └── Adapter doesn't support it? (webhook, API)
                NO → Send dashboard URL: /app/agent-ops/{runId}/respond
```

**Cross-channel resume:** A run triggered from Slack can be approved from the dashboard. `handleResume()` only needs `runId` and action — it doesn't care which channel the response came from. Results still go back to the originating channel because `run.source` is unchanged.

**Dashboard fallback page:** `app/app/agent-ops/[runId]/respond/page.tsx` — shows run summary, clarification question or plan steps, and approve/reject/respond form. Submits to existing `/api/agent-ops/[runId]/approve` or `/resume` endpoints.

---

## Adapter Details

### Slack Adapter

Refactored from existing `slack-notifier.ts` + `slack-validator.ts`.

- **Inbound:** Slash command text, interaction payloads (button clicks), thread replies for HIL
- **Outbound:** Block Kit messages via `response_url` or `chat.postMessage` (if bot token configured)
- **Approval:** Block Kit ActionRow with Approve/Reject buttons
- **Limitation:** `response_url` expires in 30 minutes. Long-running tasks may fail to deliver results. Bot token + `chat.postMessage` is the reliable path.

### Jira Adapter

Refactored from existing `jira-notifier.ts` + `jira-validator.ts`.

- **Inbound:** Webhook payloads, @bot mentions (ADF parsing), comment keywords ("approve"/"reject")
- **Outbound:** Issue comments via Jira REST API
- **Approval:** Text-based ("reply APPROVE or REJECT") + dashboard fallback link for button-based approval
- **Bot loop prevention:** Skip comments from the bot's own user ID

### Discord Adapter (new)

- **Inbound:** Slash command interactions, button interactions, thread messages
- **Validation:** Ed25519 signature verification (Discord requirement for all interactions)
- **Outbound:** Rich embeds with color-coded status, edited deferred messages
- **Streaming:** Edit deferred message with progressive content. Rate-limited to batch updates every 1-2 seconds (Discord allows 5 edits per 5 seconds per channel).
- **Approval:** ActionRow with Approve/Reject buttons. `customId` encodes `runId` for stateless routing.
- **Ack:** Deferred response (interaction type 5) gives 15 minutes to follow up.

### Telegram Adapter (new)

- **Inbound:** Bot commands (`/cloudops <task>`), callback queries (button presses), reply-to-message for HIL
- **Validation:** `X-Telegram-Bot-Api-Secret-Token` header verification
- **Outbound:** MarkdownV2 formatted messages via Bot API
- **Streaming:** `editMessageText` with progressive content. Rate-limited (~30 edits/minute per chat).
- **Approval:** Inline keyboard with Approve/Reject buttons. `callback_data` encodes `runId` + action.
- **Ack:** `sendMessage` with "Processing..." text, store `messageId` for later editing.

### Webhook Adapter (new)

- **Inbound:** JSON body with `taskDescription`, `tenantId`, `callbackUrl`. Optional `replyContext` for programmatic approve/reject.
- **Validation:** HMAC-SHA256 with tenant-configured webhook secret
- **Outbound:** HTTP POST to `callbackUrl` with `{ runId, status, summary, toolsUsed, duration }`. Retry with exponential backoff (3 attempts).
- **HIL:** POST to `callbackUrl` with `{ runId, status: 'awaiting_input', question, dashboardUrl }`. External system must POST back to `/api/v1/gateway/webhook` with `replyContext`.
- **No streaming, no buttons, no threads.** Pure request/callback.

### API Adapter

Refactored from existing `/api/v1/trigger/api` logic.

- **Inbound:** JSON body with `taskDescription`, optional `accountId`, `mode`, `autoApprove`
- **Validation:** Session, Bearer token, or API key header
- **Outbound:** None — caller polls `/api/agent-ops/[runId]` or subscribes to SSE at `/api/v1/gateway/stream/[runId]`
- **HIL:** Dashboard only (no push mechanism). Caller detects `awaiting_input`/`awaiting_approval` status via polling.

---

## File Structure

```
web-ui/lib/gateway/
├── types.ts                    # GatewayMessage, GatewayEvent, ChannelAdapter interface
├── gateway-service.ts          # GatewayService class
├── event-bus.ts                # GatewayEventBus
├── notification-router.ts      # NotificationRouter
├── adapter-registry.ts         # AdapterRegistry
├── index.ts                    # Bootstrap: register adapters, export getGatewayService()
├── adapters/
│   ├── slack-adapter.ts        # Refactored from agent-ops/slack-notifier + slack-validator
│   ├── jira-adapter.ts         # Refactored from agent-ops/jira-notifier + jira-validator
│   ├── discord-adapter.ts      # New
│   ├── telegram-adapter.ts     # New
│   ├── webhook-adapter.ts      # New
│   └── api-adapter.ts          # Refactored from existing trigger/api logic
└── utils/
    ├── rate-limiter.ts         # Per-channel rate limiting for streaming edits
    └── dashboard-url.ts        # Generate fallback dashboard URLs

web-ui/app/api/v1/gateway/
├── slack/route.ts
├── jira/route.ts
├── discord/route.ts
├── telegram/route.ts
├── webhook/route.ts
├── api/route.ts
└── stream/[runId]/route.ts     # SSE endpoint

web-ui/app/app/agent-ops/[runId]/respond/
└── page.tsx                    # Dashboard fallback for HIL
```

## Migration — Existing Files

| Existing File | Action |
|---|---|
| `lib/agent-ops/slack-notifier.ts` | Logic moves to `gateway/adapters/slack-adapter.ts`. Delete. |
| `lib/agent-ops/slack-validator.ts` | Logic moves to `SlackAdapter.validateRequest()`. Delete. |
| `lib/agent-ops/jira-notifier.ts` | Logic moves to `gateway/adapters/jira-adapter.ts`. Delete. |
| `lib/agent-ops/jira-validator.ts` | Logic moves to `JiraAdapter.validateRequest()`. Delete. |
| `lib/agent-ops/agent-executor.ts` | Modify: replace direct notifier calls with `eventBus.emit()`. Accept `GatewayEventBus` param. |
| `lib/agent-ops/agent-ops-service.ts` | Modify: route through `GatewayService` instead of calling executor directly. |
| `lib/agent-ops/scheduled-notifier.ts` | Modify: use notification router instead of direct Slack/Jira calls. |
| `app/api/v1/trigger/slack/route.ts` | Replace with `app/api/v1/gateway/slack/route.ts`. Delete. |
| `app/api/v1/trigger/jira/route.ts` | Replace with `app/api/v1/gateway/jira/route.ts`. Delete. |
| `app/api/v1/trigger/api/route.ts` | Replace with `app/api/v1/gateway/api/route.ts`. Delete. |
| `lib/agent-ops/run-manager.ts` | Unchanged. |
| `lib/agent-ops/executor-graphs.ts` | Unchanged. |
| `lib/agent-ops/executor-state.ts` | Unchanged. |
| `lib/agent-ops/tool-classifier.ts` | Unchanged. |
| `lib/agent-ops/export-pdf.ts` | Unchanged. |
| `lib/agent-ops/scheduler-engine.ts` | Unchanged. |
| `lib/agent-ops/scheduled-task-service.ts` | Unchanged. |

---

## Executor Changes

The only change to `agent-executor.ts` is replacing direct notifier calls with event bus emissions:

**Before:**
```typescript
async function executeAgentRun(run: AgentOpsRun): Promise<void>

// Inside the function:
if (run.source === 'slack') {
  await postResultToSlack(run, responseUrl);
} else if (run.source === 'jira') {
  await postResultToJira(run, issueKey, jiraConfig);
}
```

**After:**
```typescript
async function executeAgentRun(run: AgentOpsRun, eventBus: GatewayEventBus): Promise<void>

// Inside the function:
eventBus.emit({
  type: 'run:completed',
  runId: run.runId,
  tenantId: run.tenantId,
  timestamp: new Date(),
  data: { run }
});
```

Same pattern for clarification, approval, error, and per-event emissions. The executor becomes channel-blind.

---

## Backward Compatibility

Existing Slack slash command URLs and Jira webhook URLs point to `/api/v1/trigger/slack` and `/api/v1/trigger/jira`. After migration, these move to `/api/v1/gateway/slack` and `/api/v1/gateway/jira`.

Options:
1. **Update external configs** — change Slack app slash command URL and Jira webhook URL to new paths. Clean break.
2. **Redirect routes** — keep old `/api/v1/trigger/*` routes as thin redirects to `/api/v1/gateway/*` during transition. Remove after confirming all integrations updated.

Recommendation: Option 2 (redirects) for zero-downtime migration.

---

## Dependencies (new packages)

| Package | Purpose | Channel |
|---------|---------|---------|
| `tweetnacl` | Ed25519 signature verification | Discord |
| `node-telegram-bot-api` or raw `fetch` | Telegram Bot API client | Telegram |

Slack and Jira use existing dependencies (`@slack/web-api` patterns, `fetch` for Jira REST API). No new packages needed for those.

Discord and Telegram adapters can use raw `fetch` against their REST APIs to avoid heavy SDK dependencies. `tweetnacl` is lightweight (Ed25519 only) and widely used for Discord verification.

---

## Testing Strategy

- **Unit tests** for each adapter: mock HTTP requests, verify `parseInbound()` returns correct `GatewayMessage`, verify `sendResult()` formats correctly
- **Unit tests** for event bus: emit/subscribe/cleanup lifecycle
- **Unit tests** for notification router: verify correct adapter dispatch per event type, verify HIL fallback to dashboard URL
- **Unit tests** for gateway service: end-to-end flow from `handleInbound()` to executor call
- **Integration test** for SSE endpoint: verify event streaming and connection cleanup
- **Property-based tests** (fast-check): fuzz `parseInbound()` with malformed payloads to verify validation catches them

Test files colocated in `web-ui/tests/gateway/`.

---

## Out of Scope

- Message queue (SQS/pg-boss) between gateway and executor — deferred to future iteration if scale demands it
- Multi-channel fan-out (sending results to multiple channels for a single run) — single originating channel only
- Channel-specific rich formatting beyond what's described (e.g., Slack modals, Discord threads with multiple embeds)
- Tenant-level channel enable/disable flags — all registered adapters available to all tenants
- Rate limiting at the gateway level (per-tenant, per-channel) — adapters handle their own API rate limits
