import { describe, it, expect, vi, beforeEach } from 'vitest';

// parseInbound() resolves tenant from the authenticated session first (see the
// doc comment in api-adapter.ts) via getAuthSession(), which calls next-auth's
// getServerSession() -> next/headers' headers() — a Next.js dynamic API that
// requires a live request scope and throws outside one. Mocked to null so the
// x-tenant-id fallback path (genuine external API-key callers) is exercised,
// matching what this suite actually tests.
vi.mock('@/lib/auth-session', () => ({
    getAuthSession: vi.fn().mockResolvedValue(null),
    getSessionTenantId: vi.fn().mockResolvedValue('tenant-1'),
}));

import { ApiAdapter } from '@/lib/gateway/adapters/api-adapter';

describe('ApiAdapter', () => {
    let adapter: ApiAdapter;

    beforeEach(() => {
        adapter = new ApiAdapter();
    });

    it('has correct channel metadata', () => {
        expect(adapter.channelType).toBe('api');
        expect(adapter.deliveryMode).toBe('polling');
        expect(adapter.hilCapabilities).toEqual({
            clarification: false,
            approvalButtons: false,
            threadedReplies: false,
        });
    });

    it('validates bearer token auth', async () => {
        const req = new Request('http://localhost/api/v1/gateway/api', {
            method: 'POST',
            headers: { 'authorization': 'Bearer test-token', 'content-type': 'application/json' },
            body: JSON.stringify({ taskDescription: 'test' }),
        });
        const result = await adapter.validateRequest(req as any);
        expect(result).toBe(true);
    });

    it('validates API key auth', async () => {
        const req = new Request('http://localhost/api/v1/gateway/api', {
            method: 'POST',
            headers: { 'x-api-key': 'key-123', 'content-type': 'application/json' },
            body: JSON.stringify({ taskDescription: 'test' }),
        });
        const result = await adapter.validateRequest(req as any);
        expect(result).toBe(true);
    });

    it('rejects requests with no auth', async () => {
        const req = new Request('http://localhost/api/v1/gateway/api', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ taskDescription: 'test' }),
        });
        const result = await adapter.validateRequest(req as any);
        expect(result).toBe(false);
    });

    it('parseInbound extracts task description and options', async () => {
        const req = new Request('http://localhost/api/v1/gateway/api', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-tenant-id': 'tenant-1' },
            body: JSON.stringify({ taskDescription: 'Check Lambda configs', mode: 'plan', autoApprove: true }),
        });
        const msg = await adapter.parseInbound(req as any);
        expect(msg.channelType).toBe('api');
        expect(msg.taskDescription).toBe('Check Lambda configs');
        expect(msg.tenantId).toBe('tenant-1');
        expect(msg.mode).toBe('plan');
        expect(msg.autoApprove).toBe(true);
    });

    /**
     * The regression this task exists to prevent: parseInbound used to
     * hardcode mode: 'plan' regardless of the payload, so a selector could
     * send mode: 'deep' all the way to this adapter and still see it silently
     * dropped before gateway-service.ts or createRun ever saw it. The test
     * above alone would NOT have caught that bug — it happens to assert
     * 'plan' on a 'plan' input, which is indistinguishable from the old
     * hardcoded return value. These two pin the actual pass-through/validation
     * behaviour.
     */
    it('parseInbound passes an explicit "deep" mode through unchanged', async () => {
        const req = new Request('http://localhost/api/v1/gateway/api', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-tenant-id': 'tenant-1' },
            body: JSON.stringify({ taskDescription: 'Audit S3 buckets', mode: 'deep' }),
        });
        const msg = await adapter.parseInbound(req as any);
        expect(msg.mode).toBe('deep');
    });

    it('parseInbound leaves mode undefined for an invalid/legacy mode, instead of defaulting to plan', async () => {
        const req = new Request('http://localhost/api/v1/gateway/api', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-tenant-id': 'tenant-1' },
            body: JSON.stringify({ taskDescription: 'Check Lambda configs', mode: 'fast' }),
        });
        const msg = await adapter.parseInbound(req as any);
        // Not 'plan' — gateway-service.ts's `message.mode ?? await resolveDefaultMode(tenantId)`
        // must still get a chance to apply the tenant's configured default.
        expect(msg.mode).toBeUndefined();
    });

    it('parseInbound leaves mode undefined when the payload carries none at all', async () => {
        const req = new Request('http://localhost/api/v1/gateway/api', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-tenant-id': 'tenant-1' },
            body: JSON.stringify({ taskDescription: 'Check Lambda configs' }),
        });
        const msg = await adapter.parseInbound(req as any);
        expect(msg.mode).toBeUndefined();
    });

    it('parseInbound prefers the authenticated session tenant over the x-tenant-id header', async () => {
        // Read paths resolve tenant via getSessionTenantId() from the same
        // session; this write path must agree or a run is created under one
        // tenant and queried under another (404 "Run not found").
        const { getAuthSession } = await import('@/lib/auth-session');
        vi.mocked(getAuthSession).mockResolvedValueOnce({ user: { tenantId: 'session-tenant' } } as any);

        const req = new Request('http://localhost/api/v1/gateway/api', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-tenant-id': 'header-tenant' },
            body: JSON.stringify({ taskDescription: 'test' }),
        });
        const msg = await adapter.parseInbound(req as any);
        expect(msg.tenantId).toBe('session-tenant');
    });

    it('parseInbound falls back to "default" tenant when neither session nor header is present', async () => {
        const req = new Request('http://localhost/api/v1/gateway/api', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ taskDescription: 'test' }),
        });
        const msg = await adapter.parseInbound(req as any);
        expect(msg.tenantId).toBe('default');
    });

    it('sendAck returns runId and queued status', async () => {
        const req = new Request('http://localhost', { method: 'POST' });
        const res = await adapter.sendAck(req as any, 'run-1');
        const json = await res.json();
        expect(json.runId).toBe('run-1');
        expect(json.status).toBe('queued');
    });

    it('getConfig returns an empty object (no per-tenant config for the API channel)', async () => {
        expect(await adapter.getConfig('tenant-1')).toEqual({});
    });
});
