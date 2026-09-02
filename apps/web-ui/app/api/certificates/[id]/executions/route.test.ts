import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/repository-factory', () => ({ getCertificateRepository: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));

import { getCertificateRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { GET } from './route';

const makeParams = (id: string) => ({ params: Promise.resolve({ id }) });
const makeRequest = (url = 'http://localhost/api/certificates/cert-1/executions') => ({ url }) as any;

describe('GET /api/certificates/[id]/executions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(authorize).mockResolvedValue(null);
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await GET(makeRequest(), makeParams('cert-1'));
        expect(res).toBe(authError);
    });

    it('returns 404 when the certificate does not exist', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({
            getCertificate: vi.fn().mockResolvedValue(null),
        } as any);

        const res = await GET(makeRequest(), makeParams('cert-missing'));
        expect(res.status).toBe(404);
    });

    it('returns executions limited to the requested count', async () => {
        const listExecutions = vi.fn().mockResolvedValue([{ id: 'exec-1' }]);
        vi.mocked(getCertificateRepository).mockReturnValue({
            getCertificate: vi.fn().mockResolvedValue({ id: 'cert-1' }),
            listExecutions,
        } as any);

        const res = await GET(makeRequest('http://localhost/api/certificates/cert-1/executions?limit=5'), makeParams('cert-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data).toEqual([{ id: 'exec-1' }]);
        expect(listExecutions).toHaveBeenCalledWith('tenant-1', 'cert-1', 5);
    });

    it('returns 500 when the repository throws', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({
            getCertificate: vi.fn().mockRejectedValue(new Error('DB down')),
        } as any);

        const res = await GET(makeRequest(), makeParams('cert-1'));
        expect(res.status).toBe(500);
    });
});
