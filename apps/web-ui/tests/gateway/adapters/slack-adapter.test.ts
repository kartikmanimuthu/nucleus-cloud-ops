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

    it('resolves team_id from the interaction payload when the body has no top-level team_id', async () => {
        const body = `payload=${encodeURIComponent(JSON.stringify({ team: { id: 'T-FROM-PAYLOAD' } }))}`;
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const signature = `v0=${crypto
            .createHmac('sha256', 'test-secret')
            .update(`v0:${timestamp}:${body}`)
            .digest('hex')}`;
        const req = new Request('http://localhost/api/v1/gateway/slack', {
            method: 'POST',
            headers: { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': signature },
            body,
        });
        const result = await adapter.validateRequest(req as any);
        expect(result).toBe(true);
        expect(vi.mocked(getSlackWorkspaceLinkRepository)().findTenantIdByTeamId).toHaveBeenCalledWith('T-FROM-PAYLOAD');
    });

    it('returns false when the signing-secret config lookup throws', async () => {
        vi.mocked(TenantConfigService.getConfig).mockRejectedValueOnce(new Error('db down'));
        const body = 'text=hello&team_id=T789';
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const req = new Request('http://localhost/api/v1/gateway/slack', {
            method: 'POST',
            headers: { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': 'v0=irrelevant' },
            body,
        });
        expect(await adapter.validateRequest(req as any)).toBe(false);
    });

    it('rejects a request whose timestamp is older than 5 minutes', async () => {
        const body = 'text=hello&team_id=T789';
        const staleTimestamp = (Math.floor(Date.now() / 1000) - 10 * 60).toString();
        const signature = `v0=${crypto
            .createHmac('sha256', 'test-secret')
            .update(`v0:${staleTimestamp}:${body}`)
            .digest('hex')}`;
        const req = new Request('http://localhost/api/v1/gateway/slack', {
            method: 'POST',
            headers: { 'x-slack-request-timestamp': staleTimestamp, 'x-slack-signature': signature },
            body,
        });
        expect(await adapter.validateRequest(req as any)).toBe(false);
    });

    it('returns false (not throw) when the signature has a different byte length than expected', async () => {
        const body = 'text=hello&team_id=T789';
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const req = new Request('http://localhost/api/v1/gateway/slack', {
            method: 'POST',
            headers: { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': 'v0=ab' },
            body,
        });
        expect(await adapter.validateRequest(req as any)).toBe(false);
    });

    it('parseInbound resolves a threaded-reply replyContext via findAwaitingRunBySlackThread', async () => {
        const { agentOpsService } = await import('@/lib/agent-ops/agent-ops-service');
        vi.mocked(agentOpsService.findAwaitingRunBySlackThread).mockResolvedValueOnce({
            runId: 'run-await-1', tenantId: 'tenant-1',
        } as any);
        const body = 'text=the+account+is+123&user_id=U1&channel_id=C1&team_id=T789&thread_ts=111.222';
        const req = new Request('http://localhost/api/v1/gateway/slack', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body,
        });
        const msg = await adapter.parseInbound(req as any);
        expect(msg.replyContext).toEqual({
            runId: 'run-await-1', action: 'clarification_response',
            content: 'the account is 123', tenantId: 'tenant-1',
        });
    });

    it('parseInbound detects a reject button interaction as ReplyContext', async () => {
        const interactionPayload = JSON.stringify({
            type: 'block_actions',
            actions: [{ action_id: 'agent_ops_reject', value: 'run-1|tenant-1' }],
            channel: { id: 'C456' },
        });
        const body = `payload=${encodeURIComponent(interactionPayload)}`;
        const req = new Request('http://localhost/api/v1/gateway/slack', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body,
        });
        const msg = await adapter.parseInbound(req as any);
        expect(msg.replyContext?.action).toBe('reject');
    });

    it('getConfig returns the raw tenant config', async () => {
        const config = await adapter.getConfig!('tenant-1');
        expect(config).toMatchObject({ botToken: 'xoxb-test-token' });
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

    // sendScheduledNotification THROWS on missing config or a failed Slack API
    // call by design (see the doc comment on the method) — the caller,
    // notifyScheduledRunResult() in scheduled-notifier.ts, wraps every adapter
    // call in try/catch and records the thrown message as a failure event on
    // the run rather than the digest silently vanishing.

    it('throws a descriptive error without a channelId', async () => {
        const noDest = { ...task, notification: { type: 'slack' } } as unknown as ScheduledTask;
        await expect(adapter.sendScheduledNotification!(noDest, run, 'result')).rejects.toThrow(
            'No Slack channelId configured on the task notification'
        );
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('throws a descriptive error without a botToken', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        await expect(adapter.sendScheduledNotification!(task, run, 'result')).rejects.toThrow(
            'No Slack Bot Token configured — set it under Channels → Slack'
        );
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('propagates a rejected fetch call to the caller', async () => {
        vi.mocked(global.fetch).mockRejectedValue(new Error('network down'));
        await expect(adapter.sendScheduledNotification!(task, run, 'result')).rejects.toThrow('network down');
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

    it('catches and logs a network failure during narration', async () => {
        global.fetch = vi.fn().mockRejectedValue(new Error('network down'));
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        await adapter.sendStreamChunk!(run, { eventType: 'tool_call', node: 'agent', toolName: 'execute_command' } as any);

        expect(errSpy).toHaveBeenCalledWith('[SlackAdapter] sendStreamChunk error:', expect.any(Error));
    });

    it('does nothing when the run has no channelId on its trigger', async () => {
        await adapter.sendStreamChunk!({ ...run, trigger: {} } as any, { eventType: 'tool_call', node: 'agent', toolName: 'x' } as any);
        expect(global.fetch).not.toHaveBeenCalled();
    });
});

describe('sendError / sendClarification (postToSlackThreadOrWebhook)', () => {
    let adapter: SlackAdapter;

    beforeEach(() => {
        adapter = new SlackAdapter();
        (adapter as any).narration = new NarrationSessions(0);
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ botToken: 'xoxb-test-token', signingSecret: 's' } as any);
    });

    it('sendError posts to the thread when threadTs, channelId, and a bot token are all present', async () => {
        global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
        const run = {
            runId: 'run-1', tenantId: 'tenant-1', source: 'slack', taskDescription: 'x',
            trigger: { channelId: 'C1', userId: 'U1', threadTs: '111.222', responseUrl: 'https://hooks.slack.com/x' },
        } as any;

        await adapter.sendError(run, 'Something broke');

        expect(global.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = vi.mocked(global.fetch).mock.calls[0];
        expect(url).toBe('https://slack.com/api/chat.postMessage');
        const body = JSON.parse((init as RequestInit).body as string);
        expect(body.text).toContain('Something broke');
        expect(body.thread_ts).toBe('111.222');
    });

    it('sendClarification falls back to the response_url webhook when there is no thread to reply in', async () => {
        global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
        const run = {
            runId: 'run-1', tenantId: 'tenant-1', source: 'slack', taskDescription: 'x',
            trigger: { channelId: 'C1', userId: 'U1', responseUrl: 'https://hooks.slack.com/reply' },
        } as any;

        await adapter.sendClarification(run, 'Which AWS account?');

        const [url, init] = vi.mocked(global.fetch).mock.calls[0];
        expect(url).toBe('https://hooks.slack.com/reply');
        const body = JSON.parse((init as RequestInit).body as string);
        expect(body.text).toContain('Which AWS account?');
        expect(body.response_type).toBe('in_channel');
    });

    it('falls back to the webhook when the threaded post is rejected by Slack', async () => {
        global.fetch = vi.fn()
            .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: false, error: 'not_in_channel' }) })
            .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
        const run = {
            runId: 'run-1', tenantId: 'tenant-1', source: 'slack', taskDescription: 'x',
            trigger: { channelId: 'C1', userId: 'U1', threadTs: '111.222', responseUrl: 'https://hooks.slack.com/fallback' },
        } as any;

        await adapter.sendError(run, 'boom');

        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(vi.mocked(global.fetch).mock.calls[1][0]).toBe('https://hooks.slack.com/fallback');
    });

    it('catches and logs when posting to Slack throws', async () => {
        global.fetch = vi.fn().mockRejectedValue(new Error('network down'));
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const run = {
            runId: 'run-1', tenantId: 'tenant-1', source: 'slack', taskDescription: 'x',
            trigger: { channelId: 'C1', userId: 'U1', threadTs: '1', responseUrl: 'https://hooks.slack.com/x' },
        } as any;

        await adapter.sendError(run, 'boom');

        expect(errSpy).toHaveBeenCalledWith('[SlackAdapter] Failed to post to Slack:', expect.any(Error));
    });

    it('treats a signing-config lookup failure as unconfigured (loadConfig swallows the error)', async () => {
        vi.mocked(TenantConfigService.getConfig).mockRejectedValueOnce(new Error('db down'));
        global.fetch = vi.fn();
        const run = {
            runId: 'run-1', tenantId: 'tenant-1', source: 'slack', taskDescription: 'x',
            trigger: { channelId: 'C1', userId: 'U1', threadTs: '1' }, // no responseUrl → nothing to fall back to
        } as any;

        await adapter.sendError(run, 'boom');

        expect(global.fetch).not.toHaveBeenCalled();
    });
});

describe('sendApprovalRequest', () => {
    let adapter: SlackAdapter;
    const run = {
        runId: 'run-1', tenantId: 'tenant-1', source: 'slack', taskDescription: 'Stop the idle instance',
        trigger: { channelId: 'C1', userId: 'U1', threadTs: '1' },
    } as any;

    beforeEach(() => {
        adapter = new SlackAdapter();
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ botToken: 'xoxb-test-token' } as any);
    });

    it('warns and returns without posting when the trigger has no channelId', async () => {
        global.fetch = vi.fn();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await adapter.sendApprovalRequest({ ...run, trigger: {} } as any, ['Step 1']);

        expect(global.fetch).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith('[SlackAdapter] sendApprovalRequest: no channelId on trigger');
    });

    it('warns and returns without posting when no bot token is configured', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValueOnce(null as any);
        global.fetch = vi.fn();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await adapter.sendApprovalRequest(run, ['Step 1']);

        expect(global.fetch).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith('[SlackAdapter] sendApprovalRequest: no botToken configured');
    });

    it('posts the approval Block Kit message and persists the message ts on success', async () => {
        const { agentOpsService } = await import('@/lib/agent-ops/agent-ops-service');
        global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, ts: '999.111' }) });

        await adapter.sendApprovalRequest(run, ['Stop instance'], ['stop_instance']);

        const [, init] = vi.mocked(global.fetch).mock.calls[0];
        const body = JSON.parse((init as RequestInit).body as string);
        expect(body.blocks[0].text.text).toContain('stop_instance');
        expect(agentOpsService.updateApprovalMessageTs).toHaveBeenCalledWith('tenant-1', 'run-1', '999.111');
    });

    it('logs a warning when persisting the approval message ts fails', async () => {
        const { agentOpsService } = await import('@/lib/agent-ops/agent-ops-service');
        vi.mocked(agentOpsService.updateApprovalMessageTs).mockRejectedValueOnce(new Error('write failed'));
        global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, ts: '999.111' }) });
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await adapter.sendApprovalRequest(run, ['Stop instance']);

        expect(warnSpy).toHaveBeenCalledWith('[SlackAdapter] Failed to persist approval message ts:', expect.any(Error));
    });

    it('warns when Slack rejects the Block Kit post', async () => {
        global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: false, error: 'channel_not_found' }) });
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await adapter.sendApprovalRequest(run, ['Stop instance']);

        expect(warnSpy).toHaveBeenCalledWith('[SlackAdapter] Block Kit post failed:', 'channel_not_found');
    });

    it('catches and logs when the post itself throws', async () => {
        global.fetch = vi.fn().mockRejectedValue(new Error('network down'));
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        await adapter.sendApprovalRequest(run, ['Stop instance']);

        expect(errSpy).toHaveBeenCalledWith('[SlackAdapter] sendApprovalRequest error:', expect.any(Error));
    });
});

describe('sendScheduledNotification — remaining branches', () => {
    let adapter: SlackAdapter;
    const task = {
        taskId: 'task-1', tenantId: 'tenant-1', name: 'Daily Cost Review',
        notification: { type: 'slack', channelId: 'C0SCHED' },
    } as unknown as ScheduledTask;
    const run = {
        runId: 'run-1', tenantId: 'tenant-1', source: 'scheduled', status: 'completed', durationMs: 1000,
        trigger: { taskId: 'task-1', taskName: 'Daily Cost Review', scheduledAt: '2026-07-05T00:00:00Z' },
        result: { summary: 'ok', toolsUsed: [], iterations: 1 },
    } as unknown as AgentOpsRun;

    beforeEach(() => {
        adapter = new SlackAdapter();
    });

    it('throws when the Slack integration is explicitly deactivated', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValueOnce({ botToken: 'x', enabled: false } as any);
        await expect(adapter.sendScheduledNotification!(task, run, 'result')).rejects.toThrow(
            'Slack integration is deactivated — activate it under Channels → Slack'
        );
    });

    it('throws a descriptive error including the parsed Slack error when the post is rejected', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValueOnce({ botToken: 'xoxb-1', enabled: true } as any);
        global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }), { status: 200 }));

        await expect(adapter.sendScheduledNotification!(task, run, 'result')).rejects.toThrow(
            'Slack chat.postMessage failed: channel_not_found'
        );
    });

    it('falls back to the HTTP status when the failed response body is not parseable JSON', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValueOnce({ botToken: 'xoxb-1', enabled: true } as any);
        global.fetch = vi.fn().mockResolvedValue({ status: 500, ok: false, json: async () => { throw new Error('bad json'); } });

        await expect(adapter.sendScheduledNotification!(task, run, 'result')).rejects.toThrow(
            'Slack chat.postMessage failed: HTTP 500'
        );
    });
});
