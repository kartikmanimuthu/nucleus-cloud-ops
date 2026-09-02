import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/tenant-config-service', () => ({ TenantConfigService: { getConfig: vi.fn() } }));
vi.mock('@/lib/agent-ops/agent-ops-service', () => ({
    agentOpsService: { findAwaitingApprovalRunByJiraIssue: vi.fn(), findAwaitingRunByJiraIssue: vi.fn() },
}));
vi.mock('@/lib/gateway/utils/dashboard-url', () => ({
    buildDashboardRespondUrl: vi.fn((id: string) => `https://dash/run/${id}/respond`),
    buildDashboardRunUrl: vi.fn((id: string) => `https://dash/run/${id}`),
}));

import { TenantConfigService } from '@/lib/tenant-config-service';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { JiraAdapter } from './jira-adapter';

const adapter = new JiraAdapter();

function makeRequest(body: unknown, headers: Record<string, string> = {}, search = '') {
    const text = JSON.stringify(body);
    return {
        url: `https://x.com/api/v1/gateway/jira${search}`,
        headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
        text: vi.fn().mockResolvedValue(text),
    } as any;
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
});
afterEach(() => vi.unstubAllGlobals());

describe('validateRequest', () => {
    it('accepts a matching Bearer authorization header, scoped to the tenant resolved from the body', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ webhookSecret: 'secret-1' } as any);
        const req = makeRequest({ issue: { key: 'X-1', fields: { project: { key: 'PROJ' } } } }, { authorization: 'Bearer secret-1' });

        expect(await adapter.validateRequest(req)).toBe(true);
        expect(TenantConfigService.getConfig).toHaveBeenCalledWith('agent-ops-jira', 'PROJ');
    });

    it('accepts a matching x-webhook-secret header without the Bearer prefix', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ webhookSecret: 'secret-1' } as any);
        const req = makeRequest({}, { 'x-webhook-secret': 'secret-1' });
        expect(await adapter.validateRequest(req)).toBe(true);
    });

    it('accepts a matching ?secret= query param (native Jira webhooks)', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ webhookSecret: 'secret-1' } as any);
        const req = makeRequest({}, {}, '?secret=secret-1');
        expect(await adapter.validateRequest(req)).toBe(true);
    });

    it('rejects a mismatched secret', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ webhookSecret: 'secret-1' } as any);
        const req = makeRequest({}, { authorization: 'wrong' });
        expect(await adapter.validateRequest(req)).toBe(false);
    });

    it('defaults to tenant "default" and falls back to the env secret when the body has no project key', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        const req = makeRequest({ not: 'a project' }, { authorization: 'env-secret' });
        // No configured secret and no env var set → denies (fail closed)
        expect(await adapter.validateRequest(req)).toBe(false);
        expect(TenantConfigService.getConfig).toHaveBeenCalledWith('agent-ops-jira', 'default');
    });

    it('denies when the body is unparsable and no tenant secret or env fallback exists', async () => {
        const req = { url: 'https://x.com/jira', headers: { get: () => null }, text: vi.fn().mockResolvedValue('not json') } as any;
        expect(await adapter.validateRequest(req)).toBe(false);
    });

    it('caches the request body so validateRequest and parseInbound do not re-read the stream', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ webhookSecret: 'secret-1', botAccountId: undefined } as any);
        const req = makeRequest({ issue: { key: 'X-1', fields: { project: { key: 'PROJ' }, summary: 'Do it' } } }, { authorization: 'secret-1' });

        await adapter.validateRequest(req);
        await adapter.parseInbound(req);
        expect(req.text).toHaveBeenCalledTimes(1);
    });
});

describe('parseInbound', () => {
    beforeEach(() => vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ botAccountId: 'bot-1' } as any));

    it('uses the issue summary + description as the task when there is no comment', async () => {
        const req = makeRequest({ issue: { key: 'X-1', fields: { project: { key: 'PROJ' }, summary: 'Fix it', description: 'Details here' } } });
        const msg = await adapter.parseInbound(req);
        expect(msg.taskDescription).toBe('Fix it\n\nDetails here');
        expect(msg.tenantId).toBe('PROJ');
    });

    it('prefers an explicit automation taskDescription over issue fields', async () => {
        const req = makeRequest({ issue: { key: 'X-1', fields: { project: { key: 'PROJ' } } }, taskDescription: 'Run the automation task' });
        const msg = await adapter.parseInbound(req);
        expect(msg.taskDescription).toBe('Run the automation task');
    });

    it('ignores the bot\'s own comments', async () => {
        const req = makeRequest({
            issue: { key: 'X-1', fields: { project: { key: 'PROJ' } } },
            comment: { id: 'c1', body: 'hello', author: { accountId: 'bot-1' } },
        });
        const msg = await adapter.parseInbound(req);
        expect(msg.taskDescription).toBe('');
        expect(msg.replyContext).toBeUndefined();
    });

    it('routes an "approve" comment on an awaiting_approval run to a reply context', async () => {
        vi.mocked(agentOpsService.findAwaitingApprovalRunByJiraIssue).mockResolvedValue({ runId: 'run-1', tenantId: 'PROJ' } as any);
        const req = makeRequest({
            issue: { key: 'X-1', fields: { project: { key: 'PROJ' } } },
            comment: { id: 'c1', body: 'approve', author: { accountId: 'human-1' } },
        });
        const msg = await adapter.parseInbound(req);
        expect(msg.replyContext).toEqual({ runId: 'run-1', action: 'approve', tenantId: 'PROJ' });
    });

    it('treats a "reject" comment with no awaiting-approval run as a plain task instead', async () => {
        vi.mocked(agentOpsService.findAwaitingApprovalRunByJiraIssue).mockResolvedValue(null);
        const req = makeRequest({
            issue: { key: 'X-1', fields: { project: { key: 'PROJ' } } },
            comment: { id: 'c1', body: 'rejected', author: { accountId: 'human-1' } },
        });
        const msg = await adapter.parseInbound(req);
        expect(msg.replyContext).toBeUndefined();
        expect(msg.taskDescription).toBe('rejected');
    });

    it('routes a clarification reply on an awaiting_input run', async () => {
        vi.mocked(agentOpsService.findAwaitingRunByJiraIssue).mockResolvedValue({ runId: 'run-2', tenantId: 'PROJ' } as any);
        const req = makeRequest({
            issue: { key: 'X-1', fields: { project: { key: 'PROJ' } } },
            comment: { id: 'c1', body: 'the answer is 42', author: { accountId: 'human-1' } },
        });
        const msg = await adapter.parseInbound(req);
        expect(msg.replyContext).toEqual({ runId: 'run-2', action: 'clarification_response', content: 'the answer is 42', tenantId: 'PROJ' });
    });

    it('extracts ADF comment text and strips a bot @mention when the comment mentions the bot', async () => {
        vi.mocked(agentOpsService.findAwaitingRunByJiraIssue).mockResolvedValue(null);
        const req = makeRequest({
            issue: { key: 'X-1', fields: { project: { key: 'PROJ' } } },
            comment: {
                id: 'c1', author: { accountId: 'human-1' },
                body: {
                    type: 'doc', content: [{
                        type: 'paragraph', content: [
                            { type: 'mention', attrs: { id: 'bot-1' } },
                            { type: 'text', text: ' please stop the instance' },
                        ],
                    }],
                },
            },
        });
        const msg = await adapter.parseInbound(req);
        expect(msg.taskDescription).toBe('please stop the instance');
    });

    it('uses a plain regular comment as the task description as the final fallback', async () => {
        vi.mocked(agentOpsService.findAwaitingRunByJiraIssue).mockResolvedValue(null);
        const req = makeRequest({
            issue: { key: 'X-1', fields: { project: { key: 'PROJ' } } },
            comment: { id: 'c1', body: 'just a note', author: { accountId: 'human-1' } },
        });
        const msg = await adapter.parseInbound(req);
        expect(msg.taskDescription).toBe('just a note');
    });
});

describe('sendResult / sendError / sendClarification / sendApprovalRequest', () => {
    beforeEach(() => vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ baseUrl: 'https://x.atlassian.net', userEmail: 'bot@x.co', apiToken: 'tok' } as any));

    it('sendResult posts a completion comment when the trigger has an issueKey', async () => {
        await adapter.sendResult({ tenantId: 'PROJ', runId: 'run-1', durationMs: 1500, trigger: { issueKey: 'X-1' }, result: { summary: 'Done', toolsUsed: ['stop_ec2'] } } as any, []);
        expect(fetch).toHaveBeenCalledWith(
            'https://x.atlassian.net/rest/api/3/issue/X-1/comment',
            expect.objectContaining({ method: 'POST' }),
        );
    });

    it('sendResult is a no-op when the trigger has no issueKey', async () => {
        await adapter.sendResult({ tenantId: 'PROJ', runId: 'run-1', trigger: {} } as any, []);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('sendError posts a failure comment', async () => {
        await adapter.sendError({ tenantId: 'PROJ', runId: 'run-1', trigger: { issueKey: 'X-1' } } as any, 'boom');
        expect(fetch).toHaveBeenCalled();
    });

    it('sendClarification includes the dashboard respond URL', async () => {
        await adapter.sendClarification({ tenantId: 'PROJ', runId: 'run-1', trigger: { issueKey: 'X-1' } } as any, 'Which instance?');
        const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
        expect(body.body.content[0].content[0].text).toContain('Which instance?');
        expect(body.body.content[0].content[0].text).toContain('dash/run/run-1/respond');
    });

    it('sendApprovalRequest lists the plan steps and pending tools', async () => {
        await adapter.sendApprovalRequest({ tenantId: 'PROJ', runId: 'run-1', taskDescription: 'Stop it', trigger: { issueKey: 'X-1' } } as any, ['Step one', 'Step two'], ['stop_ec2']);
        const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
        const text = body.body.content[0].content[0].text;
        expect(text).toContain('1. Step one');
        expect(text).toContain('Tools that will execute: stop_ec2');
    });

    it('swallows a failed Jira API call for the best-effort send methods', async () => {
        vi.mocked(fetch).mockResolvedValue({ ok: false, status: 500, text: vi.fn().mockResolvedValue('server error') } as any);
        await expect(adapter.sendResult({ tenantId: 'PROJ', runId: 'run-1', trigger: { issueKey: 'X-1' } } as any, [])).resolves.toBeUndefined();
    });

    it('logs but does not throw when Jira credentials are missing (best-effort)', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        await expect(adapter.sendResult({ tenantId: 'PROJ', runId: 'run-1', trigger: { issueKey: 'X-1' } } as any, [])).resolves.toBeUndefined();
        expect(fetch).not.toHaveBeenCalled();
    });
});

describe('sendScheduledNotification (strict mode)', () => {
    it('throws when the task has no configured issueKey', async () => {
        await expect(adapter.sendScheduledNotification(
            { name: 'Nightly', notification: {} } as any, { tenantId: 'PROJ', runId: 'run-1' } as any, 'result',
        )).rejects.toThrow('No Jira issueKey configured');
    });

    it('throws when the Jira integration is deactivated', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ enabled: false } as any);
        await expect(adapter.sendScheduledNotification(
            { name: 'Nightly', notification: { issueKey: 'X-1' } } as any, { tenantId: 'PROJ', runId: 'run-1' } as any, 'result',
        )).rejects.toThrow('deactivated');
    });

    it('throws when API credentials are not configured', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ enabled: true } as any);
        await expect(adapter.sendScheduledNotification(
            { name: 'Nightly', notification: { issueKey: 'X-1' } } as any, { tenantId: 'PROJ', runId: 'run-1' } as any, 'result',
        )).rejects.toThrow('credentials not configured');
    });

    it('propagates a Jira API failure (does not swallow it, unlike the interactive senders)', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ baseUrl: 'https://x.atlassian.net', userEmail: 'bot@x.co', apiToken: 'tok' } as any);
        vi.mocked(fetch).mockResolvedValue({ ok: false, status: 500, text: vi.fn().mockResolvedValue('fail') } as any);

        await expect(adapter.sendScheduledNotification(
            { name: 'Nightly', notification: { issueKey: 'X-1' } } as any,
            { tenantId: 'PROJ', runId: 'run-1', durationMs: 1000, result: { summary: 'ok' } } as any,
            'result',
        )).rejects.toThrow('Jira API error 500');
    });

    it('posts a result digest on success', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ baseUrl: 'https://x.atlassian.net', userEmail: 'bot@x.co', apiToken: 'tok' } as any);
        await adapter.sendScheduledNotification(
            { name: 'Nightly', notification: { issueKey: 'X-1' } } as any,
            { tenantId: 'PROJ', runId: 'run-1', durationMs: 1000, result: { summary: 'All good', toolsUsed: ['x'] } } as any,
            'result',
        );
        const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
        expect(body.body.content[0].content[0].text).toContain('completed');
    });

    it('posts a failure digest, distinguishing cancelled from failed', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ baseUrl: 'https://x.atlassian.net', userEmail: 'bot@x.co', apiToken: 'tok' } as any);
        await adapter.sendScheduledNotification(
            { name: 'Nightly', notification: { issueKey: 'X-1' } } as any,
            { tenantId: 'PROJ', runId: 'run-1', status: 'cancelled', error: 'stopped' } as any,
            'failure',
        );
        const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
        expect(body.body.content[0].content[0].text).toContain('was cancelled');
    });

    it('posts an attention-needed digest for a clarification-pending run', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ baseUrl: 'https://x.atlassian.net', userEmail: 'bot@x.co', apiToken: 'tok' } as any);
        await adapter.sendScheduledNotification(
            { name: 'Nightly', notification: { issueKey: 'X-1' } } as any,
            { tenantId: 'PROJ', runId: 'run-1', status: 'awaiting_input', clarification: { question: 'Which one?' } } as any,
            'needs_attention',
        );
        const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
        expect(body.body.content[0].content[0].text).toContain('Which one?');
    });
});

describe('getConfig', () => {
    it('returns the loaded config, or an empty object when none exists', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ enabled: true } as any);
        expect(await adapter.getConfig('PROJ')).toEqual({ enabled: true });

        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        expect(await adapter.getConfig('PROJ')).toEqual({});
    });
});
