# Channel Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple agent-ops channels from the executor via a gateway middleware with plug-and-play channel adapters, in-process event bus, notification router, and SSE streaming.

**Architecture:** Gateway-as-Middleware pattern inside Next.js. Channel adapters implement a unified `ChannelAdapter` interface. The executor emits events to an in-process `EventEmitter`-based event bus. A `NotificationRouter` subscribes to the bus and dispatches to the originating channel's adapter. SSE endpoint streams events to real-time clients.

**Tech Stack:** TypeScript, Next.js 15 App Router, Node.js EventEmitter, `tweetnacl` (Discord Ed25519), Vitest, fast-check

**Spec:** `docs/superpowers/specs/2026-05-01-channel-gateway-design.md`

---

## File Map

### New Files (lib/gateway/)

| File | Responsibility |
|------|---------------|
| `web-ui/lib/gateway/types.ts` | All gateway types: ChannelType, DeliveryMode, GatewayMessage, ReplyContext, GatewayEvent, GatewayEventType, ChannelAdapter interface |
| `web-ui/lib/gateway/event-bus.ts` | GatewayEventBus class — EventEmitter wrapper scoped per-run |
| `web-ui/lib/gateway/adapter-registry.ts` | AdapterRegistry class — static Map of ChannelType → ChannelAdapter |
| `web-ui/lib/gateway/notification-router.ts` | NotificationRouter — subscribes to event bus, dispatches to adapters |
| `web-ui/lib/gateway/gateway-service.ts` | GatewayService — orchestrates inbound handling, run creation, resume |
| `web-ui/lib/gateway/index.ts` | Bootstrap: register all adapters, export singleton getGatewayService() |
| `web-ui/lib/gateway/utils/dashboard-url.ts` | buildDashboardRespondUrl() helper |
| `web-ui/lib/gateway/utils/rate-limiter.ts` | Per-channel rate limiter for streaming message edits |
| `web-ui/lib/gateway/adapters/slack-adapter.ts` | SlackAdapter — refactored from slack-notifier + slack-validator |
| `web-ui/lib/gateway/adapters/jira-adapter.ts` | JiraAdapter — refactored from jira-notifier + jira-validator |
| `web-ui/lib/gateway/adapters/discord-adapter.ts` | DiscordAdapter — new, Ed25519 validation, rich embeds, streaming |
| `web-ui/lib/gateway/adapters/telegram-adapter.ts` | TelegramAdapter — new, Bot API, inline keyboards, streaming |
| `web-ui/lib/gateway/adapters/webhook-adapter.ts` | WebhookAdapter — new, generic HTTP callback with HMAC |
| `web-ui/lib/gateway/adapters/api-adapter.ts` | ApiAdapter — refactored from trigger/api route logic |

### New Files (API routes)

| File | Responsibility |
|------|---------------|
| `web-ui/app/api/v1/gateway/slack/route.ts` | Thin route → getGatewayService().handleInbound('slack', req) |
| `web-ui/app/api/v1/gateway/slack/interactions/route.ts` | Slack Block Kit button interactions |
| `web-ui/app/api/v1/gateway/jira/route.ts` | Thin route → handleInbound('jira', req) |
| `web-ui/app/api/v1/gateway/discord/route.ts` | Thin route → handleInbound('discord', req) |
| `web-ui/app/api/v1/gateway/telegram/route.ts` | Thin route → handleInbound('telegram', req) |
| `web-ui/app/api/v1/gateway/webhook/route.ts` | Thin route → handleInbound('webhook', req) |
| `web-ui/app/api/v1/gateway/api/route.ts` | Thin route → handleInbound('api', req) |
| `web-ui/app/api/v1/gateway/stream/[runId]/route.ts` | SSE streaming endpoint |

### New Files (UI)

| File | Responsibility |
|------|---------------|
| `web-ui/app/app/agent-ops/[runId]/respond/page.tsx` | Dashboard fallback HIL page |

### New Files (Tests)

| File | Responsibility |
|------|---------------|
| `web-ui/tests/gateway/event-bus.test.ts` | Event bus unit tests |
| `web-ui/tests/gateway/adapter-registry.test.ts` | Registry unit tests |
| `web-ui/tests/gateway/notification-router.test.ts` | Router dispatch + HIL fallback tests |
| `web-ui/tests/gateway/gateway-service.test.ts` | Gateway service orchestration tests |
| `web-ui/tests/gateway/adapters/slack-adapter.test.ts` | Slack adapter tests |
| `web-ui/tests/gateway/adapters/jira-adapter.test.ts` | Jira adapter tests |
| `web-ui/tests/gateway/adapters/discord-adapter.test.ts` | Discord adapter tests |
| `web-ui/tests/gateway/adapters/telegram-adapter.test.ts` | Telegram adapter tests |
| `web-ui/tests/gateway/adapters/webhook-adapter.test.ts` | Webhook adapter tests |
| `web-ui/tests/gateway/adapters/api-adapter.test.ts` | API adapter tests |

### Modified Files

| File | Change |
|------|--------|
| `web-ui/lib/agent-ops/agent-executor.ts` | Add `eventBus` param to `executeAgentRun()` and `resumeApprovedRun()`. Replace direct notifier calls with `eventBus.emit()`. |
| `web-ui/lib/agent-ops/scheduled-notifier.ts` | Use notification router instead of direct Slack/Jira calls |
| `web-ui/lib/agent-ops/types.ts` | Add `'discord' \| 'telegram' \| 'webhook'` to TriggerSource. Add new trigger meta types. |

### Deleted Files (after migration)

| File | Replaced By |
|------|------------|
| `web-ui/lib/agent-ops/slack-notifier.ts` | `gateway/adapters/slack-adapter.ts` |
| `web-ui/lib/agent-ops/slack-validator.ts` | `SlackAdapter.validateRequest()` |
| `web-ui/lib/agent-ops/jira-notifier.ts` | `gateway/adapters/jira-adapter.ts` |
| `web-ui/lib/agent-ops/jira-validator.ts` | `JiraAdapter.validateRequest()` |

### Redirect Files (backward compat)

| File | Purpose |
|------|---------|
| `web-ui/app/api/v1/trigger/slack/route.ts` | Redirect to /api/v1/gateway/slack |
| `web-ui/app/api/v1/trigger/slack/interactions/route.ts` | Redirect to /api/v1/gateway/slack/interactions |
| `web-ui/app/api/v1/trigger/jira/route.ts` | Redirect to /api/v1/gateway/jira |
| `web-ui/app/api/v1/trigger/api/route.ts` | Redirect to /api/v1/gateway/api |

---

## Phase 1: Core Gateway Infrastructure

### Task 1: Gateway Types

**Files:**
- Create: `web-ui/lib/gateway/types.ts`
- Test: `web-ui/tests/gateway/types.test.ts`

- [ ] **Step 1: Write type validation test**

```typescript
// web-ui/tests/gateway/types.test.ts
import { describe, it, expect } from 'vitest';
import type {
    ChannelType, DeliveryMode, GatewayMessage, ReplyContext,
    GatewayEventType, GatewayEvent, ChannelAdapter, HilCapabilities,
} from '@/lib/gateway/types';

describe('Gateway Types', () => {
    it('GatewayMessage accepts all channel types', () => {
        const channels: ChannelType[] = ['slack', 'jira', 'discord', 'telegram', 'webhook', 'api'];
        for (const ch of channels) {
            const msg: GatewayMessage = {
                channelType: ch,
                tenantId: 'tenant-1',
                taskDescription: 'test task',
                channelMeta: {},
            };
            expect(msg.channelType).toBe(ch);
        }
    });

    it('ReplyContext supports all actions', () => {
        const actions: ReplyContext['action'][] = ['clarification_response', 'approve', 'reject'];
        for (const action of actions) {
            const ctx: ReplyContext = { runId: 'run-1', action };
            expect(ctx.action).toBe(action);
        }
    });

    it('GatewayEvent supports all event types', () => {
        const types: GatewayEventType[] = [
            'run:started', 'run:event', 'run:completed', 'run:failed',
            'run:cancelled', 'hil:clarification', 'hil:plan_approval', 'hil:tool_approval',
        ];
        for (const type of types) {
            const event: GatewayEvent = {
                type, runId: 'run-1', tenantId: 'tenant-1',
                timestamp: new Date(), data: {},
            };
            expect(event.type).toBe(type);
        }
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web-ui && npx vitest run tests/gateway/types.test.ts`
Expected: FAIL — module `@/lib/gateway/types` not found

- [ ] **Step 3: Create types.ts**

```typescript
// web-ui/lib/gateway/types.ts
import type { NextRequest } from 'next/server';
import type { AgentOpsRun, AgentOpsEvent } from '@/lib/agent-ops/types';

export type ChannelType = 'slack' | 'jira' | 'discord' | 'telegram' | 'webhook' | 'api';

export type DeliveryMode = 'streaming' | 'callback' | 'polling';

export interface HilCapabilities {
    clarification: boolean;
    approvalButtons: boolean;
    threadedReplies: boolean;
}

export interface GatewayMessage {
    channelType: ChannelType;
    tenantId: string;
    taskDescription: string;
    userId?: string;
    mode?: 'fast' | 'plan';
    autoApprove?: boolean;
    accountId?: string;
    accountName?: string;
    selectedSkill?: string;
    mcpServerIds?: string[];
    model?: string;
    replyContext?: ReplyContext;
    channelMeta: Record<string, unknown>;
}

export interface ReplyContext {
    runId: string;
    action: 'clarification_response' | 'approve' | 'reject';
    content?: string;
    tenantId?: string;
}

export type GatewayEventType =
    | 'run:started'
    | 'run:event'
    | 'run:completed'
    | 'run:failed'
    | 'run:cancelled'
    | 'hil:clarification'
    | 'hil:plan_approval'
    | 'hil:tool_approval';

export interface GatewayEvent {
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

export interface ChannelAdapter {
    readonly channelType: ChannelType;
    readonly deliveryMode: DeliveryMode;
    readonly hilCapabilities: HilCapabilities;

    validateRequest(req: NextRequest): Promise<boolean>;
    parseInbound(req: NextRequest): Promise<GatewayMessage>;
    sendAck(req: NextRequest, runId: string): Promise<Response>;

    sendResult(run: AgentOpsRun, events: AgentOpsEvent[]): Promise<void>;
    sendError(run: AgentOpsRun, error: string): Promise<void>;

    sendClarification(run: AgentOpsRun, question: string): Promise<void>;
    sendApprovalRequest(run: AgentOpsRun, planSteps?: string[], pendingTools?: string[]): Promise<void>;

    sendStreamChunk?(run: AgentOpsRun, event: AgentOpsEvent): Promise<void>;

    getConfig(tenantId: string): Promise<Record<string, unknown>>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web-ui && npx vitest run tests/gateway/types.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web-ui/lib/gateway/types.ts web-ui/tests/gateway/types.test.ts
git commit -m "feat(gateway): add core gateway type definitions"
```

---

### Task 2: Event Bus

**Files:**
- Create: `web-ui/lib/gateway/event-bus.ts`
- Test: `web-ui/tests/gateway/event-bus.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// web-ui/tests/gateway/event-bus.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GatewayEventBus } from '@/lib/gateway/event-bus';
import type { GatewayEvent } from '@/lib/gateway/types';

function makeEvent(runId: string, type: GatewayEvent['type'] = 'run:event'): GatewayEvent {
    return { type, runId, tenantId: 'tenant-1', timestamp: new Date(), data: {} };
}

describe('GatewayEventBus', () => {
    let bus: GatewayEventBus;

    beforeEach(() => {
        bus = new GatewayEventBus();
    });

    it('delivers events to subscribers for matching runId', () => {
        const handler = vi.fn();
        bus.subscribe('run-1', handler);
        bus.emit(makeEvent('run-1'));
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('does not deliver events for non-matching runId', () => {
        const handler = vi.fn();
        bus.subscribe('run-1', handler);
        bus.emit(makeEvent('run-2'));
        expect(handler).not.toHaveBeenCalled();
    });

    it('unsubscribe stops delivery', () => {
        const handler = vi.fn();
        const unsub = bus.subscribe('run-1', handler);
        unsub();
        bus.emit(makeEvent('run-1'));
        expect(handler).not.toHaveBeenCalled();
    });

    it('cleanup removes all listeners for a runId', () => {
        const h1 = vi.fn();
        const h2 = vi.fn();
        bus.subscribe('run-1', h1);
        bus.subscribe('run-1', h2);
        bus.cleanup('run-1');
        bus.emit(makeEvent('run-1'));
        expect(h1).not.toHaveBeenCalled();
        expect(h2).not.toHaveBeenCalled();
    });

    it('subscribeOnce fires only once for matching type', () => {
        const handler = vi.fn();
        bus.subscribeOnce('run-1', 'run:completed', handler);
        bus.emit(makeEvent('run-1', 'run:event'));
        expect(handler).not.toHaveBeenCalled();
        bus.emit(makeEvent('run-1', 'run:completed'));
        expect(handler).toHaveBeenCalledTimes(1);
        bus.emit(makeEvent('run-1', 'run:completed'));
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('supports multiple subscribers for same runId', () => {
        const h1 = vi.fn();
        const h2 = vi.fn();
        bus.subscribe('run-1', h1);
        bus.subscribe('run-1', h2);
        bus.emit(makeEvent('run-1'));
        expect(h1).toHaveBeenCalledTimes(1);
        expect(h2).toHaveBeenCalledTimes(1);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web-ui && npx vitest run tests/gateway/event-bus.test.ts`
Expected: FAIL — module `@/lib/gateway/event-bus` not found

- [ ] **Step 3: Implement event-bus.ts**

```typescript
// web-ui/lib/gateway/event-bus.ts
import { EventEmitter } from 'events';
import type { GatewayEvent, GatewayEventType } from './types';

export class GatewayEventBus {
    private emitter = new EventEmitter();

    constructor() {
        this.emitter.setMaxListeners(100);
    }

    emit(event: GatewayEvent): void {
        this.emitter.emit(`run:${event.runId}`, event);
    }

    subscribe(runId: string, handler: (event: GatewayEvent) => void): () => void {
        const key = `run:${runId}`;
        this.emitter.on(key, handler);
        return () => { this.emitter.removeListener(key, handler); };
    }

    subscribeOnce(runId: string, type: GatewayEventType, handler: (event: GatewayEvent) => void): void {
        const key = `run:${runId}`;
        const wrapper = (event: GatewayEvent) => {
            if (event.type === type) {
                this.emitter.removeListener(key, wrapper);
                handler(event);
            }
        };
        this.emitter.on(key, wrapper);
    }

    cleanup(runId: string): void {
        this.emitter.removeAllListeners(`run:${runId}`);
    }
}

const g = globalThis as typeof globalThis & { _gatewayEventBus?: GatewayEventBus };

export function getGatewayEventBus(): GatewayEventBus {
    if (!g._gatewayEventBus) {
        g._gatewayEventBus = new GatewayEventBus();
    }
    return g._gatewayEventBus;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web-ui && npx vitest run tests/gateway/event-bus.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add web-ui/lib/gateway/event-bus.ts web-ui/tests/gateway/event-bus.test.ts
git commit -m "feat(gateway): add GatewayEventBus with per-run scoping"
```

---

### Task 3: Adapter Registry

**Files:**
- Create: `web-ui/lib/gateway/adapter-registry.ts`
- Test: `web-ui/tests/gateway/adapter-registry.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// web-ui/tests/gateway/adapter-registry.test.ts
import { describe, it, expect } from 'vitest';
import { AdapterRegistry } from '@/lib/gateway/adapter-registry';
import type { ChannelAdapter } from '@/lib/gateway/types';

function makeMockAdapter(channelType: string): ChannelAdapter {
    return {
        channelType: channelType as any,
        deliveryMode: 'callback',
        hilCapabilities: { clarification: false, approvalButtons: false, threadedReplies: false },
        validateRequest: async () => true,
        parseInbound: async () => ({ channelType: channelType as any, tenantId: 't', taskDescription: 'd', channelMeta: {} }),
        sendAck: async () => new Response(null, { status: 200 }),
        sendResult: async () => {},
        sendError: async () => {},
        sendClarification: async () => {},
        sendApprovalRequest: async () => {},
        getConfig: async () => ({}),
    };
}

describe('AdapterRegistry', () => {
    it('registers and retrieves an adapter', () => {
        const registry = new AdapterRegistry();
        const adapter = makeMockAdapter('slack');
        registry.register(adapter);
        expect(registry.get('slack')).toBe(adapter);
    });

    it('throws on unknown channel type', () => {
        const registry = new AdapterRegistry();
        expect(() => registry.get('slack')).toThrow('No adapter registered for channel: slack');
    });

    it('has() returns correct boolean', () => {
        const registry = new AdapterRegistry();
        expect(registry.has('slack')).toBe(false);
        registry.register(makeMockAdapter('slack'));
        expect(registry.has('slack')).toBe(true);
    });

    it('list() returns all registered channel types', () => {
        const registry = new AdapterRegistry();
        registry.register(makeMockAdapter('slack'));
        registry.register(makeMockAdapter('jira'));
        expect(registry.list()).toEqual(['slack', 'jira']);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web-ui && npx vitest run tests/gateway/adapter-registry.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement adapter-registry.ts**

```typescript
// web-ui/lib/gateway/adapter-registry.ts
import type { ChannelType, ChannelAdapter } from './types';

export class AdapterRegistry {
    private adapters = new Map<ChannelType, ChannelAdapter>();

    register(adapter: ChannelAdapter): void {
        this.adapters.set(adapter.channelType, adapter);
    }

    get(channelType: ChannelType): ChannelAdapter {
        const adapter = this.adapters.get(channelType);
        if (!adapter) throw new Error(`No adapter registered for channel: ${channelType}`);
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

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web-ui && npx vitest run tests/gateway/adapter-registry.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add web-ui/lib/gateway/adapter-registry.ts web-ui/tests/gateway/adapter-registry.test.ts
git commit -m "feat(gateway): add AdapterRegistry with static channel map"
```

---

### Task 4: Dashboard URL Utility + Rate Limiter

**Files:**
- Create: `web-ui/lib/gateway/utils/dashboard-url.ts`
- Create: `web-ui/lib/gateway/utils/rate-limiter.ts`

- [ ] **Step 1: Create dashboard-url.ts**

```typescript
// web-ui/lib/gateway/utils/dashboard-url.ts
const APP_BASE_URL = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001';

export function buildDashboardRespondUrl(runId: string): string {
    return `${APP_BASE_URL}/app/agent-ops/${runId}/respond`;
}
```

- [ ] **Step 2: Create rate-limiter.ts**

```typescript
// web-ui/lib/gateway/utils/rate-limiter.ts
export class ChannelRateLimiter {
    private lastSent = new Map<string, number>();

    constructor(private minIntervalMs: number) {}

    shouldSend(key: string): boolean {
        const now = Date.now();
        const last = this.lastSent.get(key) ?? 0;
        if (now - last < this.minIntervalMs) return false;
        this.lastSent.set(key, now);
        return true;
    }

    reset(key: string): void {
        this.lastSent.delete(key);
    }
}
```

- [ ] **Step 3: Commit**

```bash
git add web-ui/lib/gateway/utils/dashboard-url.ts web-ui/lib/gateway/utils/rate-limiter.ts
git commit -m "feat(gateway): add dashboard URL helper and channel rate limiter"
```

---

### Task 5: Notification Router

**Files:**
- Create: `web-ui/lib/gateway/notification-router.ts`
- Test: `web-ui/tests/gateway/notification-router.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// web-ui/tests/gateway/notification-router.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationRouter } from '@/lib/gateway/notification-router';
import { GatewayEventBus } from '@/lib/gateway/event-bus';
import { AdapterRegistry } from '@/lib/gateway/adapter-registry';
import type { ChannelAdapter, GatewayEvent } from '@/lib/gateway/types';
import type { AgentOpsRun } from '@/lib/agent-ops/types';

function makeMockAdapter(overrides: Partial<ChannelAdapter> = {}): ChannelAdapter {
    return {
        channelType: 'slack',
        deliveryMode: 'callback',
        hilCapabilities: { clarification: true, approvalButtons: true, threadedReplies: true },
        validateRequest: vi.fn(),
        parseInbound: vi.fn(),
        sendAck: vi.fn(),
        sendResult: vi.fn().mockResolvedValue(undefined),
        sendError: vi.fn().mockResolvedValue(undefined),
        sendClarification: vi.fn().mockResolvedValue(undefined),
        sendApprovalRequest: vi.fn().mockResolvedValue(undefined),
        getConfig: vi.fn(),
        ...overrides,
    } as any;
}

function makeRun(source = 'slack'): AgentOpsRun {
    return { runId: 'run-1', tenantId: 'tenant-1', source } as any;
}

describe('NotificationRouter', () => {
    let bus: GatewayEventBus;
    let registry: AdapterRegistry;
    let router: NotificationRouter;
    let adapter: ChannelAdapter;

    beforeEach(() => {
        bus = new GatewayEventBus();
        registry = new AdapterRegistry();
        adapter = makeMockAdapter();
        registry.register(adapter);
        router = new NotificationRouter(bus, registry);
    });

    it('dispatches run:completed to adapter.sendResult', async () => {
        router.attachToRun(makeRun());
        bus.emit({ type: 'run:completed', runId: 'run-1', tenantId: 'tenant-1', timestamp: new Date(), data: { run: makeRun() } });
        await new Promise(r => setTimeout(r, 50));
        expect(adapter.sendResult).toHaveBeenCalled();
    });

    it('dispatches run:failed to adapter.sendError', async () => {
        router.attachToRun(makeRun());
        bus.emit({ type: 'run:failed', runId: 'run-1', tenantId: 'tenant-1', timestamp: new Date(), data: { error: 'boom' } });
        await new Promise(r => setTimeout(r, 50));
        expect(adapter.sendError).toHaveBeenCalledWith(expect.anything(), 'boom');
    });

    it('dispatches run:cancelled to adapter.sendError', async () => {
        router.attachToRun(makeRun());
        bus.emit({ type: 'run:cancelled', runId: 'run-1', tenantId: 'tenant-1', timestamp: new Date(), data: {} });
        await new Promise(r => setTimeout(r, 50));
        expect(adapter.sendError).toHaveBeenCalledWith(expect.anything(), 'Run was cancelled.');
    });

    it('dispatches hil:clarification to adapter.sendClarification', async () => {
        router.attachToRun(makeRun());
        bus.emit({ type: 'hil:clarification', runId: 'run-1', tenantId: 'tenant-1', timestamp: new Date(), data: { question: 'Which account?' } });
        await new Promise(r => setTimeout(r, 50));
        expect(adapter.sendClarification).toHaveBeenCalledWith(expect.anything(), 'Which account?');
    });

    it('falls back to dashboard URL when adapter lacks HIL capability', async () => {
        const noHilAdapter = makeMockAdapter({
            hilCapabilities: { clarification: false, approvalButtons: false, threadedReplies: false },
        });
        registry = new AdapterRegistry();
        registry.register(noHilAdapter);
        router = new NotificationRouter(bus, registry);

        router.attachToRun(makeRun());
        bus.emit({ type: 'hil:clarification', runId: 'run-1', tenantId: 'tenant-1', timestamp: new Date(), data: { question: 'Which account?' } });
        await new Promise(r => setTimeout(r, 50));
        expect(noHilAdapter.sendError).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('/app/agent-ops/run-1/respond'));
    });

    it('detach stops event delivery', async () => {
        const detach = router.attachToRun(makeRun());
        detach();
        bus.emit({ type: 'run:completed', runId: 'run-1', tenantId: 'tenant-1', timestamp: new Date(), data: { run: makeRun() } });
        await new Promise(r => setTimeout(r, 50));
        expect(adapter.sendResult).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web-ui && npx vitest run tests/gateway/notification-router.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement notification-router.ts**

```typescript
// web-ui/lib/gateway/notification-router.ts
import type { GatewayEventBus } from './event-bus';
import type { AdapterRegistry } from './adapter-registry';
import type { ChannelType, GatewayEvent } from './types';
import type { AgentOpsRun } from '@/lib/agent-ops/types';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { buildDashboardRespondUrl } from './utils/dashboard-url';

export class NotificationRouter {
    constructor(
        private eventBus: GatewayEventBus,
        private adapterRegistry: AdapterRegistry,
    ) {}

    attachToRun(run: AgentOpsRun): () => void {
        return this.eventBus.subscribe(run.runId, async (event: GatewayEvent) => {
            try {
                const adapter = this.adapterRegistry.get(run.source as ChannelType);

                switch (event.type) {
                    case 'run:event':
                        if (adapter.sendStreamChunk && adapter.deliveryMode === 'streaming') {
                            await adapter.sendStreamChunk(run, event.data.event!);
                        }
                        break;

                    case 'run:completed': {
                        const events = await agentOpsService.getRunEvents(run.runId, run.tenantId);
                        await adapter.sendResult(event.data.run ?? run, events);
                        break;
                    }

                    case 'run:failed':
                        await adapter.sendError(run, event.data.error ?? 'Unknown error');
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
            } catch (err) {
                console.error(`[NotificationRouter] Error dispatching ${event.type} for run ${run.runId}:`, err);
            }
        });
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web-ui && npx vitest run tests/gateway/notification-router.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add web-ui/lib/gateway/notification-router.ts web-ui/tests/gateway/notification-router.test.ts
git commit -m "feat(gateway): add NotificationRouter with HIL fallback"
```

---

### Task 6: Update Agent Ops Types

**Files:**
- Modify: `web-ui/lib/agent-ops/types.ts`

- [ ] **Step 1: Add new channel types to TriggerSource**

In `web-ui/lib/agent-ops/types.ts`, change line 9:

```typescript
// Before:
export type TriggerSource = 'slack' | 'jira' | 'api' | 'scheduled';

// After:
export type TriggerSource = 'slack' | 'jira' | 'discord' | 'telegram' | 'webhook' | 'api' | 'scheduled';
```

- [ ] **Step 2: Add new trigger metadata types**

After the `ScheduledTriggerMeta` interface (line 55), add:

```typescript
export interface DiscordTriggerMeta {
    userId: string;
    channelId: string;
    guildId?: string;
    interactionId: string;
    interactionToken: string;
    messageId?: string;
}

export interface TelegramTriggerMeta {
    userId: number;
    chatId: number;
    messageId?: number;
    callbackQueryId?: string;
}

export interface WebhookTriggerMeta {
    callbackUrl: string;
    webhookId?: string;
    secret?: string;
}
```

- [ ] **Step 3: Update TriggerMetadata union**

```typescript
// Before:
export type TriggerMetadata = SlackTriggerMeta | JiraTriggerMeta | ApiTriggerMeta | ScheduledTriggerMeta;

// After:
export type TriggerMetadata = SlackTriggerMeta | JiraTriggerMeta | DiscordTriggerMeta | TelegramTriggerMeta | WebhookTriggerMeta | ApiTriggerMeta | ScheduledTriggerMeta;
```

- [ ] **Step 4: Verify build**

Run: `cd web-ui && npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: No new type errors

- [ ] **Step 5: Commit**

```bash
git add web-ui/lib/agent-ops/types.ts
git commit -m "feat(types): add Discord, Telegram, Webhook trigger metadata types"
```

## Phase 2: Refactor Existing Channels (Slack + Jira)

### Task 7: Slack Adapter

**Files:**
- Create: `web-ui/lib/gateway/adapters/slack-adapter.ts`
- Test: `web-ui/tests/gateway/adapters/slack-adapter.test.ts`
- Reference: `web-ui/lib/agent-ops/slack-notifier.ts` (logic moves here)
- Reference: `web-ui/lib/agent-ops/slack-validator.ts` (logic moves here)

- [ ] **Step 1: Write failing tests**

```typescript
// web-ui/tests/gateway/adapters/slack-adapter.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackAdapter } from '@/lib/gateway/adapters/slack-adapter';

vi.mock('@/lib/tenant-config-service', () => ({
    TenantConfigService: {
        getConfig: vi.fn().mockResolvedValue({
            signingSecret: 'test-secret',
            botToken: 'xoxb-test-token',
            enabled: true,
        }),
    },
}));

describe('SlackAdapter', () => {
    let adapter: SlackAdapter;

    beforeEach(() => {
        adapter = new SlackAdapter();
    });

    it('has correct channel metadata', () => {
        expect(adapter.channelType).toBe('slack');
        expect(adapter.deliveryMode).toBe('callback');
        expect(adapter.hilCapabilities).toEqual({
            clarification: true,
            approvalButtons: true,
            threadedReplies: true,
        });
    });

    it('rejects requests with invalid signature', async () => {
        const req = new Request('http://localhost/api/v1/gateway/slack', {
            method: 'POST',
            headers: {
                'x-slack-request-timestamp': '0',
                'x-slack-signature': 'v0=invalid',
            },
            body: 'text=hello',
        });
        const result = await adapter.validateRequest(req as any);
        expect(result).toBe(false);
    });

    it('parseInbound extracts slash command fields', async () => {
        const body = 'text=check+lambdas&user_id=U123&channel_id=C456&response_url=https%3A%2F%2Fhooks.slack.com%2Ftest&team_id=T789&user_name=kartik&channel_name=general';
        const req = new Request('http://localhost/api/v1/gateway/slack', {
            method: 'POST',
            body,
        });
        // Bypass validation for parse test
        const msg = await adapter.parseInbound(req as any);
        expect(msg.channelType).toBe('slack');
        expect(msg.taskDescription).toBe('check lambdas');
        expect(msg.tenantId).toBe('T789');
        expect(msg.channelMeta).toMatchObject({
            userId: 'U123',
            channelId: 'C456',
        });
    });

    it('sendAck returns ephemeral response', async () => {
        const req = new Request('http://localhost', { method: 'POST', body: 'text=hi' });
        const res = await adapter.sendAck(req as any, 'run-1');
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.response_type).toBe('ephemeral');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web-ui && npx vitest run tests/gateway/adapters/slack-adapter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement SlackAdapter**

Create `web-ui/lib/gateway/adapters/slack-adapter.ts`. This file consolidates all logic from `slack-notifier.ts` and `slack-validator.ts` into the `ChannelAdapter` interface:

- `validateRequest()` — HMAC-SHA256 verification (from `verifySlackSignature`)
- `parseInbound()` — slash command parsing (from `parseSlackSlashCommand`) + interaction payload parsing + thread-based HIL detection
- `sendAck()` — ephemeral response within 3s window
- `sendResult()` — Block Kit or response_url post (from `postResultToSlack`)
- `sendError()` — error message post (from `postErrorToSlack`)
- `sendClarification()` — clarification post (from `postClarificationToSlack`)
- `sendApprovalRequest()` — Block Kit with buttons (from `postApprovalRequestToSlack`)
- `getConfig()` — reads from TenantConfigService('agent-ops-slack')

Key implementation details:
- Reuse `verifySlackSignature()` and `parseSlackSlashCommand()` as private methods (copy the logic, don't import from old files)
- `parseInbound()` must handle both slash commands (URL-encoded form) and interaction payloads (JSON with `payload` field)
- For interaction payloads (button clicks), parse `action_id` and `value` to build `ReplyContext`
- Thread-based HIL: if `thread_ts` present, check for awaiting_input run via `agentOpsService.findAwaitingRunBySlackThread()`
- `sendResult()` tries `chat.postMessage` to thread first (if botToken + threadTs), falls back to response_url
- Store `crypto` import for HMAC, `TenantConfigService` for config

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web-ui && npx vitest run tests/gateway/adapters/slack-adapter.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add web-ui/lib/gateway/adapters/slack-adapter.ts web-ui/tests/gateway/adapters/slack-adapter.test.ts
git commit -m "feat(gateway): add SlackAdapter (refactored from slack-notifier + slack-validator)"
```

---

### Task 8: Jira Adapter

**Files:**
- Create: `web-ui/lib/gateway/adapters/jira-adapter.ts`
- Test: `web-ui/tests/gateway/adapters/jira-adapter.test.ts`
- Reference: `web-ui/lib/agent-ops/jira-notifier.ts` (logic moves here)
- Reference: `web-ui/lib/agent-ops/jira-validator.ts` (logic moves here)

- [ ] **Step 1: Write failing tests**

```typescript
// web-ui/tests/gateway/adapters/jira-adapter.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JiraAdapter } from '@/lib/gateway/adapters/jira-adapter';

vi.mock('@/lib/tenant-config-service', () => ({
    TenantConfigService: {
        getConfig: vi.fn().mockResolvedValue({
            webhookSecret: 'jira-secret',
            baseUrl: 'https://test.atlassian.net',
            userEmail: 'bot@test.com',
            apiToken: 'token-123',
            botAccountId: 'bot-account-id',
            enabled: true,
        }),
    },
}));

describe('JiraAdapter', () => {
    let adapter: JiraAdapter;

    beforeEach(() => {
        adapter = new JiraAdapter();
    });

    it('has correct channel metadata', () => {
        expect(adapter.channelType).toBe('jira');
        expect(adapter.deliveryMode).toBe('callback');
        expect(adapter.hilCapabilities).toEqual({
            clarification: true,
            approvalButtons: false,
            threadedReplies: true,
        });
    });

    it('validates bearer token auth', async () => {
        const req = new Request('http://localhost/api/v1/gateway/jira', {
            method: 'POST',
            headers: { 'authorization': 'Bearer jira-secret', 'content-type': 'application/json' },
            body: JSON.stringify({ issue: { key: 'TEST-1' } }),
        });
        const result = await adapter.validateRequest(req as any);
        expect(result).toBe(true);
    });

    it('rejects invalid auth', async () => {
        const req = new Request('http://localhost/api/v1/gateway/jira', {
            method: 'POST',
            headers: { 'authorization': 'Bearer wrong-secret', 'content-type': 'application/json' },
            body: JSON.stringify({ issue: { key: 'TEST-1' } }),
        });
        const result = await adapter.validateRequest(req as any);
        expect(result).toBe(false);
    });

    it('parseInbound extracts issue key and task description', async () => {
        const payload = {
            issue: { key: 'OPS-42', fields: { summary: 'Check Lambda configs', project: { key: 'OPS' }, reporter: { displayName: 'Kartik' } } },
            taskDescription: 'Check Lambda configs',
        };
        const req = new Request('http://localhost/api/v1/gateway/jira', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const msg = await adapter.parseInbound(req as any);
        expect(msg.channelType).toBe('jira');
        expect(msg.taskDescription).toBe('Check Lambda configs');
        expect(msg.channelMeta).toMatchObject({ issueKey: 'OPS-42', projectKey: 'OPS' });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web-ui && npx vitest run tests/gateway/adapters/jira-adapter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement JiraAdapter**

Create `web-ui/lib/gateway/adapters/jira-adapter.ts`. Consolidates logic from `jira-notifier.ts` and `jira-validator.ts`:

- `validateRequest()` — Bearer token or query param verification (from `verifyJiraSecret`)
- `parseInbound()` — webhook payload parsing with comment routing:
  1. Skip bot's own comments (from `isBotMention` check on author accountId)
  2. APPROVE/REJECT keywords → `ReplyContext` with action
  3. Clarification reply on awaiting_input run → `ReplyContext` with clarification_response
  4. @bot mention → extract text without mention (from `extractCommentTextWithoutMention`)
  5. Automation rule → use `taskDescription` field or issue summary
- `sendAck()` — 200 OK with runId
- `sendResult()` — post comment to issue (from `postResultToJira`)
- `sendError()` — post error comment (from `postErrorToJira`)
- `sendClarification()` — post clarification comment (from `postClarificationToJira`)
- `sendApprovalRequest()` — post approval comment with text instructions (from `postApprovalRequestToJira`)
- `getConfig()` — reads from TenantConfigService('agent-ops-jira')

Key: copy ADF helpers (`extractMentionAccountIds`, `isBotMention`, `extractCommentTextWithoutMention`, `extractJiraCommentText`) as private methods.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web-ui && npx vitest run tests/gateway/adapters/jira-adapter.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add web-ui/lib/gateway/adapters/jira-adapter.ts web-ui/tests/gateway/adapters/jira-adapter.test.ts
git commit -m "feat(gateway): add JiraAdapter (refactored from jira-notifier + jira-validator)"
```

---

### Task 9: API Adapter

**Files:**
- Create: `web-ui/lib/gateway/adapters/api-adapter.ts`
- Test: `web-ui/tests/gateway/adapters/api-adapter.test.ts`
- Reference: `web-ui/app/api/v1/trigger/api/route.ts` (logic moves here)

- [ ] **Step 1: Write failing tests**

```typescript
// web-ui/tests/gateway/adapters/api-adapter.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiAdapter } from '@/lib/gateway/adapters/api-adapter';

vi.mock('next-auth', () => ({ getServerSession: vi.fn().mockResolvedValue({ user: { tenantId: 'tenant-1', email: 'test@test.com' } }) }));

describe('ApiAdapter', () => {
    let adapter: ApiAdapter;

    beforeEach(() => {
        adapter = new ApiAdapter();
    });

    it('has correct channel metadata', () => {
        expect(adapter.channelType).toBe('api');
        expect(adapter.deliveryMode).toBe('polling');
        expect(adapter.hilCapabilities).toEqual({
            clarification: false,
            approvalButtons: false,
            threadedReplies: false,
        });
    });

    it('validates session auth', async () => {
        const req = new Request('http://localhost/api/v1/gateway/api', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ taskDescription: 'test' }),
        });
        const result = await adapter.validateRequest(req as any);
        expect(result).toBe(true);
    });

    it('parseInbound extracts task description', async () => {
        const req = new Request('http://localhost/api/v1/gateway/api', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-tenant-id': 'tenant-1' },
            body: JSON.stringify({ taskDescription: 'Check Lambda configs', mode: 'plan', autoApprove: true }),
        });
        const msg = await adapter.parseInbound(req as any);
        expect(msg.channelType).toBe('api');
        expect(msg.taskDescription).toBe('Check Lambda configs');
        expect(msg.mode).toBe('plan');
        expect(msg.autoApprove).toBe(true);
    });

    it('sendAck returns runId and threadId placeholder', async () => {
        const req = new Request('http://localhost', { method: 'POST' });
        const res = await adapter.sendAck(req as any, 'run-1');
        const json = await res.json();
        expect(json.runId).toBe('run-1');
        expect(json.status).toBe('queued');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web-ui && npx vitest run tests/gateway/adapters/api-adapter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ApiAdapter**

Create `web-ui/lib/gateway/adapters/api-adapter.ts`:

- `validateRequest()` — check session, bearer token, or x-api-key header
- `parseInbound()` — parse JSON body for `taskDescription`, `mode`, `autoApprove`, `accountId`, etc.
- `sendAck()` — return `{ runId, status: 'queued', message: 'Agent Ops run started' }`
- `sendResult()` — no-op (caller polls or uses SSE)
- `sendError()` — no-op (caller polls)
- `sendClarification()` — no-op (caller detects via polling)
- `sendApprovalRequest()` — no-op (caller detects via polling)
- `getConfig()` — returns empty object (no channel-specific config)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web-ui && npx vitest run tests/gateway/adapters/api-adapter.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add web-ui/lib/gateway/adapters/api-adapter.ts web-ui/tests/gateway/adapters/api-adapter.test.ts
git commit -m "feat(gateway): add ApiAdapter (refactored from trigger/api route)"
```

## Phase 3: New Channel Adapters (Discord, Telegram, Webhook)

### Task 10: Install tweetnacl dependency

**Files:**
- Modify: `web-ui/package.json`

- [ ] **Step 1: Install tweetnacl**

Run: `cd web-ui && npm install tweetnacl@1.0.3`

- [ ] **Step 2: Verify installation**

Run: `cd web-ui && node -e "require('tweetnacl'); console.log('ok')"`
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add web-ui/package.json web-ui/package-lock.json
git commit -m "chore: add tweetnacl for Discord Ed25519 signature verification"
```

---

### Task 11: Discord Adapter

**Files:**
- Create: `web-ui/lib/gateway/adapters/discord-adapter.ts`
- Test: `web-ui/tests/gateway/adapters/discord-adapter.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// web-ui/tests/gateway/adapters/discord-adapter.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiscordAdapter } from '@/lib/gateway/adapters/discord-adapter';

vi.mock('@/lib/tenant-config-service', () => ({
    TenantConfigService: {
        getConfig: vi.fn().mockResolvedValue({
            applicationId: 'app-123',
            publicKey: 'abc123publickey',
            botToken: 'discord-bot-token',
            enabled: true,
        }),
    },
}));

describe('DiscordAdapter', () => {
    let adapter: DiscordAdapter;

    beforeEach(() => {
        adapter = new DiscordAdapter();
    });

    it('has correct channel metadata', () => {
        expect(adapter.channelType).toBe('discord');
        expect(adapter.deliveryMode).toBe('streaming');
        expect(adapter.hilCapabilities).toEqual({
            clarification: true,
            approvalButtons: true,
            threadedReplies: true,
        });
    });

    it('rejects requests with missing signature headers', async () => {
        const req = new Request('http://localhost/api/v1/gateway/discord', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 1 }),
        });
        const result = await adapter.validateRequest(req as any);
        expect(result).toBe(false);
    });

    it('parseInbound extracts slash command interaction', async () => {
        const payload = {
            type: 2, // APPLICATION_COMMAND
            data: { name: 'cloudops', options: [{ name: 'task', value: 'Check Lambda configs' }] },
            member: { user: { id: 'user-123' } },
            channel_id: 'ch-456',
            guild_id: 'guild-789',
            id: 'interaction-1',
            token: 'interaction-token-abc',
        };
        const req = new Request('http://localhost/api/v1/gateway/discord', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const msg = await adapter.parseInbound(req as any);
        expect(msg.channelType).toBe('discord');
        expect(msg.taskDescription).toBe('Check Lambda configs');
        expect(msg.channelMeta).toMatchObject({
            userId: 'user-123',
            channelId: 'ch-456',
            interactionId: 'interaction-1',
            interactionToken: 'interaction-token-abc',
        });
    });

    it('parseInbound detects button interaction as ReplyContext', async () => {
        const payload = {
            type: 3, // MESSAGE_COMPONENT
            data: { custom_id: 'approve:run-1:tenant-1' },
            member: { user: { id: 'user-123' } },
            channel_id: 'ch-456',
            id: 'interaction-2',
            token: 'interaction-token-def',
        };
        const req = new Request('http://localhost/api/v1/gateway/discord', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const msg = await adapter.parseInbound(req as any);
        expect(msg.replyContext).toEqual({
            runId: 'run-1',
            action: 'approve',
            tenantId: 'tenant-1',
        });
    });

    it('sendAck returns deferred response (type 5)', async () => {
        const req = new Request('http://localhost', { method: 'POST' });
        const res = await adapter.sendAck(req as any, 'run-1');
        const json = await res.json();
        expect(json.type).toBe(5);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web-ui && npx vitest run tests/gateway/adapters/discord-adapter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement DiscordAdapter**

Create `web-ui/lib/gateway/adapters/discord-adapter.ts`:

- `validateRequest()` — Ed25519 signature verification using `tweetnacl.sign.detached.verify()`. Headers: `x-signature-ed25519` and `x-signature-timestamp`. Verify against the application's public key from config.
- `parseInbound()` — handle Discord interaction types:
  - Type 1 (PING): return a PONG response (Discord verification handshake)
  - Type 2 (APPLICATION_COMMAND): extract slash command options as taskDescription, build channelMeta with userId, channelId, guildId, interactionId, interactionToken
  - Type 3 (MESSAGE_COMPONENT): parse `custom_id` format `action:runId:tenantId` into ReplyContext
- `sendAck()` — return `{ type: 5 }` (DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE)
- `sendResult()` — PATCH to `https://discord.com/api/v10/webhooks/{appId}/{interactionToken}/messages/@original` with rich embed (title, description, color, fields for tools/duration)
- `sendError()` — same PATCH with red-colored embed
- `sendClarification()` — PATCH with embed + note about replying
- `sendApprovalRequest()` — PATCH with embed + ActionRow containing Approve/Reject buttons. Button `custom_id` format: `approve:{runId}:{tenantId}` / `reject:{runId}:{tenantId}`
- `sendStreamChunk()` — PATCH message with progressive content. Use `ChannelRateLimiter` with 2000ms interval (Discord rate limit: 5 edits/5s).
- `getConfig()` — reads from TenantConfigService('agent-ops-discord')

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web-ui && npx vitest run tests/gateway/adapters/discord-adapter.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add web-ui/lib/gateway/adapters/discord-adapter.ts web-ui/tests/gateway/adapters/discord-adapter.test.ts
git commit -m "feat(gateway): add DiscordAdapter with Ed25519 validation and rich embeds"
```

---

### Task 12: Telegram Adapter

**Files:**
- Create: `web-ui/lib/gateway/adapters/telegram-adapter.ts`
- Test: `web-ui/tests/gateway/adapters/telegram-adapter.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// web-ui/tests/gateway/adapters/telegram-adapter.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramAdapter } from '@/lib/gateway/adapters/telegram-adapter';

vi.mock('@/lib/tenant-config-service', () => ({
    TenantConfigService: {
        getConfig: vi.fn().mockResolvedValue({
            botToken: 'tg-bot-token',
            secretToken: 'tg-secret',
            enabled: true,
        }),
    },
}));

describe('TelegramAdapter', () => {
    let adapter: TelegramAdapter;

    beforeEach(() => {
        adapter = new TelegramAdapter();
    });

    it('has correct channel metadata', () => {
        expect(adapter.channelType).toBe('telegram');
        expect(adapter.deliveryMode).toBe('streaming');
        expect(adapter.hilCapabilities).toEqual({
            clarification: true,
            approvalButtons: true,
            threadedReplies: true,
        });
    });

    it('validates secret token header', async () => {
        const req = new Request('http://localhost/api/v1/gateway/telegram', {
            method: 'POST',
            headers: { 'x-telegram-bot-api-secret-token': 'tg-secret', 'content-type': 'application/json' },
            body: JSON.stringify({ message: { text: '/cloudops test' } }),
        });
        const result = await adapter.validateRequest(req as any);
        expect(result).toBe(true);
    });

    it('rejects invalid secret token', async () => {
        const req = new Request('http://localhost/api/v1/gateway/telegram', {
            method: 'POST',
            headers: { 'x-telegram-bot-api-secret-token': 'wrong', 'content-type': 'application/json' },
            body: JSON.stringify({ message: { text: '/cloudops test' } }),
        });
        const result = await adapter.validateRequest(req as any);
        expect(result).toBe(false);
    });

    it('parseInbound extracts bot command', async () => {
        const payload = {
            message: {
                message_id: 100,
                from: { id: 12345 },
                chat: { id: 67890 },
                text: '/cloudops Check Lambda configs',
                entities: [{ type: 'bot_command', offset: 0, length: 10 }],
            },
        };
        const req = new Request('http://localhost/api/v1/gateway/telegram', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const msg = await adapter.parseInbound(req as any);
        expect(msg.channelType).toBe('telegram');
        expect(msg.taskDescription).toBe('Check Lambda configs');
        expect(msg.channelMeta).toMatchObject({ userId: 12345, chatId: 67890 });
    });

    it('parseInbound detects callback query as ReplyContext', async () => {
        const payload = {
            callback_query: {
                id: 'cbq-1',
                from: { id: 12345 },
                message: { chat: { id: 67890 }, message_id: 101 },
                data: 'approve:run-1:tenant-1',
            },
        };
        const req = new Request('http://localhost/api/v1/gateway/telegram', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const msg = await adapter.parseInbound(req as any);
        expect(msg.replyContext).toEqual({
            runId: 'run-1',
            action: 'approve',
            tenantId: 'tenant-1',
        });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web-ui && npx vitest run tests/gateway/adapters/telegram-adapter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement TelegramAdapter**

Create `web-ui/lib/gateway/adapters/telegram-adapter.ts`:

- `validateRequest()` — verify `X-Telegram-Bot-Api-Secret-Token` header matches config
- `parseInbound()` — handle Telegram update types:
  - `message` with bot command entity: strip `/cloudops` prefix, extract text as taskDescription. Build channelMeta with userId, chatId, messageId.
  - `message` as reply to bot message: detect reply_to_message from bot → build ReplyContext with clarification_response
  - `callback_query`: parse `data` field format `action:runId:tenantId` into ReplyContext
- `sendAck()` — POST to `https://api.telegram.org/bot{token}/sendMessage` with "Processing..." text. Store returned message_id in channelMeta for later editing.
- `sendResult()` — `editMessageText` with MarkdownV2 formatted summary
- `sendError()` — `editMessageText` or `sendMessage` with error
- `sendClarification()` — `sendMessage` with question text
- `sendApprovalRequest()` — `sendMessage` with inline keyboard: `[[{text: "Approve", callback_data: "approve:{runId}:{tenantId}"}, {text: "Reject", callback_data: "reject:{runId}:{tenantId}"}]]`
- `sendStreamChunk()` — `editMessageText` with progressive content. Use `ChannelRateLimiter` with 2000ms interval (~30 edits/min).
- `getConfig()` — reads from TenantConfigService('agent-ops-telegram')

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web-ui && npx vitest run tests/gateway/adapters/telegram-adapter.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add web-ui/lib/gateway/adapters/telegram-adapter.ts web-ui/tests/gateway/adapters/telegram-adapter.test.ts
git commit -m "feat(gateway): add TelegramAdapter with Bot API and inline keyboards"
```

---

### Task 13: Webhook Adapter

**Files:**
- Create: `web-ui/lib/gateway/adapters/webhook-adapter.ts`
- Test: `web-ui/tests/gateway/adapters/webhook-adapter.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// web-ui/tests/gateway/adapters/webhook-adapter.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebhookAdapter } from '@/lib/gateway/adapters/webhook-adapter';

vi.mock('@/lib/tenant-config-service', () => ({
    TenantConfigService: {
        getConfig: vi.fn().mockResolvedValue({
            webhookSecret: 'webhook-secret-123',
            enabled: true,
        }),
    },
}));

describe('WebhookAdapter', () => {
    let adapter: WebhookAdapter;

    beforeEach(() => {
        adapter = new WebhookAdapter();
    });

    it('has correct channel metadata', () => {
        expect(adapter.channelType).toBe('webhook');
        expect(adapter.deliveryMode).toBe('callback');
        expect(adapter.hilCapabilities).toEqual({
            clarification: false,
            approvalButtons: false,
            threadedReplies: false,
        });
    });

    it('parseInbound extracts task and callbackUrl', async () => {
        const payload = {
            taskDescription: 'Check Lambda configs',
            tenantId: 'tenant-1',
            callbackUrl: 'https://example.com/webhook/callback',
        };
        const req = new Request('http://localhost/api/v1/gateway/webhook', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const msg = await adapter.parseInbound(req as any);
        expect(msg.channelType).toBe('webhook');
        expect(msg.taskDescription).toBe('Check Lambda configs');
        expect(msg.channelMeta).toMatchObject({ callbackUrl: 'https://example.com/webhook/callback' });
    });

    it('parseInbound detects replyContext for programmatic resume', async () => {
        const payload = {
            taskDescription: '',
            tenantId: 'tenant-1',
            callbackUrl: 'https://example.com/callback',
            replyContext: { runId: 'run-1', action: 'approve' },
        };
        const req = new Request('http://localhost/api/v1/gateway/webhook', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const msg = await adapter.parseInbound(req as any);
        expect(msg.replyContext).toEqual({ runId: 'run-1', action: 'approve' });
    });

    it('sendAck returns runId', async () => {
        const req = new Request('http://localhost', { method: 'POST' });
        const res = await adapter.sendAck(req as any, 'run-1');
        const json = await res.json();
        expect(json.runId).toBe('run-1');
        expect(json.status).toBe('queued');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web-ui && npx vitest run tests/gateway/adapters/webhook-adapter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement WebhookAdapter**

Create `web-ui/lib/gateway/adapters/webhook-adapter.ts`:

- `validateRequest()` — HMAC-SHA256 verification. Compute HMAC of raw body using tenant-configured `webhookSecret`. Compare against `x-webhook-signature` header. Use `crypto.timingSafeEqual`.
- `parseInbound()` — parse JSON body: `taskDescription`, `tenantId`, `callbackUrl`, optional `replyContext`, optional `mode`, `autoApprove`, `accountId`
- `sendAck()` — return `{ runId, status: 'queued' }`
- `sendResult()` — POST to `callbackUrl` with `{ runId, status: 'completed', summary, toolsUsed, duration }`. Retry with exponential backoff (3 attempts: 1s, 2s, 4s).
- `sendError()` — POST to `callbackUrl` with `{ runId, status: 'failed', error }`
- `sendClarification()` — POST to `callbackUrl` with `{ runId, status: 'awaiting_input', question, dashboardUrl }` (uses `buildDashboardRespondUrl`)
- `sendApprovalRequest()` — POST to `callbackUrl` with `{ runId, status: 'awaiting_approval', planSteps, pendingTools, dashboardUrl }`
- `getConfig()` — reads from TenantConfigService('agent-ops-webhook')

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web-ui && npx vitest run tests/gateway/adapters/webhook-adapter.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add web-ui/lib/gateway/adapters/webhook-adapter.ts web-ui/tests/gateway/adapters/webhook-adapter.test.ts
git commit -m "feat(gateway): add WebhookAdapter with HMAC validation and callback delivery"
```

## Phase 4: SSE Streaming + Dashboard Fallback

### Task 14: Gateway Service

**Files:**
- Create: `web-ui/lib/gateway/gateway-service.ts`
- Test: `web-ui/tests/gateway/gateway-service.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// web-ui/tests/gateway/gateway-service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GatewayService } from '@/lib/gateway/gateway-service';
import { GatewayEventBus } from '@/lib/gateway/event-bus';
import { AdapterRegistry } from '@/lib/gateway/adapter-registry';
import { NotificationRouter } from '@/lib/gateway/notification-router';
import type { ChannelAdapter } from '@/lib/gateway/types';

vi.mock('@/lib/agent-ops/agent-ops-service', () => ({
    agentOpsService: {
        createRun: vi.fn().mockResolvedValue({
            runId: 'run-1', tenantId: 'tenant-1', source: 'slack',
            taskDescription: 'test', threadId: 'thread-1', trigger: {},
        }),
        getRun: vi.fn(),
        updateRunStatus: vi.fn(),
        recordEvent: vi.fn(),
        findAwaitingApprovalRun: vi.fn(),
    },
}));

vi.mock('@/lib/agent-ops/agent-executor', () => ({
    executeAgentRun: vi.fn().mockResolvedValue(undefined),
    resumeApprovedRun: vi.fn().mockResolvedValue(undefined),
}));

function makeMockAdapter(): ChannelAdapter {
    return {
        channelType: 'slack',
        deliveryMode: 'callback',
        hilCapabilities: { clarification: true, approvalButtons: true, threadedReplies: true },
        validateRequest: vi.fn().mockResolvedValue(true),
        parseInbound: vi.fn().mockResolvedValue({
            channelType: 'slack',
            tenantId: 'tenant-1',
            taskDescription: 'test task',
            channelMeta: { userId: 'U123', channelId: 'C456', responseUrl: 'https://hooks.slack.com/test' },
        }),
        sendAck: vi.fn().mockResolvedValue(new Response(JSON.stringify({ response_type: 'ephemeral', text: 'ok' }), { status: 200 })),
        sendResult: vi.fn().mockResolvedValue(undefined),
        sendError: vi.fn().mockResolvedValue(undefined),
        sendClarification: vi.fn().mockResolvedValue(undefined),
        sendApprovalRequest: vi.fn().mockResolvedValue(undefined),
        getConfig: vi.fn().mockResolvedValue({}),
    } as any;
}

describe('GatewayService', () => {
    let service: GatewayService;
    let adapter: ChannelAdapter;
    let bus: GatewayEventBus;

    beforeEach(() => {
        bus = new GatewayEventBus();
        const registry = new AdapterRegistry();
        adapter = makeMockAdapter();
        registry.register(adapter);
        const router = new NotificationRouter(bus, registry);
        service = new GatewayService(registry, bus, router);
    });

    it('validates, parses, creates run, acks, and fires execution', async () => {
        const req = new Request('http://localhost/api/v1/gateway/slack', { method: 'POST', body: 'text=test' });
        const res = await service.handleInbound('slack', req as any);
        expect(adapter.validateRequest).toHaveBeenCalled();
        expect(adapter.parseInbound).toHaveBeenCalled();
        expect(adapter.sendAck).toHaveBeenCalled();
        expect(res.status).toBe(200);
    });

    it('returns 401 when validation fails', async () => {
        (adapter.validateRequest as any).mockResolvedValue(false);
        const req = new Request('http://localhost', { method: 'POST', body: 'text=test' });
        const res = await service.handleInbound('slack', req as any);
        expect(res.status).toBe(401);
    });

    it('routes HIL resume when replyContext is present', async () => {
        (adapter.parseInbound as any).mockResolvedValue({
            channelType: 'slack',
            tenantId: 'tenant-1',
            taskDescription: '',
            channelMeta: {},
            replyContext: { runId: 'run-1', action: 'approve', tenantId: 'tenant-1' },
        });
        const { resumeApprovedRun } = await import('@/lib/agent-ops/agent-executor');
        const req = new Request('http://localhost', { method: 'POST', body: 'payload={}' });
        await service.handleInbound('slack', req as any);
        // Give fire-and-forget a tick
        await new Promise(r => setTimeout(r, 50));
        expect(resumeApprovedRun).toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web-ui && npx vitest run tests/gateway/gateway-service.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement gateway-service.ts**

```typescript
// web-ui/lib/gateway/gateway-service.ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type { ChannelType, ChannelAdapter, GatewayMessage } from './types';
import type { AdapterRegistry } from './adapter-registry';
import type { GatewayEventBus } from './event-bus';
import type { NotificationRouter } from './notification-router';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { executeAgentRun, resumeApprovedRun } from '@/lib/agent-ops/agent-executor';
import { cancelRun } from '@/lib/agent-ops/run-manager';
import { AuditService } from '@/lib/audit-service';

export class GatewayService {
    constructor(
        private registry: AdapterRegistry,
        private eventBus: GatewayEventBus,
        private router: NotificationRouter,
    ) {}

    async handleInbound(channelType: ChannelType, req: NextRequest): Promise<Response> {
        try {
            const adapter = this.registry.get(channelType);

            const valid = await adapter.validateRequest(req);
            if (!valid) {
                return NextResponse.json({ error: 'Invalid request' }, { status: 401 });
            }

            const message = await adapter.parseInbound(req);

            if (message.replyContext) {
                return this.handleResume(adapter, message, req);
            }

            if (!message.taskDescription?.trim()) {
                return NextResponse.json({ error: 'Missing task description' }, { status: 400 });
            }

            const run = await agentOpsService.createRun({
                tenantId: message.tenantId,
                source: channelType as any,
                taskDescription: message.taskDescription.trim(),
                mode: message.mode || 'fast',
                trigger: message.channelMeta as any,
                accountId: message.accountId,
                accountName: message.accountName,
                selectedSkill: message.selectedSkill,
                mcpServerIds: message.mcpServerIds,
                autoApprove: message.autoApprove ?? false,
                model: message.model,
            });

            const detach = this.router.attachToRun(run);

            const ackResponse = await adapter.sendAck(req, run.runId);

            AuditService.logResourceAction({
                eventType: `trigger.${channelType}.received`,
                severity: 'low',
                apiRoute: `POST /api/v1/gateway/${channelType}`,
                httpMethod: 'POST',
                source: 'external',
                action: `Received ${channelType} trigger`,
                resourceType: 'trigger',
                resourceId: run.runId,
                resourceName: `${channelType} trigger`,
                status: 'success',
                details: `Received ${channelType} trigger for run ${run.runId}`,
                userType: 'system',
                metadata: { tenantId: message.tenantId },
            }).catch(() => {});

            executeAgentRun(run, this.eventBus)
                .finally(() => {
                    detach();
                    this.eventBus.cleanup(run.runId);
                });

            return ackResponse;
        } catch (error) {
            console.error(`[GatewayService] Error handling ${channelType} inbound:`, error);
            return NextResponse.json(
                { error: error instanceof Error ? error.message : 'Internal server error' },
                { status: 500 },
            );
        }
    }

    private async handleResume(
        adapter: ChannelAdapter,
        message: GatewayMessage,
        req: NextRequest,
    ): Promise<Response> {
        const { runId, action, content, tenantId } = message.replyContext!;

        if (action === 'approve') {
            const run = await agentOpsService.findAwaitingApprovalRun(runId);
            if (!run) {
                return NextResponse.json({ error: 'Run not found or not awaiting approval' }, { status: 404 });
            }
            const detach = this.router.attachToRun(run);
            resumeApprovedRun(run, this.eventBus)
                .finally(() => {
                    detach();
                    this.eventBus.cleanup(run.runId);
                });
            return NextResponse.json({ success: true, message: `Approved run ${runId}` });
        }

        if (action === 'reject') {
            const run = await agentOpsService.findAwaitingApprovalRun(runId);
            if (run) {
                await agentOpsService.updateRunStatus(run.tenantId, runId, 'cancelled');
                await agentOpsService.recordEvent({
                    runId, tenantId: run.tenantId, eventType: 'final', node: 'approval_gate',
                    content: `Run rejected by user via ${message.channelType}.`,
                });
            }
            return NextResponse.json({ success: true, message: `Rejected run ${runId}` });
        }

        if (action === 'clarification_response') {
            const lookupTenantId = tenantId || message.tenantId;
            const run = await agentOpsService.getRun(lookupTenantId, runId);
            if (!run || run.status !== 'awaiting_input') {
                return NextResponse.json({ error: 'Run not found or not awaiting input' }, { status: 404 });
            }

            const clarificationContext = run.clarification
                ? `\n\n---\nOriginal clarification question: ${run.clarification.question}\nUser reply: ${content}`
                : `\n\n---\nUser clarification: ${content}`;

            const enrichedRun = { ...run, taskDescription: run.taskDescription + clarificationContext };
            await agentOpsService.updateRunStatus(lookupTenantId, runId, 'in_progress');

            const detach = this.router.attachToRun(enrichedRun);
            executeAgentRun(enrichedRun, this.eventBus)
                .finally(() => {
                    detach();
                    this.eventBus.cleanup(runId);
                });

            return NextResponse.json({ success: true, message: `Resumed run ${runId}` });
        }

        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web-ui && npx vitest run tests/gateway/gateway-service.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add web-ui/lib/gateway/gateway-service.ts web-ui/tests/gateway/gateway-service.test.ts
git commit -m "feat(gateway): add GatewayService orchestrator"
```

---

### Task 15: Gateway Bootstrap (index.ts)

**Files:**
- Create: `web-ui/lib/gateway/index.ts`

- [ ] **Step 1: Create index.ts**

```typescript
// web-ui/lib/gateway/index.ts
import { AdapterRegistry } from './adapter-registry';
import { GatewayEventBus, getGatewayEventBus } from './event-bus';
import { NotificationRouter } from './notification-router';
import { GatewayService } from './gateway-service';
import { SlackAdapter } from './adapters/slack-adapter';
import { JiraAdapter } from './adapters/jira-adapter';
import { DiscordAdapter } from './adapters/discord-adapter';
import { TelegramAdapter } from './adapters/telegram-adapter';
import { WebhookAdapter } from './adapters/webhook-adapter';
import { ApiAdapter } from './adapters/api-adapter';

const g = globalThis as typeof globalThis & { _gatewayService?: GatewayService };

function createGatewayService(): GatewayService {
    const registry = new AdapterRegistry();
    registry.register(new SlackAdapter());
    registry.register(new JiraAdapter());
    registry.register(new DiscordAdapter());
    registry.register(new TelegramAdapter());
    registry.register(new WebhookAdapter());
    registry.register(new ApiAdapter());

    const eventBus = getGatewayEventBus();
    const router = new NotificationRouter(eventBus, registry);

    return new GatewayService(registry, eventBus, router);
}

export function getGatewayService(): GatewayService {
    if (!g._gatewayService) {
        g._gatewayService = createGatewayService();
    }
    return g._gatewayService;
}

export { GatewayService } from './gateway-service';
export { GatewayEventBus, getGatewayEventBus } from './event-bus';
export { AdapterRegistry } from './adapter-registry';
export { NotificationRouter } from './notification-router';
export type { ChannelType, ChannelAdapter, GatewayMessage, GatewayEvent, ReplyContext } from './types';
```

- [ ] **Step 2: Verify import resolution**

Run: `cd web-ui && npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: No new type errors from gateway module

- [ ] **Step 3: Commit**

```bash
git add web-ui/lib/gateway/index.ts
git commit -m "feat(gateway): add bootstrap index with adapter registration"
```

---

### Task 16: SSE Streaming Endpoint

**Files:**
- Create: `web-ui/app/api/v1/gateway/stream/[runId]/route.ts`

- [ ] **Step 1: Create SSE route**

```typescript
// web-ui/app/api/v1/gateway/stream/[runId]/route.ts
import { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getGatewayEventBus } from '@/lib/gateway/event-bus';

export const dynamic = 'force-dynamic';

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ runId: string }> },
) {
    const { runId } = await params;

    const session = await getServerSession(authOptions);
    const authHeader = req.headers.get('authorization');
    const apiKey = req.headers.get('x-api-key');

    if (!session && !authHeader && !apiKey) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    const eventBus = getGatewayEventBus();
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
        start(controller) {
            const unsubscribe = eventBus.subscribe(runId, (event) => {
                try {
                    const data = JSON.stringify({
                        type: event.type,
                        runId: event.runId,
                        timestamp: event.timestamp.toISOString(),
                        data: event.data,
                    });
                    controller.enqueue(encoder.encode(`data: ${data}\n\n`));

                    if (
                        event.type === 'run:completed' ||
                        event.type === 'run:failed' ||
                        event.type === 'run:cancelled'
                    ) {
                        controller.close();
                        unsubscribe();
                    }
                } catch {
                    // Client disconnected
                    unsubscribe();
                }
            });

            req.signal.addEventListener('abort', () => {
                unsubscribe();
                try { controller.close(); } catch { /* already closed */ }
            });
        },
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        },
    });
}
```

- [ ] **Step 2: Verify build**

Run: `cd web-ui && npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add "web-ui/app/api/v1/gateway/stream/[runId]/route.ts"
git commit -m "feat(gateway): add SSE streaming endpoint for run events"
```

---

### Task 17: Dashboard Fallback HIL Page

**Files:**
- Create: `web-ui/app/app/agent-ops/[runId]/respond/page.tsx`

- [ ] **Step 1: Create the respond page**

```tsx
// web-ui/app/app/agent-ops/[runId]/respond/page.tsx
'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface RunData {
    runId: string;
    status: string;
    taskDescription: string;
    source: string;
    clarification?: { question: string; missingInfo: string };
    approvalRequest?: { planSteps: string[]; pendingTools?: string[]; approvalType: string };
}

export default function RespondPage() {
    const params = useParams();
    const router = useRouter();
    const runId = params.runId as string;
    const [run, setRun] = useState<RunData | null>(null);
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [clarificationText, setClarificationText] = useState('');
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        fetch(`/api/agent-ops/${runId}`)
            .then(res => res.json())
            .then(data => {
                if (data.success && data.data) setRun(data.data);
                else setError('Run not found');
            })
            .catch(() => setError('Failed to load run'))
            .finally(() => setLoading(false));
    }, [runId]);

    const handleApprove = async () => {
        setSubmitting(true);
        try {
            await fetch(`/api/agent-ops/${runId}/approve`, { method: 'POST' });
            router.push(`/app/agent-ops`);
        } catch {
            setError('Failed to approve');
        } finally {
            setSubmitting(false);
        }
    };

    const handleReject = async () => {
        setSubmitting(true);
        try {
            await fetch(`/api/agent-ops/${runId}/cancel`, { method: 'POST' });
            router.push(`/app/agent-ops`);
        } catch {
            setError('Failed to reject');
        } finally {
            setSubmitting(false);
        }
    };

    const handleClarification = async () => {
        if (!clarificationText.trim()) return;
        setSubmitting(true);
        try {
            await fetch(`/api/agent-ops/${runId}/resume`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userInput: clarificationText }),
            });
            router.push(`/app/agent-ops`);
        } catch {
            setError('Failed to submit');
        } finally {
            setSubmitting(false);
        }
    };

    if (loading) return <div className="flex items-center justify-center min-h-[400px]">Loading...</div>;
    if (error) return <div className="flex items-center justify-center min-h-[400px] text-destructive">{error}</div>;
    if (!run) return null;

    const isAwaitingInput = run.status === 'awaiting_input';
    const isAwaitingApproval = run.status === 'awaiting_approval';

    if (!isAwaitingInput && !isAwaitingApproval) {
        return (
            <div className="max-w-2xl mx-auto p-6">
                <Card>
                    <CardHeader>
                        <CardTitle>Run {runId.slice(0, 8)}...</CardTitle>
                        <CardDescription>This run is no longer awaiting input.</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <Badge>{run.status}</Badge>
                        <p className="mt-4 text-sm text-muted-foreground">{run.taskDescription}</p>
                    </CardContent>
                </Card>
            </div>
        );
    }

    return (
        <div className="max-w-2xl mx-auto p-6 space-y-4">
            <Card>
                <CardHeader>
                    <CardTitle>Agent Ops — Response Required</CardTitle>
                    <CardDescription>
                        Run <code className="text-xs">{runId.slice(0, 8)}...</code> from <Badge variant="outline">{run.source}</Badge>
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <p className="text-sm">{run.taskDescription}</p>

                    {isAwaitingInput && run.clarification && (
                        <div className="space-y-3">
                            <div className="rounded-md bg-muted p-3">
                                <p className="text-sm font-medium">Clarification needed:</p>
                                <p className="text-sm mt-1">{run.clarification.question}</p>
                            </div>
                            <Textarea
                                placeholder="Type your response..."
                                value={clarificationText}
                                onChange={e => setClarificationText(e.target.value)}
                                rows={4}
                            />
                            <Button onClick={handleClarification} disabled={submitting || !clarificationText.trim()}>
                                {submitting ? 'Submitting...' : 'Submit Response'}
                            </Button>
                        </div>
                    )}

                    {isAwaitingApproval && run.approvalRequest && (
                        <div className="space-y-3">
                            <div className="rounded-md bg-muted p-3">
                                <p className="text-sm font-medium">Execution Plan:</p>
                                <ol className="list-decimal list-inside text-sm mt-1 space-y-1">
                                    {run.approvalRequest.planSteps.map((step, i) => (
                                        <li key={i}>{step}</li>
                                    ))}
                                </ol>
                                {run.approvalRequest.pendingTools && run.approvalRequest.pendingTools.length > 0 && (
                                    <p className="text-sm mt-2">
                                        Tools: {run.approvalRequest.pendingTools.map(t => <code key={t} className="mx-1 text-xs">{t}</code>)}
                                    </p>
                                )}
                            </div>
                            <div className="flex gap-2">
                                <Button onClick={handleApprove} disabled={submitting}>
                                    {submitting ? 'Processing...' : 'Approve'}
                                </Button>
                                <Button variant="destructive" onClick={handleReject} disabled={submitting}>
                                    {submitting ? 'Processing...' : 'Reject'}
                                </Button>
                            </div>
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
```

- [ ] **Step 2: Verify build**

Run: `cd web-ui && npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add "web-ui/app/app/agent-ops/[runId]/respond/page.tsx"
git commit -m "feat(gateway): add dashboard fallback HIL respond page"
```

## Phase 5: Executor Integration + Migration

### Task 18: Modify agent-executor.ts to emit events to the bus

**Files:**
- Modify: `web-ui/lib/agent-ops/agent-executor.ts`

This is the critical integration point. The executor stops calling notifiers directly and emits events to the `GatewayEventBus` instead.

- [ ] **Step 1: Update executeAgentRun signature**

In `web-ui/lib/agent-ops/agent-executor.ts`, change the function signature and add the import:

```typescript
// Add import at top (line 2 area):
import type { GatewayEventBus } from '@/lib/gateway/event-bus';

// Remove these imports (lines 18-19):
// import { postClarificationToSlack, postApprovalRequestToSlack } from './slack-notifier';
// import { postClarificationToJira } from './jira-notifier';

// Change signature (line 55):
// Before:
export async function executeAgentRun(run: AgentOpsRun): Promise<void> {
// After:
export async function executeAgentRun(run: AgentOpsRun, eventBus?: GatewayEventBus): Promise<void> {
```

Note: `eventBus` is optional for backward compatibility during migration. When undefined, the executor skips event emission (existing behavior minus direct notifier calls).

- [ ] **Step 2: Replace clarification notifier calls with eventBus.emit**

In `executeAgentRun`, replace the clarification notification block (lines 182-197) with:

```typescript
            // After updating run status and recording event (lines 174-180 stay the same)...

            if (eventBus) {
                eventBus.emit({
                    type: 'hil:clarification',
                    runId, tenantId,
                    timestamp: new Date(),
                    data: { question },
                });
            }
            return;
```

This replaces the entire `try { const freshRun = ... if (freshRun?.source === 'slack') { ... } else if (freshRun?.source === 'jira') { ... } }` block.

- [ ] **Step 3: Replace plan approval notifier calls with eventBus.emit**

Replace the plan approval notification block (lines 217-234) with:

```typescript
            if (eventBus) {
                eventBus.emit({
                    type: 'hil:plan_approval',
                    runId, tenantId,
                    timestamp: new Date(),
                    data: { planSteps },
                });
            }
            return;
```

- [ ] **Step 4: Replace mutative tool approval notifier calls with eventBus.emit**

Replace the mutative tool approval notification block (lines 252-273) with:

```typescript
            if (eventBus) {
                eventBus.emit({
                    type: 'hil:tool_approval',
                    runId, tenantId,
                    timestamp: new Date(),
                    data: { pendingTools },
                });
            }
            return;
```

- [ ] **Step 5: Add run:completed emission**

After the `agentOpsService.recordEvent` call for `__end__` (around line 307), add:

```typescript
        if (eventBus) {
            const freshRun = await agentOpsService.getRun(tenantId, runId);
            eventBus.emit({
                type: 'run:completed',
                runId, tenantId,
                timestamp: new Date(),
                data: { run: freshRun ?? run },
            });
        }
```

- [ ] **Step 6: Add run:failed and run:cancelled emissions**

In the catch block, after `agentOpsService.updateRunStatus(tenantId, runId, 'cancelled')` (around line 321), add:

```typescript
            if (eventBus) {
                eventBus.emit({
                    type: 'run:cancelled', runId, tenantId,
                    timestamp: new Date(), data: {},
                });
            }
```

After `agentOpsService.updateRunStatus(tenantId, runId, 'failed', ...)` (around line 329), add:

```typescript
            if (eventBus) {
                eventBus.emit({
                    type: 'run:failed', runId, tenantId,
                    timestamp: new Date(), data: { error: errorMsg },
                });
            }
```

- [ ] **Step 7: Add run:event emissions for streaming**

Inside the `processLangGraphEvent` function, after each `agentOpsService.recordEvent` call, add an event bus emission. Pass the event bus as a parameter:

```typescript
// Change processLangGraphEvent signature:
async function processLangGraphEvent(
    runId: string,
    tenantId: string,
    event: any,
    toolsUsed: Set<string>,
    eventBus?: GatewayEventBus,
): Promise<EventProcessingResult> {
```

After each `agentOpsService.recordEvent(...)` call inside processLangGraphEvent, add:

```typescript
                // After recording the event, emit to bus for streaming
                // (only for significant events, not noise)
                if (eventBus) {
                    eventBus.emit({
                        type: 'run:event', runId, tenantId,
                        timestamp: new Date(),
                        data: { event: { runId, eventType: '...', node, content: '...' } as any },
                    });
                }
```

Update the call site in the event loop to pass eventBus:

```typescript
const processed = await processLangGraphEvent(runId, tenantId, event, toolsUsed, eventBus);
```

- [ ] **Step 8: Apply same changes to resumeApprovedRun**

Update `resumeApprovedRun` signature:

```typescript
// Before:
export async function resumeApprovedRun(run: AgentOpsRun): Promise<void> {
// After:
export async function resumeApprovedRun(run: AgentOpsRun, eventBus?: GatewayEventBus): Promise<void> {
```

Apply the same eventBus.emit patterns for:
- Tool approval gate (lines 611-620): emit `hil:tool_approval`
- Completion (lines 648-656): emit `run:completed`
- Error/cancel in catch block: emit `run:failed` or `run:cancelled`
- Pass eventBus to processLangGraphEvent calls

- [ ] **Step 9: Verify build**

Run: `cd web-ui && npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: No type errors

- [ ] **Step 10: Run existing tests**

Run: `cd web-ui && npx vitest run`
Expected: All existing tests pass (executor tests may need mock updates for the new optional param)

- [ ] **Step 11: Commit**

```bash
git add web-ui/lib/agent-ops/agent-executor.ts
git commit -m "refactor(executor): emit events to GatewayEventBus instead of calling notifiers directly"
```

---

### Task 19: Create Gateway API Routes

**Files:**
- Create: `web-ui/app/api/v1/gateway/slack/route.ts`
- Create: `web-ui/app/api/v1/gateway/slack/interactions/route.ts`
- Create: `web-ui/app/api/v1/gateway/jira/route.ts`
- Create: `web-ui/app/api/v1/gateway/discord/route.ts`
- Create: `web-ui/app/api/v1/gateway/telegram/route.ts`
- Create: `web-ui/app/api/v1/gateway/webhook/route.ts`
- Create: `web-ui/app/api/v1/gateway/api/route.ts`

- [ ] **Step 1: Create all gateway routes**

Each route is a thin one-liner that delegates to the gateway service:

```typescript
// web-ui/app/api/v1/gateway/slack/route.ts
import { type NextRequest } from 'next/server';
import { getGatewayService } from '@/lib/gateway';

export const maxDuration = 10;

export async function POST(req: NextRequest) {
    return getGatewayService().handleInbound('slack', req);
}
```

```typescript
// web-ui/app/api/v1/gateway/slack/interactions/route.ts
import { type NextRequest } from 'next/server';
import { getGatewayService } from '@/lib/gateway';

export const maxDuration = 10;

export async function POST(req: NextRequest) {
    // Slack interactions are parsed by the SlackAdapter as a special inbound type
    return getGatewayService().handleInbound('slack', req);
}
```

```typescript
// web-ui/app/api/v1/gateway/jira/route.ts
import { type NextRequest } from 'next/server';
import { getGatewayService } from '@/lib/gateway';

export async function POST(req: NextRequest) {
    return getGatewayService().handleInbound('jira', req);
}
```

```typescript
// web-ui/app/api/v1/gateway/discord/route.ts
import { type NextRequest } from 'next/server';
import { getGatewayService } from '@/lib/gateway';

export async function POST(req: NextRequest) {
    return getGatewayService().handleInbound('discord', req);
}
```

```typescript
// web-ui/app/api/v1/gateway/telegram/route.ts
import { type NextRequest } from 'next/server';
import { getGatewayService } from '@/lib/gateway';

export async function POST(req: NextRequest) {
    return getGatewayService().handleInbound('telegram', req);
}
```

```typescript
// web-ui/app/api/v1/gateway/webhook/route.ts
import { type NextRequest } from 'next/server';
import { getGatewayService } from '@/lib/gateway';

export async function POST(req: NextRequest) {
    return getGatewayService().handleInbound('webhook', req);
}
```

```typescript
// web-ui/app/api/v1/gateway/api/route.ts
import { type NextRequest } from 'next/server';
import { getGatewayService } from '@/lib/gateway';

export async function POST(req: NextRequest) {
    return getGatewayService().handleInbound('api', req);
}
```

- [ ] **Step 2: Verify build**

Run: `cd web-ui && npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add web-ui/app/api/v1/gateway/
git commit -m "feat(gateway): add thin API routes for all channels"
```

---

### Task 20: Update scheduled-notifier.ts to use notification router

**Files:**
- Modify: `web-ui/lib/agent-ops/scheduled-notifier.ts`

- [ ] **Step 1: Refactor to use gateway event bus**

Replace the entire file content with:

```typescript
// web-ui/lib/agent-ops/scheduled-notifier.ts
import type { ScheduledTask, AgentOpsRun } from './types';
import { getGatewayEventBus } from '@/lib/gateway/event-bus';

export async function notifyScheduledRunResult(task: ScheduledTask, run: AgentOpsRun): Promise<void> {
    const { notification } = task;
    if (notification.type === 'none' || !notification.type) return;

    const eventBus = getGatewayEventBus();

    try {
        if (run.status === 'completed') {
            eventBus.emit({
                type: 'run:completed',
                runId: run.runId,
                tenantId: run.tenantId,
                timestamp: new Date(),
                data: { run },
            });
        } else {
            eventBus.emit({
                type: 'run:failed',
                runId: run.runId,
                tenantId: run.tenantId,
                timestamp: new Date(),
                data: { error: run.error ?? 'Scheduled task failed' },
            });
        }
    } catch (err) {
        console.error('[ScheduledNotifier] Notification failed (non-fatal):', err);
    }
}
```

Note: The notification router (attached to the run by the gateway service) will pick up these events and dispatch to the correct channel. For scheduled tasks that specify a Slack channel or Jira issue in their notification config, the run's `source` field determines which adapter handles it. Scheduled tasks triggered via the API adapter will have `source: 'api'`, so the API adapter's no-op `sendResult` applies — the dashboard shows the result.

- [ ] **Step 2: Verify build**

Run: `cd web-ui && npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add web-ui/lib/agent-ops/scheduled-notifier.ts
git commit -m "refactor(scheduled-notifier): use gateway event bus instead of direct Slack/Jira calls"
```

## Phase 6: Backward Compatibility + Cleanup

### Task 21: Add redirect routes for backward compatibility

**Files:**
- Modify: `web-ui/app/api/v1/trigger/slack/route.ts`
- Modify: `web-ui/app/api/v1/trigger/slack/interactions/route.ts`
- Modify: `web-ui/app/api/v1/trigger/jira/route.ts`
- Modify: `web-ui/app/api/v1/trigger/api/route.ts`

- [ ] **Step 1: Replace trigger/slack/route.ts with redirect**

```typescript
// web-ui/app/api/v1/trigger/slack/route.ts
import { type NextRequest } from 'next/server';
import { getGatewayService } from '@/lib/gateway';

export const maxDuration = 10;

// Backward-compat redirect — Slack slash command URLs may still point here.
// Remove once all Slack app configs are updated to /api/v1/gateway/slack.
export async function POST(req: NextRequest) {
    return getGatewayService().handleInbound('slack', req);
}
```

- [ ] **Step 2: Replace trigger/slack/interactions/route.ts with redirect**

```typescript
// web-ui/app/api/v1/trigger/slack/interactions/route.ts
import { type NextRequest } from 'next/server';
import { getGatewayService } from '@/lib/gateway';

export const maxDuration = 10;

// Backward-compat redirect — Slack interactivity URL may still point here.
// Remove once Slack app config is updated to /api/v1/gateway/slack/interactions.
export async function POST(req: NextRequest) {
    return getGatewayService().handleInbound('slack', req);
}
```

- [ ] **Step 3: Replace trigger/jira/route.ts with redirect**

```typescript
// web-ui/app/api/v1/trigger/jira/route.ts
import { type NextRequest } from 'next/server';
import { getGatewayService } from '@/lib/gateway';

// Backward-compat redirect — Jira webhook URLs may still point here.
// Remove once all Jira automation rules are updated to /api/v1/gateway/jira.
export async function POST(req: NextRequest) {
    return getGatewayService().handleInbound('jira', req);
}
```

- [ ] **Step 4: Replace trigger/api/route.ts with redirect**

```typescript
// web-ui/app/api/v1/trigger/api/route.ts
import { type NextRequest } from 'next/server';
import { getGatewayService } from '@/lib/gateway';

// Backward-compat redirect — API clients may still use this path.
// Remove once all clients are updated to /api/v1/gateway/api.
export async function POST(req: NextRequest) {
    return getGatewayService().handleInbound('api', req);
}
```

- [ ] **Step 5: Verify build**

Run: `cd web-ui && npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: No type errors

- [ ] **Step 6: Commit**

```bash
git add web-ui/app/api/v1/trigger/
git commit -m "refactor(triggers): replace old trigger routes with gateway redirects"
```

---

### Task 22: Delete old notifier and validator files

**Files:**
- Delete: `web-ui/lib/agent-ops/slack-notifier.ts`
- Delete: `web-ui/lib/agent-ops/slack-validator.ts`
- Delete: `web-ui/lib/agent-ops/jira-notifier.ts`
- Delete: `web-ui/lib/agent-ops/jira-validator.ts`

- [ ] **Step 1: Verify no remaining imports of old files**

Run: `cd web-ui && grep -r "from.*agent-ops/slack-notifier\|from.*agent-ops/slack-validator\|from.*agent-ops/jira-notifier\|from.*agent-ops/jira-validator" --include="*.ts" --include="*.tsx" lib/ app/ | grep -v node_modules`

Expected: Only the old trigger routes (which are now redirects and don't import these) and possibly test files. If any production code still imports these, fix the imports first.

- [ ] **Step 2: Delete the files**

```bash
rm web-ui/lib/agent-ops/slack-notifier.ts
rm web-ui/lib/agent-ops/slack-validator.ts
rm web-ui/lib/agent-ops/jira-notifier.ts
rm web-ui/lib/agent-ops/jira-validator.ts
```

- [ ] **Step 3: Verify build still passes**

Run: `cd web-ui && npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: No type errors (all imports now point to gateway adapters)

- [ ] **Step 4: Run full test suite**

Run: `cd web-ui && npx vitest run`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add -A web-ui/lib/agent-ops/
git commit -m "chore: delete old slack/jira notifier and validator files (replaced by gateway adapters)"
```

---

### Task 23: Full integration verification

- [ ] **Step 1: Run full test suite**

Run: `cd web-ui && npx vitest run`
Expected: All tests pass (gateway + existing)

- [ ] **Step 2: Run linter**

Run: `cd web-ui && npm run lint`
Expected: No new lint errors

- [ ] **Step 3: Build check**

Run: `cd web-ui && npm run build 2>&1 | tail -20`
Expected: Build succeeds

- [ ] **Step 4: Verify gateway module exports**

Run: `cd web-ui && node -e "const g = require('./lib/gateway'); console.log(typeof g.getGatewayService)"`
Expected: `function`

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat(gateway): Channel Gateway implementation complete

- Gateway-as-Middleware architecture with in-process EventEmitter event bus
- 6 channel adapters: Slack, Jira, Discord, Telegram, Webhook, API
- NotificationRouter dispatches events to originating channel adapter
- SSE streaming endpoint at /api/v1/gateway/stream/[runId]
- Dashboard fallback HIL page at /app/agent-ops/[runId]/respond
- Executor emits events to bus instead of calling notifiers directly
- Backward-compat redirects from old /api/v1/trigger/* routes
- Old slack-notifier, slack-validator, jira-notifier, jira-validator deleted"
```
