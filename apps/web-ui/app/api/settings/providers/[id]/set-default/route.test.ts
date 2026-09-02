import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getAuthSession: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@/lib/provider-model-service', () => ({
    ProviderModelService: { setDefault: vi.fn(), toClientProvider: vi.fn((r: unknown) => r) },
}));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { ProviderModelService } from '@/lib/provider-model-service';
import { POST } from './route';

const makeParams = (id: string) => ({ params: Promise.resolve({ id }) });

describe('POST /api/settings/providers/[id]/set-default', () => {
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

        const res = await POST({} as any, makeParams('p1'));
        expect(res).toBe(authError);
    });

    it('sets the default and logs an audit event', async () => {
        vi.mocked(ProviderModelService.setDefault).mockResolvedValue({ id: 'p1', name: 'My Provider' } as any);

        const res = await POST({} as any, makeParams('p1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data.id).toBe('p1');
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'integration.provider.updated', status: 'success' })
        );
    });

    it('returns 404 when the provider is not found', async () => {
        vi.mocked(ProviderModelService.setDefault).mockRejectedValue(new Error('Provider not found'));
        const res = await POST({} as any, makeParams('p-missing'));
        expect(res.status).toBe(404);
    });

    it('returns 500 for other errors', async () => {
        vi.mocked(ProviderModelService.setDefault).mockRejectedValue(new Error('DB down'));
        const res = await POST({} as any, makeParams('p1'));
        expect(res.status).toBe(500);
    });
});
