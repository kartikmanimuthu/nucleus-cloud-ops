// web-ui/tests/gateway/gateway-service.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
        closeTelegramSession: vi.fn().mockResolvedValue(undefined),
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

vi.mock('@/lib/agent/triage', () => ({
    triageChatMessage: vi.fn(),
    chatTriageEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock('@/lib/agent/model-resolver', () => ({
    resolveModelConfig: vi.fn().mockResolvedValue({ provider: 'bedrock', modelId: 'test-model' }),
    resolveDefaultModelConfig: vi.fn().mockResolvedValue({ provider: 'bedrock', modelId: 'test-model' }),
}));

vi.mock('@/lib/gateway/persona/direct-reply', () => ({ generateDirectReply: vi.fn() }));

function makeMockAdapter(overrides: Partial<ChannelAdapter> = {}): ChannelAdapter {
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
        sendSessionReset: vi.fn().mockResolvedValue(undefined),
        getConfig: vi.fn().mockResolvedValue({}),
        ...overrides,
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

    it('acks with 200 (not 400) when task description is empty on a streaming channel', async () => {
        // 'streaming' channels (Telegram, Discord) push updates async and retry
        // forever on a non-2xx — e.g. Telegram's automatic /start handshake has
        // no text. A 400 here would jam the whole channel behind an endless retry.
        (adapter as any).deliveryMode = 'streaming';
        (adapter.parseInbound as any).mockResolvedValue({
            channelType: 'slack', tenantId: 'tenant-1', taskDescription: '', channelMeta: {},
        });
        const req = new Request('http://localhost', { method: 'POST', body: 'text=' });
        const res = await service.handleInbound('slack', req as any);
        expect(res.status).toBe(200);
        expect(adapter.sendAck).not.toHaveBeenCalled();
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

    it('resets a conversation: closes the session run and confirms to the channel', async () => {
        (adapter.parseInbound as any).mockResolvedValue({
            channelType: 'slack', tenantId: 'tenant-1', taskDescription: '',
            channelMeta: { chatId: 67890 }, replyContext: { runId: 'run-1', action: 'reset', tenantId: 'tenant-1' },
        });
        const { agentOpsService } = await import('@/lib/agent-ops/agent-ops-service');
        const req = new Request('http://localhost', { method: 'POST', body: 'payload={}' });
        const res = await service.handleInbound('slack', req as any);
        expect(agentOpsService.closeTelegramSession).toHaveBeenCalledWith('tenant-1', 'run-1');
        expect(adapter.sendSessionReset).toHaveBeenCalledWith('tenant-1', 67890);
        expect(res.status).toBe(200);
    });
});

describe('GatewayService persona routing', () => {
    let service: GatewayService;
    let adapter: ChannelAdapter;
    let bus: GatewayEventBus;

    beforeEach(async () => {
        vi.clearAllMocks();
        process.env.CHATBOT_PERSONA_ENABLED = 'true';

        const { triageChatMessage, chatTriageEnabled } = await import('@/lib/agent/triage');
        const { resolveDefaultModelConfig } = await import('@/lib/agent/model-resolver');
        const { agentOpsService } = await import('@/lib/agent-ops/agent-ops-service');
        // clearAllMocks wipes implementations set at declaration time — restore them.
        vi.mocked(chatTriageEnabled).mockReturnValue(true);
        vi.mocked(resolveDefaultModelConfig).mockResolvedValue({ provider: 'bedrock', modelId: 'test-model' } as any);
        vi.mocked(triageChatMessage).mockResolvedValue({ route: 'task', skillId: null, reasoning: '' });
        vi.mocked(agentOpsService.createRun).mockResolvedValue({
            runId: 'run-1', tenantId: 'tenant-1', source: 'telegram',
            taskDescription: 'test', threadId: 'thread-1', trigger: {},
        } as any);

        bus = new GatewayEventBus();
        const registry = new AdapterRegistry();
        adapter = makeMockAdapter({
            channelType: 'telegram',
            deliveryMode: 'streaming',
            sendDirectReply: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
        });
        registry.register(adapter);
        service = new GatewayService(registry, bus, new NotificationRouter(bus, registry));
    });

    afterEach(() => {
        delete process.env.CHATBOT_PERSONA_ENABLED;
    });

    it('replies directly and never creates a run when triage classifies "direct"', async () => {
        const { triageChatMessage } = await import('@/lib/agent/triage');
        const { generateDirectReply } = await import('@/lib/gateway/persona/direct-reply');
        const { agentOpsService } = await import('@/lib/agent-ops/agent-ops-service');
        vi.mocked(triageChatMessage).mockResolvedValue({ route: 'direct', skillId: null, reasoning: 'greeting' });
        vi.mocked(generateDirectReply).mockResolvedValue('Hey! What can I help with?');

        const req = new Request('http://localhost/api/v1/gateway/telegram', { method: 'POST', body: '{}' });
        const res = await service.handleInbound('telegram', req as any);

        expect(adapter.sendDirectReply).toHaveBeenCalledWith(expect.anything(), 'Hey! What can I help with?');
        expect(agentOpsService.createRun).not.toHaveBeenCalled();
        expect(res.status).toBe(200);
    });

    it('falls through to the normal task path when triage classifies "task"', async () => {
        const { agentOpsService } = await import('@/lib/agent-ops/agent-ops-service');
        const req = new Request('http://localhost/api/v1/gateway/telegram', { method: 'POST', body: '{}' });
        const res = await service.handleInbound('telegram', req as any);

        expect(adapter.sendDirectReply).not.toHaveBeenCalled();
        expect(agentOpsService.createRun).toHaveBeenCalled();
        expect(res.status).toBe(200);
    });

    it('does not classify at all when the persona flag is off', async () => {
        delete process.env.CHATBOT_PERSONA_ENABLED;
        const { triageChatMessage } = await import('@/lib/agent/triage');
        const { resolveDefaultModelConfig } = await import('@/lib/agent/model-resolver');
        const { agentOpsService } = await import('@/lib/agent-ops/agent-ops-service');

        const req = new Request('http://localhost/api/v1/gateway/telegram', { method: 'POST', body: '{}' });
        await service.handleInbound('telegram', req as any);

        expect(triageChatMessage).not.toHaveBeenCalled();
        // Pins "provably zero cost when the flag is off": model resolution hits
        // the DB, so it must not run before the flag check.
        expect(resolveDefaultModelConfig).not.toHaveBeenCalled();
        expect(agentOpsService.createRun).toHaveBeenCalled();
    });

    it('does not classify when chat triage is globally disabled', async () => {
        const { triageChatMessage, chatTriageEnabled } = await import('@/lib/agent/triage');
        const { agentOpsService } = await import('@/lib/agent-ops/agent-ops-service');
        vi.mocked(chatTriageEnabled).mockReturnValue(false);

        const req = new Request('http://localhost/api/v1/gateway/telegram', { method: 'POST', body: '{}' });
        await service.handleInbound('telegram', req as any);

        expect(triageChatMessage).not.toHaveBeenCalled();
        expect(agentOpsService.createRun).toHaveBeenCalled();
    });

    it('does not classify for a channel outside the allowlist', async () => {
        const { triageChatMessage } = await import('@/lib/agent/triage');
        const { agentOpsService } = await import('@/lib/agent-ops/agent-ops-service');
        const registry = new AdapterRegistry();
        const slackAdapter = makeMockAdapter({
            sendDirectReply: vi.fn().mockResolvedValue(new Response('{}', { status: 200 })),
        });
        registry.register(slackAdapter);
        service = new GatewayService(registry, bus, new NotificationRouter(bus, registry));

        const req = new Request('http://localhost/api/v1/gateway/slack', { method: 'POST', body: 'text=hi' });
        await service.handleInbound('slack', req as any);

        expect(triageChatMessage).not.toHaveBeenCalled();
        expect(agentOpsService.createRun).toHaveBeenCalled();
    });

    it('falls through to the task path when the adapter lacks sendDirectReply', async () => {
        const { triageChatMessage } = await import('@/lib/agent/triage');
        const { agentOpsService } = await import('@/lib/agent-ops/agent-ops-service');
        vi.mocked(triageChatMessage).mockResolvedValue({ route: 'direct', skillId: null, reasoning: 'greeting' });

        const registry = new AdapterRegistry();
        registry.register(makeMockAdapter({ channelType: 'telegram', deliveryMode: 'streaming' }));
        service = new GatewayService(registry, bus, new NotificationRouter(bus, registry));

        const req = new Request('http://localhost/api/v1/gateway/telegram', { method: 'POST', body: '{}' });
        await service.handleInbound('telegram', req as any);

        // Asserting the classifier never ran is what actually pins the
        // `adapter.sendDirectReply` guard: without it the fail-open catch would
        // swallow the resulting TypeError and createRun would still be called.
        expect(triageChatMessage).not.toHaveBeenCalled();
        expect(agentOpsService.createRun).toHaveBeenCalled();
    });

    it('fails open to the task path when model resolution throws', async () => {
        const { resolveDefaultModelConfig } = await import('@/lib/agent/model-resolver');
        const { triageChatMessage } = await import('@/lib/agent/triage');
        const { agentOpsService } = await import('@/lib/agent-ops/agent-ops-service');
        vi.mocked(resolveDefaultModelConfig).mockRejectedValue(new Error('no provider configured'));

        const req = new Request('http://localhost/api/v1/gateway/telegram', { method: 'POST', body: '{}' });
        const res = await service.handleInbound('telegram', req as any);

        expect(triageChatMessage).not.toHaveBeenCalled();
        expect(agentOpsService.createRun).toHaveBeenCalled();
        expect(res.status).toBe(200);
    });

    it('fails open to the task path when the classifier throws', async () => {
        const { triageChatMessage } = await import('@/lib/agent/triage');
        const { agentOpsService } = await import('@/lib/agent-ops/agent-ops-service');
        vi.mocked(triageChatMessage).mockRejectedValue(new Error('throttled'));

        const req = new Request('http://localhost/api/v1/gateway/telegram', { method: 'POST', body: '{}' });
        await service.handleInbound('telegram', req as any);

        expect(agentOpsService.createRun).toHaveBeenCalled();
    });

    it('still routes an awaiting-clarification reply to handleResume, never to the classifier', async () => {
        const { triageChatMessage } = await import('@/lib/agent/triage');
        const { agentOpsService } = await import('@/lib/agent-ops/agent-ops-service');
        vi.mocked(agentOpsService.getRun).mockResolvedValue({
            runId: 'run-1', tenantId: 'tenant-1', source: 'telegram',
            status: 'awaiting_input', taskDescription: 'test', trigger: {},
        } as any);
        (adapter.parseInbound as any).mockResolvedValue({
            channelType: 'telegram', tenantId: 'tenant-1', taskDescription: 'hi', channelMeta: {},
            replyContext: { runId: 'run-1', action: 'clarification_response', content: 'hi', tenantId: 'tenant-1' },
        });

        const req = new Request('http://localhost/api/v1/gateway/telegram', { method: 'POST', body: '{}' });
        const res = await service.handleInbound('telegram', req as any);

        expect(triageChatMessage).not.toHaveBeenCalled();
        expect(res.status).toBe(200);
    });

    it('fails open to the task path when the direct-reply generator throws (empty model output)', async () => {
        const { triageChatMessage } = await import('@/lib/agent/triage');
        const { generateDirectReply } = await import('@/lib/gateway/persona/direct-reply');
        const { agentOpsService } = await import('@/lib/agent-ops/agent-ops-service');
        vi.mocked(triageChatMessage).mockResolvedValue({ route: 'direct', skillId: null, reasoning: 'greeting' });
        vi.mocked(generateDirectReply).mockRejectedValue(new Error('Direct reply model returned empty content'));

        const req = new Request('http://localhost/api/v1/gateway/telegram', { method: 'POST', body: '{}' });
        const res = await service.handleInbound('telegram', req as any);

        expect(agentOpsService.createRun).toHaveBeenCalled();
        expect(res.status).toBe(200);
    });

    it('falls through to a real run when sendDirectReply reports non-delivery (null)', async () => {
        const { triageChatMessage } = await import('@/lib/agent/triage');
        const { generateDirectReply } = await import('@/lib/gateway/persona/direct-reply');
        const { agentOpsService } = await import('@/lib/agent-ops/agent-ops-service');
        vi.mocked(triageChatMessage).mockResolvedValue({ route: 'direct', skillId: null, reasoning: 'greeting' });
        vi.mocked(generateDirectReply).mockResolvedValue('hi there');
        (adapter.sendDirectReply as any).mockResolvedValue(null);

        const req = new Request('http://localhost/api/v1/gateway/telegram', { method: 'POST', body: '{}' });
        const res = await service.handleInbound('telegram', req as any);

        expect(adapter.sendDirectReply).toHaveBeenCalled();
        expect(agentOpsService.createRun).toHaveBeenCalled();
        expect(res.status).toBe(200);
    });

    it('fails open to the task path when sendDirectReply rejects', async () => {
        const { triageChatMessage } = await import('@/lib/agent/triage');
        const { generateDirectReply } = await import('@/lib/gateway/persona/direct-reply');
        const { agentOpsService } = await import('@/lib/agent-ops/agent-ops-service');
        vi.mocked(triageChatMessage).mockResolvedValue({ route: 'direct', skillId: null, reasoning: 'greeting' });
        vi.mocked(generateDirectReply).mockResolvedValue('hi there');
        (adapter.sendDirectReply as any).mockRejectedValue(new Error('telegram 429'));

        const req = new Request('http://localhost/api/v1/gateway/telegram', { method: 'POST', body: '{}' });
        const res = await service.handleInbound('telegram', req as any);

        expect(agentOpsService.createRun).toHaveBeenCalled();
        expect(res.status).toBe(200);
    });
});
