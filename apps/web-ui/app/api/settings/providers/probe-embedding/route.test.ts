import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/provider-model-service', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/provider-model-service')>()),
    ProviderModelService: { getConfigById: vi.fn() },
}));
vi.mock('@/lib/agent/embeddings-factory', () => ({
    probeEmbeddingDimensions: vi.fn(),
    REQUIRED_EMBEDDING_DIMENSIONS: 1024,
}));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { ProviderModelService } from '@/lib/provider-model-service';
import { probeEmbeddingDimensions } from '@/lib/agent/embeddings-factory';
import { ProviderConfigError } from '@/lib/agent/provider-errors';
import { POST } from './route';

const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;
const VALID_BODY = { providerType: 'bedrock', embeddingModel: 'titan-embed', credentials: { accessKeyId: 'ak' }, region: 'us-east-1' };

describe('POST /api/settings/providers/probe-embedding', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await POST(makeRequest(VALID_BODY));
        expect(res).toBe(authError);
        expect(probeEmbeddingDimensions).not.toHaveBeenCalled();
    });

    it('returns 400 for an invalid provider type', async () => {
        const res = await POST(makeRequest({ ...VALID_BODY, providerType: 'bogus' }));
        expect(res.status).toBe(400);
    });

    it('returns 400 when embeddingModel is missing', async () => {
        const res = await POST(makeRequest({ providerType: 'bedrock', credentials: { accessKeyId: 'ak' } }));
        expect(res.status).toBe(400);
    });

    it('returns 400 when neither credentials nor providerId are given', async () => {
        const res = await POST(makeRequest({ providerType: 'bedrock', embeddingModel: 'titan-embed' }));
        expect(res.status).toBe(400);
    });

    it('builds a runtime config from plaintext credentials on the create flow', async () => {
        vi.mocked(probeEmbeddingDimensions).mockResolvedValue(1024);

        const res = await POST(makeRequest(VALID_BODY));
        const body = await res.json();

        expect(probeEmbeddingDimensions).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'bedrock', embeddingModel: 'titan-embed', accessKeyId: 'ak', region: 'us-east-1',
        }));
        expect(res.status).toBe(200);
        expect(body.data).toEqual({ compatible: true, supported: true, dimensions: 1024, required: 1024, reason: null });
    });

    it('returns 404 when providerId is given but the saved config does not exist', async () => {
        vi.mocked(ProviderModelService.getConfigById).mockResolvedValue(null);
        const res = await POST(makeRequest({ providerType: 'bedrock', embeddingModel: 'titan-embed', providerId: 'p-missing' }));
        expect(res.status).toBe(404);
    });

    it('reuses the saved decrypted config on the edit flow with kept credentials', async () => {
        vi.mocked(ProviderModelService.getConfigById).mockResolvedValue({ id: 'p1', provider: 'bedrock', accessKeyId: 'ak' } as any);
        vi.mocked(probeEmbeddingDimensions).mockResolvedValue(1024);

        await POST(makeRequest({ providerType: 'bedrock', embeddingModel: 'titan-embed', providerId: 'p1' }));
        expect(probeEmbeddingDimensions).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1', embeddingModel: 'titan-embed' }));
    });

    it('reports incompatible dimensions without failing the request', async () => {
        vi.mocked(probeEmbeddingDimensions).mockResolvedValue(768);
        const res = await POST(makeRequest(VALID_BODY));
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.data.compatible).toBe(false);
        expect(body.data.reason).toContain('768-dimension');
    });

    it('returns 200 with supported:false when the model uses an unsupported schema', async () => {
        vi.mocked(probeEmbeddingDimensions).mockRejectedValue(new Error('ValidationException: Malformed input request'));
        const res = await POST(makeRequest(VALID_BODY));
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.data).toEqual(expect.objectContaining({ compatible: false, supported: false, dimensions: null }));
        expect(body.data.reason).toContain("isn't supported here");
    });

    it('returns 200 with a generic failure reason for other embedding errors', async () => {
        vi.mocked(probeEmbeddingDimensions).mockRejectedValue(new Error('Network timeout'));
        const res = await POST(makeRequest(VALID_BODY));
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.data.reason).toContain("Couldn't use this embedding model");
    });

    it('returns 400 when a provider config error escapes to the outer catch', async () => {
        vi.mocked(getSessionTenantId).mockRejectedValue(new ProviderConfigError('No provider configured'));
        const res = await POST(makeRequest(VALID_BODY));
        expect(res.status).toBe(400);
    });

    it('returns 502 for other unexpected errors', async () => {
        vi.mocked(getSessionTenantId).mockRejectedValue(new Error('DB down'));
        const res = await POST(makeRequest(VALID_BODY));
        expect(res.status).toBe(502);
    });
});
