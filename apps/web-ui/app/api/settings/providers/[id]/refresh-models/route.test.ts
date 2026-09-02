import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/agent/model-discovery', () => ({ discoverModels: vi.fn() }));
vi.mock('@/lib/provider-model-service', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/provider-model-service')>()),
    ProviderModelService: { getConfigById: vi.fn(), updateModels: vi.fn(), toClientProvider: vi.fn((r: unknown) => r) },
}));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { discoverModels } from '@/lib/agent/model-discovery';
import { ProviderModelService } from '@/lib/provider-model-service';
import { POST } from './route';

const makeParams = (id: string) => ({ params: Promise.resolve({ id }) });

describe('POST /api/settings/providers/[id]/refresh-models', () => {
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
        vi.mocked(ProviderModelService.getConfigById).mockResolvedValue({ provider: 'bogus', models: [] } as any);
        const res = await POST({} as any, makeParams('p1'));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toContain('Invalid provider type');
    });

    it('refreshes models, preserving maxTokens for models that still exist', async () => {
        vi.mocked(ProviderModelService.getConfigById).mockResolvedValue({
            provider: 'bedrock', apiKey: 'key', accessKeyId: 'ak', secretAccessKey: 'sk',
            baseUrl: undefined, region: 'us-east-1',
            models: [{ id: 'm1', label: 'Old M1', maxTokens: 4096 }, { id: 'm-stale', label: 'Stale', maxTokens: 100 }],
        } as any);
        vi.mocked(discoverModels).mockResolvedValue([
            { id: 'm1', name: 'Model 1', capabilities: ['chat'] },
            { id: 'm2', name: 'Model 2', capabilities: ['chat'] },
        ] as any);
        vi.mocked(ProviderModelService.updateModels).mockResolvedValue({ id: 'p1', name: 'My Provider' } as any);

        const res = await POST({} as any, makeParams('p1'));
        const body = await res.json();

        expect(ProviderModelService.updateModels).toHaveBeenCalledWith('p1', 'tenant-1', [
            { id: 'm1', label: 'Model 1', capabilities: ['chat'], maxTokens: 4096 },
            { id: 'm2', label: 'Model 2', capabilities: ['chat'], maxTokens: undefined },
        ]);
        expect(res.status).toBe(200);
        expect(body.data.id).toBe('p1');
    });

    it('returns 502 when discovery fails', async () => {
        vi.mocked(ProviderModelService.getConfigById).mockResolvedValue({ provider: 'bedrock', models: [] } as any);
        vi.mocked(discoverModels).mockRejectedValue(new Error('Connection refused'));

        const res = await POST({} as any, makeParams('p1'));
        const body = await res.json();
        expect(res.status).toBe(502);
        expect(body.error).toBe('Connection refused');
    });
});
