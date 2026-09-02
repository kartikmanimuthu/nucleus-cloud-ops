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
const makeRequest = (url = 'http://localhost/api/certificates/cert-1/download') => ({ url }) as any;

describe('GET /api/certificates/[id]/download', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(authorize).mockResolvedValue(null);
    });

    it('returns 401 for an unauthenticated caller', async () => {
        vi.mocked(getSessionTenantId).mockRejectedValue(new Error('Unauthenticated: no valid session'));
        const res = await GET(makeRequest(), makeParams('cert-1'));
        expect(res.status).toBe(401);
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await GET(makeRequest(), makeParams('cert-1'));
        expect(res).toBe(authError);
    });

    it('returns 404 when no certificate material is available (no active version)', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({
            getCertificate: vi.fn().mockResolvedValue({ id: 'cert-1', name: 'x' }),
            getActiveVersion: vi.fn().mockResolvedValue(null),
        } as any);

        const res = await GET(makeRequest(), makeParams('cert-1'));
        expect(res.status).toBe(404);
    });

    it('returns 404 when the certificate does not exist', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({
            getCertificate: vi.fn().mockResolvedValue(null),
        } as any);

        const res = await GET(makeRequest(), makeParams('cert-missing'));
        expect(res.status).toBe(404);
    });

    it('returns a zip file with the correct content type and filename', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({
            getCertificate: vi.fn().mockResolvedValue({ id: 'cert-1', name: 'My Cert!' }),
            getActiveVersion: vi.fn().mockResolvedValue({ id: 'v1', version: 1 }),
        } as any);
        vi.mocked(loadVersionMaterial).mockResolvedValue({ body: 'BODY', chain: 'CHAIN', privateKey: 'KEY' });

        const res = await GET(makeRequest(), makeParams('cert-1'));

        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('application/zip');
        expect(res.headers.get('Content-Disposition')).toContain('My_Cert__v1.zip');
        const buf = await res.arrayBuffer();
        expect(buf.byteLength).toBeGreaterThan(0);
    });

    it('returns 500 when material loading throws', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({
            getCertificate: vi.fn().mockResolvedValue({ id: 'cert-1', name: 'x' }),
            getActiveVersion: vi.fn().mockResolvedValue({ id: 'v1', version: 1 }),
        } as any);
        vi.mocked(loadVersionMaterial).mockRejectedValue(new Error('S3 down'));

        const res = await GET(makeRequest(), makeParams('cert-1'));
        expect(res.status).toBe(500);
    });
});
