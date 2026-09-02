import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/spot-guard/notify', () => ({ sendSpotGuardSlackAlert: vi.fn() }));
vi.mock('@/env', () => ({ env: { INTERNAL_API_KEY: undefined } }));

import { getSessionTenantId } from '@/lib/auth-session';
import { sendSpotGuardSlackAlert } from '@/lib/spot-guard/notify';
import { env } from '@/env';
import { POST } from './route';

const makeRequest = (body: unknown, headers: Record<string, string> = {}) => ({
    json: vi.fn().mockResolvedValue(body),
    headers: { get: (k: string) => headers[k] ?? null },
}) as any;

describe('POST /api/internal/spot-guard/notify', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        (env as any).INTERNAL_API_KEY = undefined;
    });

    it('falls back to session tenant when no internal key is configured', async () => {
        vi.mocked(sendSpotGuardSlackAlert).mockResolvedValue({ delivered: true } as any);

        const res = await POST(makeRequest({ text: 'hello' }, { 'x-internal-key': 'anything' }));
        const body = await res.json();

        expect(sendSpotGuardSlackAlert).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1' }));
        expect(res.status).toBe(200);
        expect(body).toEqual({ success: true, data: { delivered: true } });
    });

    it('authenticates via the internal key and tenant header when INTERNAL_API_KEY is configured', async () => {
        (env as any).INTERNAL_API_KEY = 'secret-key';
        vi.mocked(sendSpotGuardSlackAlert).mockResolvedValue({ delivered: true } as any);

        await POST(makeRequest({ text: 'hello' }, { 'x-internal-key': 'secret-key', 'x-tenant-id': 'tenant-worker' }));
        expect(sendSpotGuardSlackAlert).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-worker' }));
        expect(getSessionTenantId).not.toHaveBeenCalled();
    });

    it('returns 500 when the internal key matches but no tenant header is present', async () => {
        (env as any).INTERNAL_API_KEY = 'secret-key';
        const res = await POST(makeRequest({ text: 'hello' }, { 'x-internal-key': 'secret-key' }));
        const body = await res.json();
        expect(res.status).toBe(500);
        expect(body.error).toContain('x-tenant-id header required');
    });

    it('falls through to session auth when the internal key does not match', async () => {
        (env as any).INTERNAL_API_KEY = 'secret-key';
        vi.mocked(sendSpotGuardSlackAlert).mockResolvedValue({ delivered: true } as any);

        await POST(makeRequest({ text: 'hello' }, { 'x-internal-key': 'wrong-key' }));
        expect(getSessionTenantId).toHaveBeenCalled();
    });

    it('returns 400 for an invalid body', async () => {
        const res = await POST(makeRequest({ text: '' }));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.success).toBe(false);
    });

    it('tolerates an unparsable JSON body and fails validation as empty', async () => {
        const res = await POST({
            json: vi.fn().mockRejectedValue(new Error('bad json')),
            headers: { get: () => null },
        } as any);
        expect(res.status).toBe(400);
    });

    it('nests presentation fields under context, separate from text/color/channelId/layout', async () => {
        vi.mocked(sendSpotGuardSlackAlert).mockResolvedValue({ delivered: true } as any);

        await POST(makeRequest({
            text: 'Scaled down', color: '#ff0000', channelId: 'C123', layout: 'alert',
            eventType: 'scale_in', serviceName: 'svc', accountId: 'acc-1', region: 'us-east-1',
        }));

        expect(sendSpotGuardSlackAlert).toHaveBeenCalledWith({
            tenantId: 'tenant-1', text: 'Scaled down', color: '#ff0000', channelId: 'C123', layout: 'alert',
            context: { eventType: 'scale_in', serviceName: 'svc', accountId: 'acc-1', region: 'us-east-1' },
        });
    });

    it('returns 200 with the result even when delivery was skipped', async () => {
        vi.mocked(sendSpotGuardSlackAlert).mockResolvedValue({ delivered: false, reason: 'no Slack configured' } as any);
        const res = await POST(makeRequest({ text: 'hello' }));
        expect(res.status).toBe(200);
    });

    it('returns 500 when sending the alert throws', async () => {
        vi.mocked(sendSpotGuardSlackAlert).mockRejectedValue(new Error('Slack API error'));
        const res = await POST(makeRequest({ text: 'hello' }));
        const body = await res.json();
        expect(res.status).toBe(500);
        expect(body.error).toBe('Slack API error');
    });
});
