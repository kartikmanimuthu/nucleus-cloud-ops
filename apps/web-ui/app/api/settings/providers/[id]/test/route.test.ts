import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/agent/model-discovery', () => ({ discoverModels: vi.fn() }));
vi.mock('@/lib/provider-model-service', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/provider-model-service')>()),
    ProviderModelService: { getConfigById: vi.fn() },
}));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { discoverModels } from '@/lib/agent/model-discovery';
import { ProviderModelService } from '@/lib/provider-model-service';
import { POST } from './route';

const makeParams = (id: string) => ({ params: Promise.resolve({ id }) });

describe('POST /api/settings/providers/[id]/test', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await POST({} as any, makeParams('p1'));
        expect(res).toBe(authError);
        expect(ProviderModelService.getConfigById).not.toHaveBeenCalled();
    });

    it('returns 404 when the provider is not found', async () => {
        vi.mocked(ProviderModelService.getConfigById).mockResolvedValue(null as any);
        const res = await POST({} as any, makeParams('p-missing'));
        expect(res.status).toBe(404);
    });

    it('returns 400 for an invalid provider type', async () => {
        vi.mocked(ProviderModelService.getConfigById).mockResolvedValue({ provider: 'bogus' } as any);
        const res = await POST({} as any, makeParams('p1'));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toContain('Invalid provider type');
    });

    it('discovers models with the stored credentials and region', async () => {
        vi.mocked(ProviderModelService.getConfigById).mockResolvedValue({
            provider: 'bedrock', apiKey: 'key', accessKeyId: 'ak', secretAccessKey: 'sk',
            baseUrl: 'https://x', region: 'us-east-1',
        } as any);
        vi.mocked(discoverModels).mockResolvedValue([{ id: 'm1', name: 'Model 1' }] as any);

        const res = await POST({} as any, makeParams('p1'));
        const body = await res.json();

        expect(discoverModels).toHaveBeenCalledWith(
            'bedrock',
            { apiKey: 'key', accessKeyId: 'ak', secretAccessKey: 'sk', baseUrl: 'https://x' },
            'us-east-1',
        );
        expect(res.status).toBe(200);
        expect(body.data).toEqual({ status: 'connected', availableModels: [{ id: 'm1', name: 'Model 1' }] });
    });

    it('returns 502 when discovery fails', async () => {
        vi.mocked(ProviderModelService.getConfigById).mockResolvedValue({ provider: 'bedrock' } as any);
        vi.mocked(discoverModels).mockRejectedValue(new Error('Connection refused'));

        const res = await POST({} as any, makeParams('p1'));
        const body = await res.json();
        expect(res.status).toBe(502);
        expect(body.error).toBe('Connection refused');
    });
});
