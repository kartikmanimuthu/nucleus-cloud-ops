// web-ui/tests/gateway/notification-router.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationRouter } from '@/lib/gateway/notification-router';
import { GatewayEventBus } from '@/lib/gateway/event-bus';
import { AdapterRegistry } from '@/lib/gateway/adapter-registry';
import type { ChannelAdapter, GatewayEvent } from '@/lib/gateway/types';
import type { AgentOpsRun } from '@/lib/agent-ops/types';

vi.mock('@/lib/agent-ops/agent-ops-service', () => ({
    agentOpsService: {
        getRunEvents: vi.fn().mockResolvedValue([]),
    },
}));

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
