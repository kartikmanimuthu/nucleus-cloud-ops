import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/repository-factory', () => ({ getCertificateRepository: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/certificate-material', () => ({ loadVersionMaterial: vi.fn() }));

import { getCertificateRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { loadVersionMaterial } from '@/lib/certificate-material';
import { GET } from './route';

const makeParams = (id: string) => ({ params: Promise.resolve({ id }) });
const makeRequest = (url = 'http://localhost/api/certificates/cert-1/content') => ({ url }) as any;

describe('GET /api/certificates/[id]/content', () => {
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

    it('returns 404 when there is no material for the requested version', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({
            getCertificate: vi.fn().mockResolvedValue({ id: 'cert-1', activeVersionId: null }),
            getActiveVersion: vi.fn().mockResolvedValue(null),
        } as any);

        const res = await GET(makeRequest(), makeParams('cert-1'));
        const body = await res.json();
        expect(res.status).toBe(404);
        expect(body.error).toContain('No certificate material');
    });

    it('returns the active version material by default', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({
            getCertificate: vi.fn().mockResolvedValue({ id: 'cert-1' }),
            getActiveVersion: vi.fn().mockResolvedValue({ id: 'v1', version: 1 }),
        } as any);
        vi.mocked(loadVersionMaterial).mockResolvedValue({ body: 'BODY', chain: null, privateKey: 'KEY' });

        const res = await GET(makeRequest(), makeParams('cert-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data).toEqual({ body: 'BODY', chain: null, privateKey: 'KEY' });
    });

    it('fetches a specific version when versionId is provided', async () => {
        const getVersion = vi.fn().mockResolvedValue({ id: 'v2', version: 2 });
        vi.mocked(getCertificateRepository).mockReturnValue({
            getCertificate: vi.fn().mockResolvedValue({ id: 'cert-1' }),
            getVersion,
        } as any);
        vi.mocked(loadVersionMaterial).mockResolvedValue({ body: 'BODY2', chain: null, privateKey: 'KEY2' });

        await GET(makeRequest('http://localhost/api/certificates/cert-1/content?versionId=v2'), makeParams('cert-1'));

        expect(getVersion).toHaveBeenCalledWith('tenant-1', 'cert-1', 'v2');
    });

    it('returns 500 when the repository throws', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({
            getCertificate: vi.fn().mockRejectedValue(new Error('DB down')),
        } as any);

        const res = await GET(makeRequest(), makeParams('cert-1'));
        expect(res.status).toBe(500);
    });
});
