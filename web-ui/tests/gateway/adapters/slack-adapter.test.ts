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

vi.mock('@/lib/agent-ops/agent-ops-service', () => ({
    agentOpsService: {
        findAwaitingRunBySlackThread: vi.fn().mockResolvedValue(null),
        updateApprovalMessageTs: vi.fn().mockResolvedValue(undefined),
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
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body,
        });
        const msg = await adapter.parseInbound(req as any);
        expect(msg.channelType).toBe('slack');
        expect(msg.taskDescription).toBe('check lambdas');
        expect(msg.tenantId).toBe('T789');
        expect(msg.channelMeta).toMatchObject({
            userId: 'U123',
            channelId: 'C456',
        });
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
