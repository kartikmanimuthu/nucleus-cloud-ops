# Scheduled-Cron Channel Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Agent Ops scheduled tasks deliver their outcome to Slack/Telegram end-to-end: cron fires → agent runs autonomously → one digest message is pushed to the configured channel with per-tenant credentials.

**Architecture:** Direct dispatch — `notifyScheduledRunResult(task, run)` resolves the adapter from `task.notification.type` and calls a new optional `sendScheduledNotification(task, run, outcome)` method on the `ChannelAdapter` contract. No event bus. A shared `finalizeScheduledRun(run)` helper (updateLastRun + notify) is called after execution from the trigger, approve, and resume routes. The scheduler worker gains a 60s re-sync loop so tasks created after worker startup fire without a restart.

**Tech Stack:** Next.js 15 API routes, TypeScript strict, Prisma, pg-boss, Vitest (web-ui + workers), Slack Web API (`chat.postMessage`), Telegram Bot API (`sendMessage`).

**Spec:** `docs/superpowers/specs/2026-07-05-scheduled-cron-delivery-design.md`

## Global Constraints

- Branch: `agent-ops`. Conventional commits (`feat:`, `fix:`, `test:`, `docs:`).
- Delivery is best-effort and never affects the run: every notifier/adapter failure logs and returns — **no throws escape** `notifyScheduledRunResult` or `finalizeScheduledRun`.
- No schema migration: `ScheduledTask.notification` is a JSON column.
- No new dependencies.
- Imports in web-ui use the `@/` alias; workers use relative ESM imports **with `.js` suffix**.
- Indentation: 4 spaces in `lib/` service files, 4 spaces in adapters (existing style), 4 spaces in workers, **2 spaces in `components/`** UI files.
- Pre-existing failures are the baseline, not your bug: web-ui has a known TypeScript error baseline (~190 errors, `bunx tsc --noEmit`) and ~41 pre-existing vitest failures from mock-harness issues. Rule: **your changes must not increase either count.** Capture baselines in Task 1; compare in Task 9. Run only your own test files during tasks.
- Web-ui tests: `cd apps/web-ui && bunx vitest run <file>` (never watch mode). Workers tests: `cd apps/workers && bunx vitest run <file>`.

---

### Task 1: Baselines + type extensions + registry/URL accessors

**Files:**
- Modify: `apps/web-ui/lib/agent-ops/types.ts:153-159` (`ScheduledTaskNotification`)
- Modify: `apps/web-ui/lib/gateway/types.ts` (add `ScheduledOutcome`, extend `ChannelAdapter`)
- Modify: `apps/web-ui/lib/gateway/index.ts` (add `getAdapterRegistry()`)
- Modify: `apps/web-ui/lib/gateway/utils/dashboard-url.ts` (add `buildDashboardRunUrl`)

**Interfaces:**
- Consumes: existing `AgentOpsRun`, `ScheduledTask`, `AdapterRegistry`.
- Produces (later tasks rely on these exact names):
  - `ScheduledTaskNotification.type: 'none' | 'slack' | 'jira' | 'telegram'` + `chatId?: string`
  - `type ScheduledOutcome = 'result' | 'failure' | 'attention'` (exported from `@/lib/gateway/types`)
  - `ChannelAdapter.sendScheduledNotification?(task: ScheduledTask, run: AgentOpsRun, outcome: ScheduledOutcome): Promise<void>`
  - `getAdapterRegistry(): AdapterRegistry` (exported from `@/lib/gateway`)
  - `buildDashboardRunUrl(runId: string): string` → `${APP_BASE_URL}/app/agent-ops/${runId}`

- [ ] **Step 1: Capture baselines** (record both numbers in the task notes / commit message)

```bash
cd apps/web-ui && bunx tsc --noEmit 2>&1 | grep -c "error TS"
```
Expected: a number ≈ 190. Record it as `TSC_BASELINE`.

- [ ] **Step 2: Extend `ScheduledTaskNotification`** in `apps/web-ui/lib/agent-ops/types.ts`

Replace:
```ts
export interface ScheduledTaskNotification {
    type: 'none' | 'slack' | 'jira';
    channelId?: string;
    channelName?: string;
    projectKey?: string;
    issueKey?: string;
}
```
with:
```ts
export interface ScheduledTaskNotification {
    type: 'none' | 'slack' | 'jira' | 'telegram';
    channelId?: string;      // slack
    channelName?: string;    // slack (display only)
    chatId?: string;         // telegram
    projectKey?: string;     // jira
    issueKey?: string;       // jira
}
```

- [ ] **Step 3: Add `ScheduledOutcome` + adapter method** in `apps/web-ui/lib/gateway/types.ts`

Change the import at the top:
```ts
import type { AgentOpsRun, AgentOpsEvent, ScheduledTask } from '@/lib/agent-ops/types';
```
Add after the `GatewayEvent` interface:
```ts
/** Outcome category for a finished (or parked) scheduled run digest. */
export type ScheduledOutcome = 'result' | 'failure' | 'attention';
```
Add to the `ChannelAdapter` interface, after `sendStreamChunk?`:
```ts
    /**
     * Proactive one-shot digest for a scheduled run (server → channel,
     * unidirectional). Destination comes from task.notification; credentials
     * from TenantConfig via run.tenantId. Implementations must never throw.
     */
    sendScheduledNotification?(task: ScheduledTask, run: AgentOpsRun, outcome: ScheduledOutcome): Promise<void>;
```

- [ ] **Step 4: Add `getAdapterRegistry()`** in `apps/web-ui/lib/gateway/index.ts`

Replace the globalThis declaration and `createGatewayService` with:
```ts
const g = globalThis as typeof globalThis & {
    _gatewayService?: GatewayService;
    _adapterRegistry?: AdapterRegistry;
};

/** Singleton adapter registry — usable without the full gateway service (e.g. scheduled-run delivery). */
export function getAdapterRegistry(): AdapterRegistry {
    if (!g._adapterRegistry) {
        const registry = new AdapterRegistry();
        registry.register(new SlackAdapter());
        registry.register(new JiraAdapter());
        registry.register(new DiscordAdapter());
        registry.register(new TelegramAdapter());
        registry.register(new WebhookAdapter());
        registry.register(new ApiAdapter());
        g._adapterRegistry = registry;
    }
    return g._adapterRegistry;
}

function createGatewayService(): GatewayService {
    const registry = getAdapterRegistry();
    const eventBus = getGatewayEventBus();
    const router = new NotificationRouter(eventBus, registry);

    return new GatewayService(registry, eventBus, router);
}
```
Also add `ScheduledOutcome` to the type re-exports on the last line:
```ts
export type { ChannelType, ChannelAdapter, GatewayMessage, GatewayEvent, ReplyContext, ScheduledOutcome } from './types';
```

- [ ] **Step 5: Add `buildDashboardRunUrl`** in `apps/web-ui/lib/gateway/utils/dashboard-url.ts`

Append:
```ts
export function buildDashboardRunUrl(runId: string): string {
    return `${APP_BASE_URL}/app/agent-ops/${runId}`;
}
```

- [ ] **Step 6: Verify tsc error count did not increase**

```bash
cd apps/web-ui && bunx tsc --noEmit 2>&1 | grep -c "error TS"
```
Expected: ≤ `TSC_BASELINE`.

- [ ] **Step 7: Commit**

```bash
git add apps/web-ui/lib/agent-ops/types.ts apps/web-ui/lib/gateway/types.ts apps/web-ui/lib/gateway/index.ts apps/web-ui/lib/gateway/utils/dashboard-url.ts
git commit -m "feat(agent-ops): scheduled-notification types, adapter contract, registry accessor"
```

---

### Task 2: Notifier rewrite — outcome mapping, direct dispatch, finalize helper (TDD)

**Files:**
- Modify: `apps/web-ui/lib/agent-ops/scheduled-notifier.ts` (full rewrite)
- Test: `apps/web-ui/tests/agent-ops/scheduled-notifier.test.ts` (new)

**Interfaces:**
- Consumes: `getAdapterRegistry()` from `@/lib/gateway` (Task 1), `getScheduledTask`/`updateLastRun` from `./scheduled-task-service` (existing: `getScheduledTask(tenantId, taskId)`, `updateLastRun(tenantId, taskId, runId, status)`).
- Produces (Tasks 5–6 rely on):
  - `mapRunStatusToOutcome(status: AgentOpsStatus): ScheduledOutcome | null`
  - `notifyScheduledRunResult(task: ScheduledTask, run: AgentOpsRun): Promise<void>` (same name as today — trigger route import keeps working)
  - `finalizeScheduledRun(run: AgentOpsRun): Promise<void>` — no-op unless `run.source === 'scheduled'` with a `trigger.taskId`; loads task, calls `updateLastRun`, then `notifyScheduledRunResult`. Never throws.

- [ ] **Step 1: Write the failing test** — `apps/web-ui/tests/agent-ops/scheduled-notifier.test.ts`

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ScheduledTask, AgentOpsRun } from '@/lib/agent-ops/types';

const { sendScheduledNotification, registryHas, registryGet, mockGetScheduledTask, mockUpdateLastRun } = vi.hoisted(() => ({
    sendScheduledNotification: vi.fn(),
    registryHas: vi.fn(),
    registryGet: vi.fn(),
    mockGetScheduledTask: vi.fn(),
    mockUpdateLastRun: vi.fn(),
}));

vi.mock('@/lib/gateway', () => ({
    getAdapterRegistry: () => ({ has: registryHas, get: registryGet }),
}));

vi.mock('@/lib/agent-ops/scheduled-task-service', () => ({
    getScheduledTask: mockGetScheduledTask,
    updateLastRun: mockUpdateLastRun,
}));

import {
    mapRunStatusToOutcome,
    notifyScheduledRunResult,
    finalizeScheduledRun,
} from '@/lib/agent-ops/scheduled-notifier';

function makeTask(over: Record<string, unknown> = {}): ScheduledTask {
    return {
        taskId: 'task-1',
        tenantId: 'tenant-1',
        name: 'Daily Review',
        description: 'check costs',
        notification: { type: 'slack', channelId: 'C1' },
        ...over,
    } as unknown as ScheduledTask;
}

function makeRun(over: Record<string, unknown> = {}): AgentOpsRun {
    return {
        runId: 'run-1',
        tenantId: 'tenant-1',
        source: 'scheduled',
        status: 'completed',
        taskDescription: 'check costs',
        trigger: { taskId: 'task-1', taskName: 'Daily Review', scheduledAt: '2026-07-05T00:00:00Z' },
        result: { summary: 'All good', toolsUsed: ['execute_command'], iterations: 1 },
        ...over,
    } as unknown as AgentOpsRun;
}

beforeEach(() => {
    vi.clearAllMocks();
    registryHas.mockReturnValue(true);
    registryGet.mockReturnValue({ sendScheduledNotification });
    mockGetScheduledTask.mockResolvedValue(makeTask());
    mockUpdateLastRun.mockResolvedValue(undefined);
    sendScheduledNotification.mockResolvedValue(undefined);
});

describe('mapRunStatusToOutcome', () => {
    it('maps completed → result', () => expect(mapRunStatusToOutcome('completed')).toBe('result'));
    it('maps failed → failure', () => expect(mapRunStatusToOutcome('failed')).toBe('failure'));
    it('maps cancelled → failure', () => expect(mapRunStatusToOutcome('cancelled')).toBe('failure'));
    it('maps awaiting_input → attention', () => expect(mapRunStatusToOutcome('awaiting_input')).toBe('attention'));
    it('maps awaiting_approval → attention', () => expect(mapRunStatusToOutcome('awaiting_approval')).toBe('attention'));
    it('maps queued / in_progress → null', () => {
        expect(mapRunStatusToOutcome('queued')).toBeNull();
        expect(mapRunStatusToOutcome('in_progress')).toBeNull();
    });
});

describe('notifyScheduledRunResult', () => {
    it('dispatches to the adapter named by notification.type with the mapped outcome', async () => {
        await notifyScheduledRunResult(makeTask(), makeRun());
        expect(registryGet).toHaveBeenCalledWith('slack');
        expect(sendScheduledNotification).toHaveBeenCalledTimes(1);
        const [taskArg, runArg, outcomeArg] = sendScheduledNotification.mock.calls[0];
        expect(taskArg.taskId).toBe('task-1');
        expect(runArg.runId).toBe('run-1');
        expect(outcomeArg).toBe('result');
    });

    it('sends failure outcome for a failed run', async () => {
        await notifyScheduledRunResult(makeTask(), makeRun({ status: 'failed', error: 'boom' }));
        expect(sendScheduledNotification.mock.calls[0][2]).toBe('failure');
    });

    it('sends attention outcome for an awaiting_approval run', async () => {
        await notifyScheduledRunResult(makeTask(), makeRun({ status: 'awaiting_approval' }));
        expect(sendScheduledNotification.mock.calls[0][2]).toBe('attention');
    });

    it('skips when notification.type is none', async () => {
        await notifyScheduledRunResult(makeTask({ notification: { type: 'none' } }), makeRun());
        expect(sendScheduledNotification).not.toHaveBeenCalled();
    });

    it('skips when no adapter is registered for the type', async () => {
        registryHas.mockReturnValue(false);
        await notifyScheduledRunResult(makeTask(), makeRun());
        expect(sendScheduledNotification).not.toHaveBeenCalled();
    });

    it('skips when the adapter has no sendScheduledNotification (e.g. jira in v1)', async () => {
        registryGet.mockReturnValue({});
        await expect(notifyScheduledRunResult(makeTask({ notification: { type: 'jira', issueKey: 'OPS-1' } }), makeRun()))
            .resolves.toBeUndefined();
    });

    it('skips when run status maps to no outcome', async () => {
        await notifyScheduledRunResult(makeTask(), makeRun({ status: 'in_progress' }));
        expect(sendScheduledNotification).not.toHaveBeenCalled();
    });

    it('never throws when the adapter throws', async () => {
        sendScheduledNotification.mockRejectedValue(new Error('slack down'));
        await expect(notifyScheduledRunResult(makeTask(), makeRun())).resolves.toBeUndefined();
    });
});

describe('finalizeScheduledRun', () => {
    it('no-ops for non-scheduled runs', async () => {
        await finalizeScheduledRun(makeRun({ source: 'slack' }));
        expect(mockGetScheduledTask).not.toHaveBeenCalled();
        expect(mockUpdateLastRun).not.toHaveBeenCalled();
    });

    it('no-ops when trigger has no taskId', async () => {
        await finalizeScheduledRun(makeRun({ trigger: {} }));
        expect(mockGetScheduledTask).not.toHaveBeenCalled();
    });

    it('updates lastRun and delivers the digest for a scheduled run', async () => {
        await finalizeScheduledRun(makeRun());
        expect(mockGetScheduledTask).toHaveBeenCalledWith('tenant-1', 'task-1');
        expect(mockUpdateLastRun).toHaveBeenCalledWith('tenant-1', 'task-1', 'run-1', 'completed');
        expect(sendScheduledNotification).toHaveBeenCalledTimes(1);
    });

    it('no-ops delivery when the task no longer exists', async () => {
        mockGetScheduledTask.mockResolvedValue(null);
        await finalizeScheduledRun(makeRun());
        expect(mockUpdateLastRun).not.toHaveBeenCalled();
        expect(sendScheduledNotification).not.toHaveBeenCalled();
    });

    it('never throws when updateLastRun rejects', async () => {
        mockUpdateLastRun.mockRejectedValue(new Error('db down'));
        await expect(finalizeScheduledRun(makeRun())).resolves.toBeUndefined();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/web-ui && bunx vitest run tests/agent-ops/scheduled-notifier.test.ts
```
Expected: FAIL — `mapRunStatusToOutcome`/`finalizeScheduledRun` are not exported.

- [ ] **Step 3: Rewrite `apps/web-ui/lib/agent-ops/scheduled-notifier.ts`** (replace entire file)

```ts
// web-ui/lib/agent-ops/scheduled-notifier.ts
/**
 * Scheduled-run channel delivery — direct dispatch, unidirectional (server → channel).
 *
 * The adapter is resolved from task.notification.type; the destination comes
 * from task.notification (channelId / chatId); credentials load per-tenant
 * inside the adapter. Delivery is best-effort: nothing here ever throws.
 */
import type { ScheduledTask, AgentOpsRun, AgentOpsStatus } from './types';
import type { ChannelType, ScheduledOutcome } from '@/lib/gateway/types';
import { getAdapterRegistry } from '@/lib/gateway';
import { getScheduledTask, updateLastRun } from './scheduled-task-service';

export function mapRunStatusToOutcome(status: AgentOpsStatus): ScheduledOutcome | null {
    switch (status) {
        case 'completed':
            return 'result';
        case 'failed':
        case 'cancelled':
            return 'failure';
        case 'awaiting_input':
        case 'awaiting_approval':
            return 'attention';
        default:
            return null; // queued / in_progress — nothing to report yet
    }
}

export async function notifyScheduledRunResult(task: ScheduledTask, run: AgentOpsRun): Promise<void> {
    try {
        const type = task.notification?.type;
        if (!type || type === 'none') return;

        const outcome = mapRunStatusToOutcome(run.status);
        if (!outcome) {
            console.warn(`[ScheduledNotifier] Run ${run.runId} status '${run.status}' has no digest — skipping`);
            return;
        }

        const registry = getAdapterRegistry();
        if (!registry.has(type as ChannelType)) {
            console.warn(`[ScheduledNotifier] No adapter for notification type '${type}' — skipping`);
            return;
        }
        const adapter = registry.get(type as ChannelType);
        if (!adapter.sendScheduledNotification) {
            console.warn(`[ScheduledNotifier] Adapter '${type}' does not support scheduled notifications — skipping`);
            return;
        }

        await adapter.sendScheduledNotification(task, run, outcome);
        console.log(`[ScheduledNotifier] Delivered '${outcome}' digest for run ${run.runId} via ${type}`);
    } catch (err) {
        console.error('[ScheduledNotifier] Notification failed (non-fatal):', err);
    }
}

/**
 * Post-run finalization for scheduled runs: refresh lastRun* on the task and
 * deliver the outcome digest. Safe to call with any run — no-ops unless
 * run.source === 'scheduled' with a taskId on the trigger. Never throws.
 */
export async function finalizeScheduledRun(run: AgentOpsRun): Promise<void> {
    try {
        if (run.source !== 'scheduled') return;
        const taskId = (run.trigger as { taskId?: string } | null)?.taskId;
        if (!taskId) return;

        const task = await getScheduledTask(run.tenantId, taskId);
        if (!task) {
            console.warn(`[ScheduledNotifier] Task ${taskId} not found for run ${run.runId} — skipping finalize`);
            return;
        }

        await updateLastRun(run.tenantId, taskId, run.runId, run.status);
        await notifyScheduledRunResult(task, run);
    } catch (err) {
        console.error('[ScheduledNotifier] finalizeScheduledRun failed (non-fatal):', err);
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/web-ui && bunx vitest run tests/agent-ops/scheduled-notifier.test.ts
```
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/agent-ops/scheduled-notifier.ts apps/web-ui/tests/agent-ops/scheduled-notifier.test.ts
git commit -m "feat(agent-ops): direct-dispatch scheduled notifier with finalize helper"
```

---

### Task 3: Slack adapter — `sendScheduledNotification` (TDD)

**Files:**
- Modify: `apps/web-ui/lib/gateway/adapters/slack-adapter.ts`
- Test: `apps/web-ui/tests/gateway/adapters/slack-adapter.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `ScheduledOutcome` + `ScheduledTask` types (Task 1), `buildDashboardRunUrl` (Task 1), existing private `loadConfig(tenantId)`.
- Produces: `SlackAdapter.sendScheduledNotification(task, run, outcome)` posting Block Kit to `task.notification.channelId` via `chat.postMessage` with the tenant `botToken`.

- [ ] **Step 1: Write the failing test** — append to `apps/web-ui/tests/gateway/adapters/slack-adapter.test.ts` (inside the top-level `describe('SlackAdapter')` or as a sibling describe; module-level mocks already stub `@/lib/tenant-config-service`)

```ts
import { TenantConfigService } from '@/lib/tenant-config-service';
import type { ScheduledTask, AgentOpsRun } from '@/lib/agent-ops/types';

describe('SlackAdapter.sendScheduledNotification', () => {
    let adapter: SlackAdapter;

    const task = {
        taskId: 'task-1',
        tenantId: 'tenant-1',
        name: 'Daily Cost Review',
        notification: { type: 'slack', channelId: 'C0SCHED' },
    } as unknown as ScheduledTask;

    const run = {
        runId: 'run-1',
        tenantId: 'tenant-1',
        source: 'scheduled',
        status: 'completed',
        durationMs: 42000,
        trigger: { taskId: 'task-1', taskName: 'Daily Cost Review', scheduledAt: '2026-07-05T00:00:00Z' },
        result: { summary: 'No anomalies found', toolsUsed: ['execute_command'], iterations: 2 },
    } as unknown as AgentOpsRun;

    beforeEach(() => {
        adapter = new SlackAdapter();
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({
            signingSecret: 'test-secret',
            botToken: 'xoxb-test-token',
            enabled: true,
        });
        global.fetch = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ ok: true, ts: '1.2' }), { status: 200 }),
        ) as unknown as typeof fetch;
    });

    it('posts a result digest to the configured channel with the tenant botToken', async () => {
        await adapter.sendScheduledNotification!(task, run, 'result');

        expect(global.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = vi.mocked(global.fetch).mock.calls[0];
        expect(url).toBe('https://slack.com/api/chat.postMessage');
        expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer xoxb-test-token');
        const body = JSON.parse(init!.body as string);
        expect(body.channel).toBe('C0SCHED');
        expect(JSON.stringify(body.blocks)).toContain('No anomalies found');
        expect(JSON.stringify(body.blocks)).toContain('run-1');
    });

    it('posts a failure digest containing the error', async () => {
        const failed = { ...run, status: 'failed', error: 'AccessDenied on ec2:StopInstances' } as unknown as AgentOpsRun;
        await adapter.sendScheduledNotification!(task, failed, 'failure');
        const body = JSON.parse(vi.mocked(global.fetch).mock.calls[0][1]!.body as string);
        expect(JSON.stringify(body.blocks)).toContain('AccessDenied on ec2:StopInstances');
    });

    it('posts an attention digest with a dashboard link', async () => {
        const parked = {
            ...run, status: 'awaiting_approval',
            approvalRequest: { planSteps: ['stop idle instances'], approvalType: 'plan' },
        } as unknown as AgentOpsRun;
        await adapter.sendScheduledNotification!(task, parked, 'attention');
        const body = JSON.parse(vi.mocked(global.fetch).mock.calls[0][1]!.body as string);
        expect(JSON.stringify(body.blocks)).toContain('/app/agent-ops/run-1');
    });

    it('no-ops without a channelId', async () => {
        const noDest = { ...task, notification: { type: 'slack' } } as unknown as ScheduledTask;
        await adapter.sendScheduledNotification!(noDest, run, 'result');
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('no-ops without a botToken', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        await adapter.sendScheduledNotification!(task, run, 'result');
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('never throws when fetch rejects', async () => {
        vi.mocked(global.fetch).mockRejectedValue(new Error('network down'));
        await expect(adapter.sendScheduledNotification!(task, run, 'result')).resolves.toBeUndefined();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/web-ui && bunx vitest run tests/gateway/adapters/slack-adapter.test.ts
```
Expected: FAIL — `sendScheduledNotification` is not a function.

- [ ] **Step 3: Implement** in `apps/web-ui/lib/gateway/adapters/slack-adapter.ts`

Update imports:
```ts
import { buildDashboardRespondUrl, buildDashboardRunUrl } from '@/lib/gateway/utils/dashboard-url';
import type {
    ChannelAdapter,
    ChannelType,
    DeliveryMode,
    HilCapabilities,
    GatewayMessage,
    ReplyContext,
    ScheduledOutcome,
} from '@/lib/gateway/types';
import type {
    AgentOpsRun,
    AgentOpsEvent,
    ScheduledTask,
    SlackIntegrationConfig,
    SlackTriggerMeta,
} from '@/lib/agent-ops/types';
```
Add the method in the `// ─── Outbound ───` section (after `sendApprovalRequest`):
```ts
    async sendScheduledNotification(
        task: ScheduledTask,
        run: AgentOpsRun,
        outcome: ScheduledOutcome,
    ): Promise<void> {
        const channelId = task.notification?.channelId;
        if (!channelId) {
            console.warn('[SlackAdapter] sendScheduledNotification: no channelId on task notification');
            return;
        }
        const config = await this.loadConfig(run.tenantId);
        if (!config?.botToken) {
            console.warn('[SlackAdapter] sendScheduledNotification: no botToken configured');
            return;
        }

        const dashboardUrl = buildDashboardRunUrl(run.runId);
        const durationSec = Math.round((run.durationMs ?? 0) / 1000);

        let header: string;
        let detail: string;
        if (outcome === 'result') {
            header = `✅ Scheduled task "${task.name}" completed`;
            const tools = run.result?.toolsUsed?.length
                ? `\n*Tools:* ${run.result.toolsUsed.join(', ')}`
                : '';
            detail = `${run.result?.summary ?? '(no summary)'}${tools}\n*Duration:* ${durationSec}s`;
        } else if (outcome === 'failure') {
            header = `❌ Scheduled task "${task.name}" ${run.status === 'cancelled' ? 'was cancelled' : 'failed'}`;
            detail = run.error ?? 'Run did not complete.';
        } else {
            header = `⏸️ Scheduled task "${task.name}" needs your attention`;
            detail = run.clarification?.question
                ?? (run.approvalRequest
                    ? `Approval required (${run.approvalRequest.approvalType}).`
                    : `Run is ${run.status.replace('_', ' ')}.`);
        }

        const blocks = [
            {
                type: 'section',
                text: { type: 'mrkdwn', text: `*${header}*\n\n${detail.slice(0, 2900)}` },
            },
            {
                type: 'context',
                elements: [{ type: 'mrkdwn', text: `Run \`${run.runId}\` · <${dashboardUrl}|Open in dashboard>` }],
            },
        ];

        try {
            const res = await fetch('https://slack.com/api/chat.postMessage', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${config.botToken}`,
                },
                body: JSON.stringify({ channel: channelId, blocks, text: header }),
            });
            const data = await res.json();
            if (!data.ok) {
                console.warn('[SlackAdapter] sendScheduledNotification post failed:', data.error);
            }
        } catch (err) {
            console.error('[SlackAdapter] sendScheduledNotification error:', err);
        }
    }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/web-ui && bunx vitest run tests/gateway/adapters/slack-adapter.test.ts
```
Expected: PASS — new tests green, pre-existing tests in the file unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/gateway/adapters/slack-adapter.ts apps/web-ui/tests/gateway/adapters/slack-adapter.test.ts
git commit -m "feat(gateway): Slack scheduled-run digest via sendScheduledNotification"
```

---

### Task 4: Telegram adapter — `sendScheduledNotification` (TDD)

**Files:**
- Modify: `apps/web-ui/lib/gateway/adapters/telegram-adapter.ts`
- Test: `apps/web-ui/tests/gateway/adapters/telegram-adapter.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `task.notification.chatId` (Task 1 type), `buildDashboardRunUrl` (Task 1), existing private `sendMessage(run, chatId, text)` and `escapeMarkdownV2`.
- Produces: `TelegramAdapter.sendScheduledNotification(task, run, outcome)` sending a MarkdownV2 digest to `Number(task.notification.chatId)`.

Note: this test file's top-level `beforeEach` calls `vi.restoreAllMocks()`, which wipes the module-mock implementation of `TenantConfigService.getConfig` — the new describe block must re-set it (shown below).

- [ ] **Step 1: Write the failing test** — append to `apps/web-ui/tests/gateway/adapters/telegram-adapter.test.ts`

```ts
import { TenantConfigService } from '@/lib/tenant-config-service';
import type { ScheduledTask, AgentOpsRun } from '@/lib/agent-ops/types';

describe('TelegramAdapter.sendScheduledNotification', () => {
    let adapter: TelegramAdapter;

    const task = {
        taskId: 'task-1',
        tenantId: 'tenant-1',
        name: 'Daily Cost Review',
        notification: { type: 'telegram', chatId: '-1001234567890' },
    } as unknown as ScheduledTask;

    const run = {
        runId: 'run-1',
        tenantId: 'tenant-1',
        source: 'scheduled',
        status: 'completed',
        durationMs: 42000,
        trigger: { taskId: 'task-1', taskName: 'Daily Cost Review', scheduledAt: '2026-07-05T00:00:00Z' },
        result: { summary: 'No anomalies found', toolsUsed: ['execute_command'], iterations: 2 },
    } as unknown as AgentOpsRun;

    beforeEach(() => {
        adapter = new TelegramAdapter();
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({
            botToken: 'tg-bot-token',
            secretToken: 'tg-secret',
            enabled: true,
        });
        global.fetch = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ ok: true }), { status: 200 }),
        ) as unknown as typeof fetch;
    });

    it('sends a result digest to the configured chat with the tenant botToken', async () => {
        await adapter.sendScheduledNotification!(task, run, 'result');

        expect(global.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = vi.mocked(global.fetch).mock.calls[0];
        expect(url).toBe('https://api.telegram.org/bottg-bot-token/sendMessage');
        const body = JSON.parse(init!.body as string);
        expect(body.chat_id).toBe(-1001234567890);
        expect(body.parse_mode).toBe('MarkdownV2');
        expect(body.text).toContain('No anomalies found');
    });

    it('sends a failure digest containing the error', async () => {
        const failed = { ...run, status: 'failed', error: 'permission denied' } as unknown as AgentOpsRun;
        await adapter.sendScheduledNotification!(task, failed, 'failure');
        const body = JSON.parse(vi.mocked(global.fetch).mock.calls[0][1]!.body as string);
        expect(body.text).toContain('permission denied');
    });

    it('sends an attention digest with a dashboard link', async () => {
        const parked = {
            ...run, status: 'awaiting_input',
            clarification: { question: 'Which region?', missingInfo: 'region' },
        } as unknown as AgentOpsRun;
        await adapter.sendScheduledNotification!(task, parked, 'attention');
        const body = JSON.parse(vi.mocked(global.fetch).mock.calls[0][1]!.body as string);
        expect(body.text).toContain('Which region');
        expect(body.text).toContain('run\\-1');
    });

    it('no-ops without a chatId', async () => {
        const noDest = { ...task, notification: { type: 'telegram' } } as unknown as ScheduledTask;
        await adapter.sendScheduledNotification!(noDest, run, 'result');
        expect(global.fetch).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/web-ui && bunx vitest run tests/gateway/adapters/telegram-adapter.test.ts
```
Expected: FAIL — `sendScheduledNotification` is not a function.

- [ ] **Step 3: Implement** in `apps/web-ui/lib/gateway/adapters/telegram-adapter.ts`

Update imports:
```ts
import { buildDashboardRespondUrl, buildDashboardRunUrl } from '@/lib/gateway/utils/dashboard-url';
import type {
    ChannelAdapter,
    ChannelType,
    DeliveryMode,
    HilCapabilities,
    GatewayMessage,
    ReplyContext,
    ScheduledOutcome,
} from '@/lib/gateway/types';
import type {
    AgentOpsRun,
    AgentOpsEvent,
    ScheduledTask,
    TelegramTriggerMeta,
} from '@/lib/agent-ops/types';
```
Add the method in the `// ─── Outbound ───` section (after `sendStreamChunk`):
```ts
    async sendScheduledNotification(
        task: ScheduledTask,
        run: AgentOpsRun,
        outcome: ScheduledOutcome,
    ): Promise<void> {
        const chatIdRaw = task.notification?.chatId;
        if (!chatIdRaw) {
            console.warn('[TelegramAdapter] sendScheduledNotification: no chatId on task notification');
            return;
        }
        const chatId = Number(chatIdRaw);
        const dashboardUrl = buildDashboardRunUrl(run.runId);
        const durationSec = Math.round((run.durationMs ?? 0) / 1000);

        let lines: string[];
        if (outcome === 'result') {
            lines = [
                `*Scheduled task complete* — ${escapeMarkdownV2(task.name)}`,
                '',
                escapeMarkdownV2(run.result?.summary ?? '(no summary)'),
                '',
                `*Tools:* ${escapeMarkdownV2(run.result?.toolsUsed?.join(', ') || 'None')}`,
                `*Duration:* ${durationSec}s`,
            ];
        } else if (outcome === 'failure') {
            lines = [
                `*Scheduled task ${run.status === 'cancelled' ? 'cancelled' : 'failed'}* — ${escapeMarkdownV2(task.name)}`,
                '',
                escapeMarkdownV2(run.error ?? 'Run did not complete.'),
            ];
        } else {
            lines = [
                `*Scheduled task needs attention* — ${escapeMarkdownV2(task.name)}`,
                '',
                escapeMarkdownV2(run.clarification?.question ?? `Run is ${run.status.replace('_', ' ')}.`),
            ];
        }
        lines.push('', `Run ${escapeMarkdownV2(run.runId)}`, `[Open dashboard](${escapeMarkdownV2(dashboardUrl)})`);

        await this.sendMessage(run, chatId, lines.join('\n'));
    }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/web-ui && bunx vitest run tests/gateway/adapters/telegram-adapter.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/gateway/adapters/telegram-adapter.ts apps/web-ui/tests/gateway/adapters/telegram-adapter.test.ts
git commit -m "feat(gateway): Telegram scheduled-run digest via sendScheduledNotification"
```

---

### Task 5: Trigger route — execution lock + finalize refactor (TDD)

**Files:**
- Modify: `apps/web-ui/app/api/agent-ops/scheduled-tasks/[taskId]/trigger/route.ts`
- Test: `apps/web-ui/tests/agent-ops/scheduled-trigger.test.ts` (new)

**Interfaces:**
- Consumes: `tryAcquireExecutionLock(taskId, scheduledAt)` from `@/lib/agent-ops/scheduled-task-service` (existing), `finalizeScheduledRun` (Task 2).
- Produces: `POST /api/agent-ops/scheduled-tasks/[taskId]/trigger` returns 409 `{ success: false, skipped: true }` when the same task already fired in the current minute window.

- [ ] **Step 1: Write the failing test** — `apps/web-ui/tests/agent-ops/scheduled-trigger.test.ts`

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
    mockGetScheduledTask,
    mockUpdateLastRun,
    mockTryAcquireLock,
    mockCreateRun,
    mockGetRun,
    mockExecuteAgentRun,
    mockFinalize,
} = vi.hoisted(() => ({
    mockGetScheduledTask: vi.fn(),
    mockUpdateLastRun: vi.fn(),
    mockTryAcquireLock: vi.fn(),
    mockCreateRun: vi.fn(),
    mockGetRun: vi.fn(),
    mockExecuteAgentRun: vi.fn(),
    mockFinalize: vi.fn(),
}));

vi.mock('@/lib/agent-ops/scheduled-task-service', () => ({
    getScheduledTask: mockGetScheduledTask,
    updateLastRun: mockUpdateLastRun,
    tryAcquireExecutionLock: mockTryAcquireLock,
}));
vi.mock('@/lib/agent-ops/agent-ops-service', () => ({
    agentOpsService: { createRun: mockCreateRun, getRun: mockGetRun },
}));
vi.mock('@/lib/agent-ops/agent-executor', () => ({ executeAgentRun: mockExecuteAgentRun }));
vi.mock('@/lib/agent-ops/scheduled-notifier', () => ({ finalizeScheduledRun: mockFinalize }));
vi.mock('@/lib/auth-session', () => ({
    getSessionTenantId: vi.fn().mockResolvedValue('tenant-1'),
    getAuthSession: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/audit-service', () => ({
    AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@/env', () => ({ env: { INTERNAL_API_KEY: 'test-internal-key' } }));

import { POST } from '../../app/api/agent-ops/scheduled-tasks/[taskId]/trigger/route';

const task = {
    taskId: 'task-1',
    tenantId: 'tenant-1',
    name: 'Daily Review',
    description: 'check costs',
    mode: 'fast',
    autoApprove: true,
    mcpServerIds: [],
    notification: { type: 'slack', channelId: 'C1' },
};

function makeRequest(): Request {
    return new Request('http://localhost/api/agent-ops/scheduled-tasks/task-1/trigger', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-internal-key': 'test-internal-key',
            'x-tenant-id': 'tenant-1',
        },
        body: JSON.stringify({ source: 'worker' }),
    });
}

const routeParams = { params: Promise.resolve({ taskId: 'task-1' }) };

beforeEach(() => {
    vi.clearAllMocks();
    mockGetScheduledTask.mockResolvedValue(task);
    mockTryAcquireLock.mockResolvedValue(true);
    mockCreateRun.mockResolvedValue({ runId: 'run-1', status: 'queued', tenantId: 'tenant-1', source: 'scheduled' });
    mockGetRun.mockResolvedValue({ runId: 'run-1', status: 'completed', tenantId: 'tenant-1', source: 'scheduled', trigger: { taskId: 'task-1' } });
    mockExecuteAgentRun.mockResolvedValue(undefined);
    mockFinalize.mockResolvedValue(undefined);
});

describe('POST /scheduled-tasks/[taskId]/trigger', () => {
    it('creates and executes a run when the lock is acquired', async () => {
        const res = await POST(makeRequest(), routeParams);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.runId).toBe('run-1');
        expect(mockCreateRun).toHaveBeenCalledTimes(1);
        expect(mockExecuteAgentRun).toHaveBeenCalledTimes(1);
    });

    it('acquires the lock on a minute-rounded window key', async () => {
        await POST(makeRequest(), routeParams);
        expect(mockTryAcquireLock).toHaveBeenCalledTimes(1);
        const [taskIdArg, windowArg] = mockTryAcquireLock.mock.calls[0];
        expect(taskIdArg).toBe('task-1');
        expect(windowArg).toMatch(/T\d{2}:\d{2}:00\.000Z$/);
    });

    it('returns 409 skipped without creating a run when the lock is held', async () => {
        mockTryAcquireLock.mockResolvedValue(false);
        const res = await POST(makeRequest(), routeParams);
        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.skipped).toBe(true);
        expect(mockCreateRun).not.toHaveBeenCalled();
        expect(mockExecuteAgentRun).not.toHaveBeenCalled();
    });

    it('finalizes the scheduled run after execution settles', async () => {
        await POST(makeRequest(), routeParams);
        // Drain the fire-and-forget promise chain
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setImmediate(resolve));
        expect(mockFinalize).toHaveBeenCalledTimes(1);
        expect(mockFinalize.mock.calls[0][0].runId).toBe('run-1');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/web-ui && bunx vitest run tests/agent-ops/scheduled-trigger.test.ts
```
Expected: FAIL — lock test fails (`tryAcquireExecutionLock` never called) and finalize test fails.

- [ ] **Step 3: Modify the trigger route** — replace the body of `POST` in `apps/web-ui/app/api/agent-ops/scheduled-tasks/[taskId]/trigger/route.ts`

Update imports (add `tryAcquireExecutionLock`, swap notifier import):
```ts
import { getScheduledTask, updateLastRun, tryAcquireExecutionLock } from '@/lib/agent-ops/scheduled-task-service';
import { finalizeScheduledRun } from '@/lib/agent-ops/scheduled-notifier';
```
(remove the now-unused `import { notifyScheduledRunResult } ...` line)

Inside `POST`, after the `if (!task) ...` guard and before `createRun`, add:
```ts
        // Suppress duplicate triggers in the same minute window — a cron tick
        // racing a manual trigger across ECS containers (AOPS-04).
        const lockWindow = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
        const lockAcquired = await tryAcquireExecutionLock(taskId, lockWindow);
        if (!lockAcquired) {
            return NextResponse.json(
                { success: false, skipped: true, error: 'Duplicate trigger suppressed by execution lock' },
                { status: 409 },
            );
        }
```
Replace the fire-and-forget block:
```ts
        // Fire-and-forget — lastRun refresh + channel delivery happen post-run
        executeAgentRun(run)
            .then(async () => {
                const freshRun = await agentOpsService.getRun(task.tenantId, run.runId);
                if (freshRun) {
                    await finalizeScheduledRun(freshRun);
                } else {
                    await updateLastRun(task.tenantId, task.taskId, run.runId, 'completed');
                }
            })
            .catch(err => console.error(`[trigger] Run ${run.runId} failed:`, err));
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/web-ui && bunx vitest run tests/agent-ops/scheduled-trigger.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add "apps/web-ui/app/api/agent-ops/scheduled-tasks/[taskId]/trigger/route.ts" apps/web-ui/tests/agent-ops/scheduled-trigger.test.ts
git commit -m "feat(agent-ops): execution lock + finalize hook on scheduled-task trigger route"
```

---

### Task 6: Close the HIL loop — finalize hook on approve + resume routes

**Files:**
- Modify: `apps/web-ui/app/api/agent-ops/[runId]/approve/route.ts`
- Modify: `apps/web-ui/app/api/agent-ops/[runId]/resume/route.ts`

**Interfaces:**
- Consumes: `finalizeScheduledRun(run)` (Task 2 — already fully unit-tested; these are 3-line wiring changes verified by tsc + existing suites).
- Produces: a scheduled run approved/resumed from the dashboard still delivers its final digest and refreshes `lastRunStatus`.

- [ ] **Step 1: Wire approve route** — in `approve/route.ts`

Add import:
```ts
import { finalizeScheduledRun } from '@/lib/agent-ops/scheduled-notifier';
```
In the REJECT branch, after the `eventBus.emit({ type: 'run:cancelled', ... })` line, add:
```ts
            // Scheduled runs: refresh lastRunStatus and deliver the cancellation digest
            await finalizeScheduledRun({ ...run, status: 'cancelled' });
```
In the APPROVE branch, replace:
```ts
        resumeApprovedRun(run, eventBus).catch((err) => {
            console.error(`[Agent Ops API] Resume failed for run ${runId}:`, err);
        });
```
with:
```ts
        resumeApprovedRun(run, eventBus)
            .then(async () => {
                // Scheduled runs: deliver the final digest to the task's channel
                const freshRun = await agentOpsService.getRun(tenantId, runId);
                if (freshRun) await finalizeScheduledRun(freshRun);
            })
            .catch((err) => {
                console.error(`[Agent Ops API] Resume failed for run ${runId}:`, err);
            });
```

- [ ] **Step 2: Wire resume route** — in `resume/route.ts`

Add import:
```ts
import { finalizeScheduledRun } from '@/lib/agent-ops/scheduled-notifier';
```
Replace:
```ts
        executeAgentRun(resumedRun).catch((err) => {
            console.error(`[ResumeEndpoint] Execution error for run ${runId}:`, err);
        });
```
with:
```ts
        executeAgentRun(resumedRun)
            .then(async () => {
                // Scheduled runs: deliver the final digest to the task's channel
                const freshRun = await agentOpsService.getRun(tenantId, runId);
                if (freshRun) await finalizeScheduledRun(freshRun);
            })
            .catch((err) => {
                console.error(`[ResumeEndpoint] Execution error for run ${runId}:`, err);
            });
```

- [ ] **Step 3: Verify** — tsc count unchanged and the touched suites still pass

```bash
cd apps/web-ui && bunx tsc --noEmit 2>&1 | grep -c "error TS"
cd apps/web-ui && bunx vitest run tests/agent-ops/scheduled-notifier.test.ts tests/agent-ops/scheduled-trigger.test.ts
```
Expected: count ≤ `TSC_BASELINE`; both suites PASS. (`finalizeScheduledRun` no-ops for non-scheduled sources, so channel-triggered runs through these routes are unaffected.)

- [ ] **Step 4: Commit**

```bash
git add "apps/web-ui/app/api/agent-ops/[runId]/approve/route.ts" "apps/web-ui/app/api/agent-ops/[runId]/resume/route.ts"
git commit -m "feat(agent-ops): deliver scheduled-run digest after dashboard approve/resume"
```

---

### Task 7: Worker re-sync — new tasks fire without a restart (TDD)

**Files:**
- Create: `apps/workers/src/jobs/agent-ops-scheduler/sync.ts`
- Test: `apps/workers/src/jobs/agent-ops-scheduler/sync.test.ts`
- Modify: `apps/workers/src/jobs/agent-ops-scheduler/index.ts`

**Interfaces:**
- Consumes: pg-boss (`createQueue`, `work`, `schedule`, `unschedule`), `JobExecutor.registerHandler`.
- Produces:
  - `interface ActiveTaskRow { taskId: string; tenantId: string; cronExpression: string; timezone: string }`
  - `interface RegisteredEntry { cronExpression: string; timezone: string }`
  - `diffScheduleSync(active: ActiveTaskRow[], registered: Map<string, RegisteredEntry>): { toAdd: ActiveTaskRow[]; toRemove: string[]; toUpdate: ActiveTaskRow[] }`
  - `register(boss, executor)` now performs an initial sync then re-syncs every 60s.

- [ ] **Step 1: Write the failing test** — `apps/workers/src/jobs/agent-ops-scheduler/sync.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { diffScheduleSync, type ActiveTaskRow, type RegisteredEntry } from './sync.js';

const row = (taskId: string, cron = '0 9 * * *', tz = 'UTC'): ActiveTaskRow => ({
    taskId, tenantId: 'tenant-1', cronExpression: cron, timezone: tz,
});
const entry = (cron = '0 9 * * *', tz = 'UTC'): RegisteredEntry => ({
    cronExpression: cron, timezone: tz,
});

describe('diffScheduleSync', () => {
    it('adds tasks not yet registered', () => {
        const diff = diffScheduleSync([row('a'), row('b')], new Map([['a', entry()]]));
        expect(diff.toAdd.map(t => t.taskId)).toEqual(['b']);
        expect(diff.toRemove).toEqual([]);
        expect(diff.toUpdate).toEqual([]);
    });

    it('removes registered tasks that are no longer active', () => {
        const diff = diffScheduleSync([row('a')], new Map([['a', entry()], ['gone', entry()]]));
        expect(diff.toRemove).toEqual(['gone']);
        expect(diff.toAdd).toEqual([]);
    });

    it('updates tasks whose cron expression changed', () => {
        const diff = diffScheduleSync([row('a', '0 10 * * *')], new Map([['a', entry('0 9 * * *')]]));
        expect(diff.toUpdate.map(t => t.taskId)).toEqual(['a']);
    });

    it('updates tasks whose timezone changed', () => {
        const diff = diffScheduleSync([row('a', '0 9 * * *', 'Asia/Kolkata')], new Map([['a', entry()]]));
        expect(diff.toUpdate.map(t => t.taskId)).toEqual(['a']);
    });

    it('reports nothing for an unchanged registration', () => {
        const diff = diffScheduleSync([row('a')], new Map([['a', entry()]]));
        expect(diff).toEqual({ toAdd: [], toRemove: [], toUpdate: [] });
    });

    it('handles empty inputs', () => {
        expect(diffScheduleSync([], new Map())).toEqual({ toAdd: [], toRemove: [], toUpdate: [] });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/workers && bunx vitest run src/jobs/agent-ops-scheduler/sync.test.ts
```
Expected: FAIL — `./sync.js` does not exist.

- [ ] **Step 3: Create `apps/workers/src/jobs/agent-ops-scheduler/sync.ts`**

```ts
// workers/src/jobs/agent-ops-scheduler/sync.ts
/**
 * Pure diff between the active ScheduledTask rows in the database and the
 * schedules this worker process has registered with pg-boss. Drives the
 * periodic re-sync so tasks created/paused/edited after worker startup take
 * effect without a restart.
 */

export interface ActiveTaskRow {
    taskId: string;
    tenantId: string;
    cronExpression: string;
    timezone: string;
}

export interface RegisteredEntry {
    cronExpression: string;
    timezone: string;
}

export interface ScheduleSyncDiff {
    toAdd: ActiveTaskRow[];
    toRemove: string[];
    toUpdate: ActiveTaskRow[];
}

export function diffScheduleSync(
    active: ActiveTaskRow[],
    registered: Map<string, RegisteredEntry>,
): ScheduleSyncDiff {
    const activeIds = new Set(active.map(t => t.taskId));

    const toAdd = active.filter(t => !registered.has(t.taskId));
    const toUpdate = active.filter(t => {
        const reg = registered.get(t.taskId);
        return reg !== undefined
            && (reg.cronExpression !== t.cronExpression || reg.timezone !== t.timezone);
    });
    const toRemove = Array.from(registered.keys()).filter(id => !activeIds.has(id));

    return { toAdd, toRemove, toUpdate };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/workers && bunx vitest run src/jobs/agent-ops-scheduler/sync.test.ts
```
Expected: PASS (6 tests).

- [ ] **Step 5: Rewire `apps/workers/src/jobs/agent-ops-scheduler/index.ts`**

Add import at the top (after the existing imports):
```ts
import { diffScheduleSync, type ActiveTaskRow, type RegisteredEntry } from './sync.js';
```
Replace `loadActiveTasks` (reuse one Prisma client instead of connect/disconnect per call) and the `register` function; add the sync machinery:
```ts
const SYNC_INTERVAL_MS = 60_000;

const registeredSchedules = new Map<string, RegisteredEntry>();
const startedConsumers = new Set<string>();

let _prisma: import('@prisma/client').PrismaClient | null = null;
async function getPrisma(): Promise<import('@prisma/client').PrismaClient> {
    if (!_prisma) {
        const { PrismaClient } = await import('@prisma/client');
        _prisma = new PrismaClient();
    }
    return _prisma;
}

async function loadActiveTasks(): Promise<ActiveTaskRow[]> {
    const prisma = await getPrisma();
    return prisma.scheduledTask.findMany({
        where: { taskStatus: 'active' },
        select: { taskId: true, tenantId: true, cronExpression: true, timezone: true },
    });
}

async function ensureTaskRegistered(boss: PgBoss, executor: JobExecutor, task: ActiveTaskRow): Promise<void> {
    const queue = queueName(task.taskId);
    await boss.createQueue(queue);

    // pg-boss allows one work() subscription per queue per process
    if (!startedConsumers.has(queue)) {
        executor.registerHandler?.(queue, handleAgentOpsTick);
        await boss.work(queue, { batchSize: 1 }, async (jobs: PgBoss.Job<TaskTickData>[]) => {
            for (const job of jobs) {
                await executor.execute(queue, job.data);
            }
        });
        startedConsumers.add(queue);
    }

    // schedule() upserts by queue name — safe for both add and update
    await boss.schedule(queue, task.cronExpression, {
        taskId: task.taskId,
        tenantId: task.tenantId,
    } satisfies TaskTickData, { tz: task.timezone });

    registeredSchedules.set(task.taskId, {
        cronExpression: task.cronExpression,
        timezone: task.timezone,
    });
}

export async function syncSchedules(boss: PgBoss, executor: JobExecutor): Promise<void> {
    const active = await loadActiveTasks();
    const diff = diffScheduleSync(active, registeredSchedules);

    for (const task of [...diff.toAdd, ...diff.toUpdate]) {
        try {
            await ensureTaskRegistered(boss, executor, task);
            log.info(`Registered schedule for task ${task.taskId} (${task.cronExpression} ${task.timezone})`);
        } catch (err) {
            log.error(`Failed to register task ${task.taskId}`, { error: String(err) });
        }
    }

    for (const taskId of diff.toRemove) {
        try {
            await boss.unschedule(queueName(taskId));
        } catch { /* schedule may not exist — safe to ignore */ }
        registeredSchedules.delete(taskId);
        log.info(`Unscheduled task ${taskId}`);
    }
}

export async function register(boss: PgBoss, executor: JobExecutor): Promise<void> {
    await syncSchedules(boss, executor);

    setInterval(() => {
        syncSchedules(boss, executor).catch(err =>
            log.error('Schedule re-sync failed', { error: String(err) }),
        );
    }, SYNC_INTERVAL_MS);

    log.info(`Registered ${registeredSchedules.size} agent-ops scheduled task(s); re-sync every ${SYNC_INTERVAL_MS / 1000}s`);
}
```
Delete the old `loadActiveTasks` and old `register` implementations. Keep `handleAgentOpsTick`, `writeAuditLog`, `queueName`, `TaskTickData` unchanged.

- [ ] **Step 6: Run the workers suite for this job + tsc**

```bash
cd apps/workers && bunx vitest run src/jobs/agent-ops-scheduler/
cd apps/workers && bunx tsc --noEmit 2>&1 | grep -c "error TS" || true
```
Expected: sync tests PASS; no **new** type errors in `agent-ops-scheduler` files.

- [ ] **Step 7: Commit**

```bash
git add apps/workers/src/jobs/agent-ops-scheduler/
git commit -m "feat(workers): periodic schedule re-sync so new agent-ops tasks fire without restart"
```

---

### Task 8: UI — Telegram notification option in the scheduled-task dialog

**Files:**
- Modify: `apps/web-ui/components/agent-ops/scheduled-task-dialog.tsx` (2-space indentation)

**Interfaces:**
- Consumes: `ScheduledTaskNotification.chatId` (Task 1). The POST/PATCH routes pass `body.notification` through unvalidated, so no API change is needed.
- Produces: users can pick "Telegram chat" and enter a chat ID; it round-trips through create + edit.

- [ ] **Step 1: Extend the form model**

In `DEFAULT_FORM` replace:
```ts
  notificationType: "none" as "none" | "slack" | "jira",
  channelId: "",
  channelName: "",
  issueKey: "",
```
with:
```ts
  notificationType: "none" as "none" | "slack" | "jira" | "telegram",
  channelId: "",
  channelName: "",
  chatId: "",
  issueKey: "",
```
In the edit-mode initializer (the `task ? { ... }` object) after `channelName:` add:
```ts
  chatId: task.notification.chatId || "",
```
In the `handleSave` body's `notification` object add a third spread:
```ts
  ...(form.notificationType === "telegram" && { chatId: form.chatId }),
```

- [ ] **Step 2: Extend the notification UI**

In the notification `<SelectContent>` add after the Slack item:
```tsx
  <SelectItem value="telegram">Telegram chat</SelectItem>
```
After the `{form.notificationType === "jira" && (...)}` block add:
```tsx
  {form.notificationType === "telegram" && (
    <div className="space-y-1.5">
      <Label className="text-xs">Telegram Chat ID</Label>
      <Input placeholder="-1001234567890" value={form.chatId} onChange={e => set("chatId", e.target.value)} />
      <p className="text-xs text-muted-foreground">Numeric chat ID the bot can post to (group IDs start with -100).</p>
    </div>
  )}
```

- [ ] **Step 3: Verify** — tsc count unchanged, lint clean on the file

```bash
cd apps/web-ui && bunx tsc --noEmit 2>&1 | grep -c "error TS"
cd apps/web-ui && bunx eslint components/agent-ops/scheduled-task-dialog.tsx
```
Expected: count ≤ `TSC_BASELINE`; no lint errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web-ui/components/agent-ops/scheduled-task-dialog.tsx
git commit -m "feat(agent-ops): Telegram notification target in scheduled-task dialog"
```

---

### Task 9: Docs + full verification sweep

**Files:**
- Modify: `docs/agent-ops/README.md` (Scheduling section + data-model row)

**Interfaces:**
- Consumes: everything above.
- Produces: documentation matching the shipped behavior; verified no-regression evidence.

- [ ] **Step 1: Update `docs/agent-ops/README.md`**

In the data-model table, change the `ScheduledTask` row's purpose text from
`` `notification` target (none\|slack\|jira) `` to
`` `notification` target (none\|slack\|telegram\|jira) ``.

Replace the `## Scheduling (cron)` section body with:
```markdown
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
```

- [ ] **Step 2: Full verification sweep**

```bash
cd apps/web-ui && bunx vitest run tests/agent-ops/ tests/gateway/
cd apps/workers && bunx vitest run
cd apps/web-ui && bunx tsc --noEmit 2>&1 | grep -c "error TS"
```
Expected: no failures beyond the pre-existing baseline set (compare failure names, not just counts, if in doubt); tsc count ≤ `TSC_BASELINE`.

- [ ] **Step 3: Commit**

```bash
git add docs/agent-ops/README.md
git commit -m "docs(agent-ops): scheduled-run delivery, lock, and worker re-sync"
```

---

## Spec coverage map

| Spec section | Task |
|---|---|
| 4.1 Types (`telegram`, `chatId`) | 1 |
| 4.2 Adapter contract (`ScheduledOutcome`, `sendScheduledNotification?`) | 1 |
| 4.3 Slack adapter | 3 |
| 4.3 Telegram adapter | 4 |
| 4.4 Notifier rewrite (outcome mapping, dispatch, never-throws) | 2 |
| 4.5 HIL loop close (approve/resume + `lastRunStatus`) | 2 (helper), 5–6 (wiring) |
| 4.6 Trigger-route lock | 5 |
| 4.7 Worker re-sync (`diffScheduleSync` + 60s loop) | 7 |
| 4.8 Dialog Telegram option | 8 |
| 6 Testing | 2, 3, 4, 5, 7, 9 |
| Docs | 9 |
