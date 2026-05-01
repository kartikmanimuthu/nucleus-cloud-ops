import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebhookAdapter } from '@/lib/gateway/adapters/webhook-adapter';

vi.mock('@/lib/tenant-config-service', () => ({
    TenantConfigService: {
        getConfig: vi.fn().mockResolvedValue({
            webhookSecret: 'webhook-secret-123',
            enabled: true,
        }),
    },
}));

describe('WebhookAdapter', () => {
    let adapter: WebhookAdapter;

    beforeEach(() => {
        adapter = new WebhookAdapter();
    });

    it('has correct channel metadata', () => {
        expect(adapter.channelType).toBe('webhook');
        expect(adapter.deliveryMode).toBe('callback');
        expect(adapter.hilCapabilities).toEqual({
            clarification: false,
            approvalButtons: false,
            threadedReplies: false,
        });
    });

    it('parseInbound extracts task and callbackUrl', async () => {
        const payload = {
            taskDescription: 'Check Lambda configs',
            tenantId: 'tenant-1',
            callbackUrl: 'https://example.com/webhook/callback',
        };
        const req = new Request('http://localhost/api/v1/gateway/webhook', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const msg = await adapter.parseInbound(req as any);
        expect(msg.channelType).toBe('webhook');
        expect(msg.taskDescription).toBe('Check Lambda configs');
        expect(msg.tenantId).toBe('tenant-1');
        expect(msg.channelMeta).toMatchObject({ callbackUrl: 'https://example.com/webhook/callback' });
    });

    it('parseInbound detects replyContext for programmatic resume', async () => {
        const payload = {
            taskDescription: '',
            tenantId: 'tenant-1',
            callbackUrl: 'https://example.com/callback',
            replyContext: { runId: 'run-1', action: 'approve' },
        };
        const req = new Request('http://localhost/api/v1/gateway/webhook', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const msg = await adapter.parseInbound(req as any);
        expect(msg.replyContext).toEqual({ runId: 'run-1', action: 'approve', tenantId: 'tenant-1' });
    });

    it('sendAck returns runId', async () => {
        const req = new Request('http://localhost', { method: 'POST' });
        const res = await adapter.sendAck(req as any, 'run-1');
        const json = await res.json();
        expect(json.runId).toBe('run-1');
        expect(json.status).toBe('queued');
    });

    it('sendResult posts to callbackUrl', async () => {
        const mockFetch = vi.fn().mockResolvedValue({ ok: true });
        global.fetch = mockFetch;

        const run = {
            runId: 'run-1', tenantId: 'tenant-1', source: 'webhook',
            trigger: { callbackUrl: 'https://example.com/callback' },
            result: { summary: 'Done', toolsUsed: ['list_files'], iterations: 1 },
            durationMs: 5000,
        } as any;

        await adapter.sendResult(run, []);
        expect(mockFetch).toHaveBeenCalledWith(
            'https://example.com/callback',
            expect.objectContaining({ method: 'POST' }),
        );
    });
});
