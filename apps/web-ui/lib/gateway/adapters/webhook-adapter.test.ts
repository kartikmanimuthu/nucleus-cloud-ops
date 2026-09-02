import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';

vi.mock('@/lib/tenant-config-service', () => ({ TenantConfigService: { getConfig: vi.fn() } }));
vi.mock('@/lib/gateway/utils/dashboard-url', () => ({
    buildDashboardRespondUrl: vi.fn((id: string) => `https://dash/run/${id}/respond`),
}));

import { TenantConfigService } from '@/lib/tenant-config-service';
import { WebhookAdapter } from './webhook-adapter';

const adapter = new WebhookAdapter();

function sign(body: string, secret: string): string {
    return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function makeRequest(body: unknown, signature?: string) {
    const text = JSON.stringify(body);
    return {
        headers: { get: (k: string) => (k === 'x-webhook-signature' ? signature ?? null : null) },
        text: vi.fn().mockResolvedValue(text),
    } as any;
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
});
afterEach(() => vi.unstubAllGlobals());

describe('validateRequest', () => {
    it('rejects when no signature header is present', async () => {
        const req = makeRequest({ tenantId: 't1' });
        expect(await adapter.validateRequest(req)).toBe(false);
    });

    it('accepts a valid HMAC signature using the tenant-configured secret', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ webhookSecret: 'tenant-secret' } as any);
        const body = { tenantId: 't1', taskDescription: 'x', callbackUrl: 'https://cb' };
        const req = makeRequest(body, sign(JSON.stringify(body), 'tenant-secret'));

        expect(await adapter.validateRequest(req)).toBe(true);
        expect(TenantConfigService.getConfig).toHaveBeenCalledWith('agent-ops-webhook', 't1');
    });

    it('rejects an invalid signature', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ webhookSecret: 'tenant-secret' } as any);
        const body = { tenantId: 't1' };
        const req = makeRequest(body, '0'.repeat(64));
        expect(await adapter.validateRequest(req)).toBe(false);
    });

    it('rejects a malformed (non-hex-length) signature without throwing', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ webhookSecret: 'tenant-secret' } as any);
        const req = makeRequest({ tenantId: 't1' }, 'not-a-valid-signature');
        expect(await adapter.validateRequest(req)).toBe(false);
    });

    it('denies when no tenant secret or env fallback is configured (fail closed)', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        const req = makeRequest({ tenantId: 't1' }, 'abc');
        expect(await adapter.validateRequest(req)).toBe(false);
    });

    it('tolerates an unparsable body, treating tenantId as empty', async () => {
        const req = { headers: { get: (k: string) => (k === 'x-webhook-signature' ? 'sig' : null) }, text: vi.fn().mockResolvedValue('not json') } as any;
        expect(await adapter.validateRequest(req)).toBe(false);
        expect(TenantConfigService.getConfig).not.toHaveBeenCalled();
    });

    it('caches the request body across validateRequest and parseInbound', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ webhookSecret: 's' } as any);
        const body = { tenantId: 't1', taskDescription: 'x', callbackUrl: 'https://cb' };
        const req = makeRequest(body, sign(JSON.stringify(body), 's'));

        await adapter.validateRequest(req);
        await adapter.parseInbound(req);
        expect(req.text).toHaveBeenCalledTimes(1);
    });
});

describe('parseInbound', () => {
    it('maps the payload into a GatewayMessage, including channelMeta and a generated webhookId', async () => {
        const req = makeRequest({ tenantId: 't1', taskDescription: 'Stop it', callbackUrl: 'https://cb', mode: 'plan', autoApprove: true, accountId: 'acc-1' });
        const msg = await adapter.parseInbound(req);

        expect(msg).toEqual(expect.objectContaining({
            channelType: 'webhook', tenantId: 't1', taskDescription: 'Stop it', mode: 'plan', autoApprove: true, accountId: 'acc-1',
        }));
        expect(msg.channelMeta).toEqual(expect.objectContaining({ callbackUrl: 'https://cb', webhookId: expect.any(String) }));
    });

    it('maps a replyContext when present', async () => {
        const req = makeRequest({ tenantId: 't1', taskDescription: '', callbackUrl: 'https://cb', replyContext: { runId: 'run-1', action: 'approve' } });
        const msg = await adapter.parseInbound(req);
        expect(msg.replyContext).toEqual({ runId: 'run-1', action: 'approve', content: undefined, tenantId: 't1' });
    });

    it('defaults taskDescription to an empty string when absent', async () => {
        const req = makeRequest({ tenantId: 't1', callbackUrl: 'https://cb' });
        const msg = await adapter.parseInbound(req);
        expect(msg.taskDescription).toBe('');
    });
});

describe('sendAck', () => {
    it('returns a 200 JSON response acknowledging the run', async () => {
        const res = await adapter.sendAck({} as any, 'run-1');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ runId: 'run-1', status: 'queued' });
    });
});

describe('outbound sends (postWithRetry)', () => {
    it('sendResult posts a completion payload to the callback URL', async () => {
        await adapter.sendResult({ runId: 'run-1', durationMs: 500, trigger: { callbackUrl: 'https://cb' }, result: { summary: 'ok', toolsUsed: ['x'] } } as any, []);
        expect(fetch).toHaveBeenCalledWith('https://cb', expect.objectContaining({ method: 'POST' }));
        const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
        expect(body).toEqual({ runId: 'run-1', status: 'completed', summary: 'ok', toolsUsed: ['x'], duration: 500 });
    });

    it('is a no-op when the trigger has no callbackUrl', async () => {
        await adapter.sendResult({ runId: 'run-1', trigger: {} } as any, []);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('sendError posts a failure payload', async () => {
        await adapter.sendError({ runId: 'run-1', trigger: { callbackUrl: 'https://cb' } } as any, 'boom');
        const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
        expect(body).toEqual({ runId: 'run-1', status: 'failed', error: 'boom' });
    });

    it('sendClarification includes the dashboard respond URL', async () => {
        await adapter.sendClarification({ runId: 'run-1', trigger: { callbackUrl: 'https://cb' } } as any, 'Which one?');
        const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
        expect(body).toEqual({ runId: 'run-1', status: 'awaiting_input', question: 'Which one?', dashboardUrl: 'https://dash/run/run-1/respond' });
    });

    it('sendApprovalRequest includes plan steps and pending tools', async () => {
        await adapter.sendApprovalRequest({ runId: 'run-1', trigger: { callbackUrl: 'https://cb' } } as any, ['step 1'], ['stop_ec2']);
        const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
        expect(body).toEqual({
            runId: 'run-1', status: 'awaiting_approval', planSteps: ['step 1'], pendingTools: ['stop_ec2'],
            dashboardUrl: 'https://dash/run/run-1/respond',
        });
    });

    it('retries on failure with exponential backoff, up to 3 attempts, then gives up', async () => {
        vi.useFakeTimers();
        try {
            vi.mocked(fetch).mockResolvedValue({ ok: false, status: 500 } as any);
            const promise = adapter.sendResult({ runId: 'run-1', trigger: { callbackUrl: 'https://cb' } } as any, []);
            await vi.runAllTimersAsync();
            await promise;
            expect(fetch).toHaveBeenCalledTimes(3);
        } finally {
            vi.useRealTimers();
        }
    });

    it('stops retrying as soon as a callback succeeds', async () => {
        vi.useFakeTimers();
        try {
            vi.mocked(fetch)
                .mockResolvedValueOnce({ ok: false, status: 500 } as any)
                .mockResolvedValueOnce({ ok: true } as any);
            const promise = adapter.sendResult({ runId: 'run-1', trigger: { callbackUrl: 'https://cb' } } as any, []);
            await vi.runAllTimersAsync();
            await promise;
            expect(fetch).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('retries on a thrown network error too', async () => {
        vi.useFakeTimers();
        try {
            vi.mocked(fetch).mockRejectedValue(new Error('network down'));
            const promise = adapter.sendResult({ runId: 'run-1', trigger: { callbackUrl: 'https://cb' } } as any, []);
            await vi.runAllTimersAsync();
            await promise;
            expect(fetch).toHaveBeenCalledTimes(3);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('getConfig', () => {
    it('returns the loaded config, or an empty object when none exists', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ enabled: true } as any);
        expect(await adapter.getConfig('t1')).toEqual({ enabled: true });

        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        expect(await adapter.getConfig('t1')).toEqual({});
    });
});
