import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getAuthSession: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@/lib/provider-model-service', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/provider-model-service')>()),
    ProviderModelService: { updateProvider: vi.fn(), deleteProvider: vi.fn(), toClientProvider: vi.fn((r: unknown) => r) },
}));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { ProviderModelService } from '@/lib/provider-model-service';
import { PUT, DELETE } from './route';

const makeParams = (id: string) => ({ params: Promise.resolve({ id }) });
const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

describe('PUT /api/settings/providers/[id]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getAuthSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await PUT(makeRequest({ name: 'x' }), makeParams('p1'));
        expect(res).toBe(authError);
    });

    it('returns 400 for an invalid provider type', async () => {
        const res = await PUT(makeRequest({ provider: 'bogus' }), makeParams('p1'));
        expect(res.status).toBe(400);
    });

    it('updates the provider and logs an audit event', async () => {
        vi.mocked(ProviderModelService.updateProvider).mockResolvedValue({ id: 'p1', name: 'Renamed' } as any);

        const res = await PUT(makeRequest({ name: 'Renamed' }), makeParams('p1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data.name).toBe('Renamed');
        expect(AuditService.logUserAction).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
    });

    it('returns 404 when the provider is not found', async () => {
        vi.mocked(ProviderModelService.updateProvider).mockRejectedValue(new Error('Provider not found'));
        const res = await PUT(makeRequest({ name: 'x' }), makeParams('p-missing'));
        expect(res.status).toBe(404);
    });

    it('returns 500 for other errors', async () => {
        vi.mocked(ProviderModelService.updateProvider).mockRejectedValue(new Error('DB down'));
        const res = await PUT(makeRequest({ name: 'x' }), makeParams('p1'));
        expect(res.status).toBe(500);
    });
});

describe('DELETE /api/settings/providers/[id]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getAuthSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await DELETE({} as any, makeParams('p1'));
        expect(res).toBe(authError);
    });

    it('deletes the provider and logs an audit event', async () => {
        vi.mocked(ProviderModelService.deleteProvider).mockResolvedValue(undefined as any);

        const res = await DELETE({} as any, makeParams('p1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual({ success: true });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
    });

    it('returns 404 when the provider is not found', async () => {
        vi.mocked(ProviderModelService.deleteProvider).mockRejectedValue(new Error('Provider not found'));
        const res = await DELETE({} as any, makeParams('p-missing'));
        expect(res.status).toBe(404);
    });
});
