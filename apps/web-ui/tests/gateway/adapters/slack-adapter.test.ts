import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'crypto';
import { SlackAdapter } from '@/lib/gateway/adapters/slack-adapter';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { getSlackWorkspaceLinkRepository } from '@/lib/db/repository-factory';
import type { ScheduledTask, AgentOpsRun } from '@/lib/agent-ops/types';
import { NarrationSessions } from '@/lib/gateway/narration/narration-session';

vi.mock('@/lib/tenant-config-service', () => ({
    TenantConfigService: {
        getConfig: vi.fn().mockResolvedValue({
            signingSecret: 'test-secret',
            botToken: 'xoxb-test-token',
            enabled: true,
        }),
    },
}));

vi.mock('@/lib/agent-ops/agent-ops-service', () => ({
    agentOpsService: {
        findAwaitingRunBySlackThread: vi.fn().mockResolvedValue(null),
        updateApprovalMessageTs: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('@/lib/agent/model-resolver', () => ({
    resolveModelConfig: vi.fn().mockResolvedValue({ provider: 'bedrock', modelId: 'test-model' }),
    resolveDefaultModelConfig: vi.fn().mockResolvedValue({ provider: 'bedrock', modelId: 'test-model' }),
}));
vi.mock('@/lib/gateway/narration/translate-event', () => ({
    translateEventWithFallback: vi.fn().mockResolvedValue({ active: 'Running an AWS CLI command...', done: 'Ran an AWS CLI command' }),
}));

// team_id (Slack's workspace id) must be translated to our internal tenantId
// via SlackWorkspaceLink — it is never usable as a tenantId directly.
vi.mock('@/lib/db/repository-factory', () => ({
    getSlackWorkspaceLinkRepository: vi.fn().mockReturnValue({
        findTenantIdByTeamId: vi.fn().mockResolvedValue('tenant-1'),
        upsertLink: vi.fn().mockResolvedValue(undefined),
        getLinkForTenant: vi.fn().mockResolvedValue(null),
    }),
}));

describe('SlackAdapter', () => {
    let adapter: SlackAdapter;

    beforeEach(() => {
        adapter = new SlackAdapter();
        vi.mocked(getSlackWorkspaceLinkRepository).mockReturnValue({
            findTenantIdByTeamId: vi.fn().mockResolvedValue('tenant-1'),
            upsertLink: vi.fn().mockResolvedValue(undefined),
            getLinkForTenant: vi.fn().mockResolvedValue(null),
        } as any);
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

    it('rejects requests when team_id has no linked tenant, even with a correct signature', async () => {
        vi.mocked(getSlackWorkspaceLinkRepository).mockReturnValue({
            findTenantIdByTeamId: vi.fn().mockResolvedValue(null),
            upsertLink: vi.fn().mockResolvedValue(undefined),
            getLinkForTenant: vi.fn().mockResolvedValue(null),
        } as any);
        const body = 'text=hello&team_id=T-UNLINKED';
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const req = new Request('http://localhost/api/v1/gateway/slack', {
            method: 'POST',
            headers: {
                'x-slack-request-timestamp': timestamp,
                'x-slack-signature': 'v0=irrelevant-secret-is-empty',
            },
            body,
        });
        const result = await adapter.validateRequest(req as any);
        expect(result).toBe(false);
    });

    it('resolves the signing secret via SlackWorkspaceLink and accepts a valid signature', async () => {
        const body = 'text=hello&team_id=T789';
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const signature = `v0=${crypto
            .createHmac('sha256', 'test-secret')
            .update(`v0:${timestamp}:${body}`)
            .digest('hex')}`;
        const req = new Request('http://localhost/api/v1/gateway/slack', {
            method: 'POST',
            headers: {
                'x-slack-request-timestamp': timestamp,
                'x-slack-signature': signature,
            },
            body,
        });
        const result = await adapter.validateRequest(req as any);
        expect(result).toBe(true);
        expect(TenantConfigService.getConfig).toHaveBeenCalledWith('agent-ops-slack', 'tenant-1');
    });

    it('parseInbound resolves the internal tenantId from team_id via SlackWorkspaceLink', async () => {
        const body = 'text=check+lambdas&user_id=U123&channel_id=C456&response_url=https%3A%2F%2Fhooks.slack.com%2Ftest&team_id=T789&user_name=kartik&channel_name=general';
        const req = new Request('http://localhost/api/v1/gateway/slack', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body,
        });
        const msg = await adapter.parseInbound(req as any);
        expect(msg.channelType).toBe('slack');
        expect(msg.taskDescription).toBe('check lambdas');
        // NOT 'T789' — that's Slack's team_id, not our tenantId
        expect(msg.tenantId).toBe('tenant-1');
        expect(msg.channelMeta).toMatchObject({
            userId: 'U123',
            channelId: 'C456',
            teamId: 'T789',
        });
    });

    it('parseInbound falls back to the raw team_id when no SlackWorkspaceLink exists', async () => {
        vi.mocked(getSlackWorkspaceLinkRepository).mockReturnValue({
            findTenantIdByTeamId: vi.fn().mockResolvedValue(null),
            upsertLink: vi.fn().mockResolvedValue(undefined),
            getLinkForTenant: vi.fn().mockResolvedValue(null),
        } as any);
        const body = 'text=hello&user_id=U123&channel_id=C456&team_id=T999';
        const req = new Request('http://localhost/api/v1/gateway/slack', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body,
        });
        const msg = await adapter.parseInbound(req as any);
        expect(msg.tenantId).toBe('T999');
    });

    it('parseInbound detects interaction payload as ReplyContext', async () => {
        const interactionPayload = JSON.stringify({
            type: 'block_actions',
            actions: [{ action_id: 'agent_ops_approve', value: 'run-1|tenant-1' }],
            channel: { id: 'C456' },
            message: { ts: '123.456' },
            response_url: 'https://hooks.slack.com/test',
        });
        const body = `payload=${encodeURIComponent(interactionPayload)}`;
        const req = new Request('http://localhost/api/v1/gateway/slack', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body,
        });
        const msg = await adapter.parseInbound(req as any);
        expect(msg.replyContext).toEqual({
            runId: 'run-1',
            action: 'approve',
            tenantId: 'tenant-1',
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

describe('sendStreamChunk narration', () => {
    let adapter: SlackAdapter;

    const run = {
        runId: 'run-1', tenantId: 'tenant-1', source: 'slack', taskDescription: 'test',
        trigger: { channelId: 'C456', userId: 'U123', responseUrl: 'https://hooks.slack.com/test' },
    } as any;

    beforeEach(() => {
        adapter = new SlackAdapter();
        (adapter as any).narration = new NarrationSessions(0);
        global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, channel: 'C456', ts: '111.222' }) });
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ botToken: 'slack-bot-token', signingSecret: 'secret' } as any);
    });

    it('does nothing when the tenant has no Slack bot token configured', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null as any);
        await adapter.sendStreamChunk!(run, { eventType: 'tool_call', node: 'agent', toolName: 'execute_command' } as any);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('ignores event types that are not step boundaries', async () => {
        await adapter.sendStreamChunk!(run, { eventType: 'memory_save', node: 'memory_save' } as any);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('posts a new message on the first step, then updates it on later steps', async () => {
        await adapter.sendStreamChunk!(run, { eventType: 'tool_call', node: 'agent', toolName: 'execute_command' } as any);
        expect(vi.mocked(global.fetch).mock.calls[0][0]).toBe('https://slack.com/api/chat.postMessage');

        vi.mocked(global.fetch).mockClear();

        await adapter.sendStreamChunk!(run, { eventType: 'tool_result', node: 'agent', toolName: 'execute_command' } as any);
        const [url, init] = vi.mocked(global.fetch).mock.calls[0];
        expect(url).toBe('https://slack.com/api/chat.update');
        const body = JSON.parse(init!.body as string);
        expect(body.ts).toBe('111.222');
        expect(body.text).toContain('✅');
    });

    it('retries a fresh postMessage when the first post was rejected by Slack', async () => {
        vi.mocked(global.fetch).mockResolvedValue({ ok: true, json: async () => ({ ok: false, error: 'not_in_channel' }) } as any);
        await adapter.sendStreamChunk!(run, { eventType: 'tool_call', node: 'agent', toolName: 'execute_command' } as any);
        vi.mocked(global.fetch).mockClear();

        await adapter.sendStreamChunk!(run, { eventType: 'tool_call', node: 'agent', toolName: 'read_file' } as any);
        expect(vi.mocked(global.fetch).mock.calls[0][0]).toBe('https://slack.com/api/chat.postMessage');
    });

    it('stops narrating once the run has delivered its result', async () => {
        await adapter.sendStreamChunk!(run, { eventType: 'tool_call', node: 'agent', toolName: 'execute_command' } as any);
        await adapter.sendResult({ ...run, result: { summary: 'done' } } as any, []);
        vi.mocked(global.fetch).mockClear();

        await adapter.sendStreamChunk!(run, { eventType: 'tool_call', node: 'agent', toolName: 'read_file' } as any);
        expect(global.fetch).not.toHaveBeenCalled();
    });
});
