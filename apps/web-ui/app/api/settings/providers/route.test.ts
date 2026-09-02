import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getAuthSession: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@/lib/provider-model-service', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/provider-model-service')>()),
    ProviderModelService: { listAllProviders: vi.fn(), createProvider: vi.fn(), toClientProvider: vi.fn((r: unknown) => r) },
}));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { ProviderModelService } from '@/lib/provider-model-service';
import { GET, POST } from './route';

const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;
const VALID_BODY = { name: 'My Provider', models: [{ id: 'm1', label: 'M1' }] };

describe('GET /api/settings/providers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await GET({} as any);
        expect(res).toBe(authError);
    });

    it('returns providers and a flat chat-model picker list', async () => {
        vi.mocked(ProviderModelService.listAllProviders).mockResolvedValue([{ id: 'p1' }] as any);
        vi.mocked(ProviderModelService.toClientProvider).mockReturnValue({
            id: 'p1', name: 'My Provider', provider: 'bedrock', isEnabled: true, isDefault: true,
            chatModel: 'm1', models: [{ id: 'm1', label: 'M1', capabilities: ['chat'] }],
        } as any);

        const res = await GET({} as any);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data.providers).toHaveLength(1);
        expect(body.data.models).toEqual([
            { id: 'bedrock:m1:p1', label: 'M1 (My Provider)', provider: 'bedrock', isDefault: true },
        ]);
    });

    it('excludes disabled providers from the model picker list', async () => {
        vi.mocked(ProviderModelService.listAllProviders).mockResolvedValue([{ id: 'p1' }] as any);
        vi.mocked(ProviderModelService.toClientProvider).mockReturnValue({
            id: 'p1', name: 'Off', provider: 'bedrock', isEnabled: false, isDefault: false,
            models: [{ id: 'm1', label: 'M1' }],
        } as any);

        const res = await GET({} as any);
        const body = await res.json();
        expect(body.data.models).toEqual([]);
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(ProviderModelService.listAllProviders).mockRejectedValue(new Error('DB down'));
        const res = await GET({} as any);
        expect(res.status).toBe(500);
    });
});

describe('POST /api/settings/providers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getAuthSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
        vi.mocked(ProviderModelService.toClientProvider).mockImplementation((r: unknown) => r as any);
    });

    it('returns 400 when name is missing', async () => {
        const res = await POST(makeRequest({ models: VALID_BODY.models }));
        expect(res.status).toBe(400);
    });

    it('returns 400 for an invalid provider type', async () => {
        const res = await POST(makeRequest({ ...VALID_BODY, provider: 'bogus' }));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toContain('Invalid provider type');
    });

    it('returns 400 when no models are provided', async () => {
        const res = await POST(makeRequest({ name: 'x', models: [] }));
        expect(res.status).toBe(400);
    });

    it('creates the provider and logs an audit event', async () => {
        vi.mocked(ProviderModelService.createProvider).mockResolvedValue({ id: 'p1', name: 'My Provider' } as any);

        const res = await POST(makeRequest(VALID_BODY));
        const body = await res.json();

        expect(res.status).toBe(201);
        expect(body.data.id).toBe('p1');
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'integration.provider.created', status: 'success' })
        );
    });

    it('returns 500 and logs a failure audit event when the service throws', async () => {
        vi.mocked(ProviderModelService.createProvider).mockRejectedValue(new Error('DB down'));
        const res = await POST(makeRequest(VALID_BODY));
        expect(res.status).toBe(500);
        expect(AuditService.logUserAction).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
    });
});
