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

vi.mock('@/lib/agent-ops/agent-ops-service', () => ({
    agentOpsService: {
        findAwaitingApprovalRunByJiraIssue: vi.fn().mockResolvedValue(null),
        findAwaitingRunByJiraIssue: vi.fn().mockResolvedValue(null),
    },
}));

// Default: no OAuth connection → existing Basic-auth path is exercised.
vi.mock('@/lib/connectors/connection-service', () => ({
    getUsableAccessToken: vi.fn().mockResolvedValue(null),
}));
import { getUsableAccessToken } from '@/lib/connectors/connection-service';

describe('JiraAdapter', () => {
    let adapter: JiraAdapter;

    beforeEach(() => {
        adapter = new JiraAdapter();
    });

    it('posts comments via OAuth when a connection exists', async () => {
        (getUsableAccessToken as any).mockResolvedValueOnce({
            accessToken: 'oauth-at',
            metadata: { apiBaseUrl: 'https://api.atlassian.com/ex/jira/cloud1' },
        });
        const fetchMock = vi.fn(async () => ({ ok: true, status: 201, text: async () => '' }));
        vi.stubGlobal('fetch', fetchMock as any);
        await (adapter as any).postComment('tenantA', 'OPS-1', 'hello', null);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [calledUrl, opts] = fetchMock.mock.calls[0] as any;
        expect(calledUrl).toContain('api.atlassian.com/ex/jira/cloud1');
        expect(opts.headers.Authorization).toBe('Bearer oauth-at');
        vi.unstubAllGlobals();
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

    it('parseInbound detects approve keyword as ReplyContext', async () => {
        const { agentOpsService } = await import('@/lib/agent-ops/agent-ops-service');
        (agentOpsService.findAwaitingApprovalRunByJiraIssue as any).mockResolvedValueOnce({
            runId: 'run-1', tenantId: 'tenant-1', status: 'awaiting_approval',
        });

        const payload = {
            issue: { key: 'OPS-42', fields: { summary: 'test', project: { key: 'OPS' } } },
            comment: { id: 'c1', body: 'approve', author: { displayName: 'Kartik', accountId: 'user-123' } },
        };
        const req = new Request('http://localhost/api/v1/gateway/jira', {
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

    it('sendAck returns runId', async () => {
        const req = new Request('http://localhost', { method: 'POST' });
        const res = await adapter.sendAck(req as any, 'run-1');
        const json = await res.json();
        expect(json.runId).toBe('run-1');
        expect(json.status).toBe('queued');
    });
});
