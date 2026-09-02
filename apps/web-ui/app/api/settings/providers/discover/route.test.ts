import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/agent/model-discovery', () => ({ discoverModels: vi.fn() }));
vi.mock('@/lib/provider-model-service', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/provider-model-service')>()),
}));

import { authorize } from '@/lib/rbac/authorize';
import { discoverModels } from '@/lib/agent/model-discovery';
import { POST } from './route';

const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

describe('POST /api/settings/providers/discover', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await POST(makeRequest({ providerType: 'bedrock' }));
        expect(res).toBe(authError);
        expect(discoverModels).not.toHaveBeenCalled();
    });

    it('returns 400 for an invalid provider type', async () => {
        const res = await POST(makeRequest({ providerType: 'bogus' }));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toContain('Invalid provider type');
    });

    it('discovers models with the given credentials and region', async () => {
        vi.mocked(discoverModels).mockResolvedValue([{ id: 'm1', name: 'Model 1' }] as any);

        const res = await POST(makeRequest({
            providerType: 'bedrock', credentials: { accessKeyId: 'ak', secretAccessKey: 'sk' }, region: 'us-east-1',
        }));
        const body = await res.json();

        expect(discoverModels).toHaveBeenCalledWith('bedrock', { accessKeyId: 'ak', secretAccessKey: 'sk' }, 'us-east-1');
        expect(res.status).toBe(200);
        expect(body).toEqual({ success: true, data: { models: [{ id: 'm1', name: 'Model 1' }] } });
    });

    it('defaults credentials to an empty object when omitted', async () => {
        vi.mocked(discoverModels).mockResolvedValue([]);
        await POST(makeRequest({ providerType: 'bedrock' }));
        expect(discoverModels).toHaveBeenCalledWith('bedrock', {}, undefined);
    });

    it('returns 502 when discovery fails', async () => {
        vi.mocked(discoverModels).mockRejectedValue(new Error('Connection refused'));
        const res = await POST(makeRequest({ providerType: 'bedrock' }));
        const body = await res.json();
        expect(res.status).toBe(502);
        expect(body.error).toBe('Connection refused');
    });
});
