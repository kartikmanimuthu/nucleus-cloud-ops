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
        getRun: vi.fn().mockResolvedValue({
            runId: 'run-1', tenantId: 'tenant-1', source: 'slack',
            status: 'awaiting_input', taskDescription: 'test', trigger: {},
            clarification: { question: 'Which account?', missingInfo: 'account' },
        }),
        updateRunStatus: vi.fn().mockResolvedValue(undefined),
        recordEvent: vi.fn().mockResolvedValue(undefined),
        findAwaitingApprovalRun: vi.fn().mockResolvedValue({
            runId: 'run-1', tenantId: 'tenant-1', source: 'slack',
            status: 'awaiting_approval', taskDescription: 'test', trigger: {},
        }),
    },
}));

vi.mock('@/lib/agent-ops/agent-executor', () => ({
    executeAgentRun: vi.fn().mockResolvedValue(undefined),
    resumeApprovedRun: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/audit-service', () => ({
    AuditService: {
        logResourceAction: vi.fn().mockResolvedValue(undefined),
    },
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
        vi.clearAllMocks();
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

    it('returns 400 when task description is empty', async () => {
        (adapter.parseInbound as any).mockResolvedValue({
            channelType: 'slack', tenantId: 'tenant-1', taskDescription: '', channelMeta: {},
        });
        const req = new Request('http://localhost', { method: 'POST', body: 'text=' });
        const res = await service.handleInbound('slack', req as any);
        expect(res.status).toBe(400);
    });

    it('routes HIL resume when replyContext is present (approve)', async () => {
        (adapter.parseInbound as any).mockResolvedValue({
            channelType: 'slack', tenantId: 'tenant-1', taskDescription: '',
            channelMeta: {}, replyContext: { runId: 'run-1', action: 'approve', tenantId: 'tenant-1' },
        });
        const { resumeApprovedRun } = await import('@/lib/agent-ops/agent-executor');
        const req = new Request('http://localhost', { method: 'POST', body: 'payload={}' });
        const res = await service.handleInbound('slack', req as any);
        await new Promise(r => setTimeout(r, 50));
        expect(resumeApprovedRun).toHaveBeenCalled();
        expect(res.status).toBe(200);
    });

    it('routes HIL resume when replyContext is present (reject)', async () => {
        (adapter.parseInbound as any).mockResolvedValue({
            channelType: 'slack', tenantId: 'tenant-1', taskDescription: '',
            channelMeta: {}, replyContext: { runId: 'run-1', action: 'reject', tenantId: 'tenant-1' },
        });
        const { agentOpsService } = await import('@/lib/agent-ops/agent-ops-service');
        const req = new Request('http://localhost', { method: 'POST', body: 'payload={}' });
        const res = await service.handleInbound('slack', req as any);
        expect(agentOpsService.updateRunStatus).toHaveBeenCalledWith('tenant-1', 'run-1', 'cancelled');
        expect(res.status).toBe(200);
    });

    it('routes HIL resume for clarification_response', async () => {
        (adapter.parseInbound as any).mockResolvedValue({
            channelType: 'slack', tenantId: 'tenant-1', taskDescription: '',
            channelMeta: {}, replyContext: { runId: 'run-1', action: 'clarification_response', content: 'Use us-east-1', tenantId: 'tenant-1' },
        });
        const { executeAgentRun } = await import('@/lib/agent-ops/agent-executor');
        const req = new Request('http://localhost', { method: 'POST', body: 'payload={}' });
        const res = await service.handleInbound('slack', req as any);
        await new Promise(r => setTimeout(r, 50));
        expect(executeAgentRun).toHaveBeenCalled();
        expect(res.status).toBe(200);
    });
});
