import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/repository-factory', () => ({ getCertificateRepository: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/certificate-material', () => ({ deleteMaterial: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/lib/auth-options', () => ({ authOptions: {} }));

import { getCertificateRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { deleteMaterial } from '@/lib/certificate-material';
import { AuditService } from '@/lib/audit-service';
import { getServerSession } from 'next-auth';
import { GET, DELETE } from './route';

const makeParams = (id: string) => ({ params: Promise.resolve({ id }) });

describe('GET /api/certificates/[id]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(authorize).mockResolvedValue(null);
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await GET({} as any, makeParams('cert-1'));
        expect(res).toBe(authError);
    });

    it('returns 404 when the certificate does not exist', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({
            getCertificate: vi.fn().mockResolvedValue(null),
        } as any);

        const res = await GET({} as any, makeParams('cert-missing'));
        expect(res.status).toBe(404);
    });

    it('includes the active version when activeVersionId is set', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({
            getCertificate: vi.fn().mockResolvedValue({ id: 'cert-1', activeVersionId: 'v1' }),
            getActiveVersion: vi.fn().mockResolvedValue({ id: 'v1', version: 1 }),
        } as any);

        const res = await GET({} as any, makeParams('cert-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data.activeVersion).toEqual({ id: 'v1', version: 1 });
    });

    it('omits activeVersion when the certificate has none', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({
            getCertificate: vi.fn().mockResolvedValue({ id: 'cert-1', activeVersionId: null }),
        } as any);

        const res = await GET({} as any, makeParams('cert-1'));
        const body = await res.json();

        expect(body.data.activeVersion).toBeNull();
    });

    it('returns 500 when the repository throws', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({
            getCertificate: vi.fn().mockRejectedValue(new Error('DB down')),
        } as any);

        const res = await GET({} as any, makeParams('cert-1'));
        expect(res.status).toBe(500);
    });
});

describe('DELETE /api/certificates/[id]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getServerSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
    });

    it('returns 403 when the coarse authorize check denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValueOnce(authError);

        const res = await DELETE({} as any, makeParams('cert-1'));
        expect(res).toBe(authError);
    });

    it('returns 404 when the certificate does not exist', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({
            getCertificate: vi.fn().mockResolvedValue(null),
        } as any);

        const res = await DELETE({} as any, makeParams('cert-missing'));
        expect(res.status).toBe(404);
    });

    it('returns 403 when the scoped (Layer 2) authorize check denies', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({
            getCertificate: vi.fn().mockResolvedValue({ id: 'cert-1', name: 'x', domain: 'prod.example.com' }),
        } as any);
        const { NextResponse } = await import('next/server');
        const scopedError = NextResponse.json({ error: 'Forbidden: production domain' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValueOnce(null).mockResolvedValueOnce(scopedError);

        const res = await DELETE({} as any, makeParams('cert-1'));
        expect(res).toBe(scopedError);
    });

    it('deletes S3 material for every version, then the certificate, and logs an audit event', async () => {
        const deleteCertificate = vi.fn().mockResolvedValue(undefined);
        vi.mocked(getCertificateRepository).mockReturnValue({
            getCertificate: vi.fn().mockResolvedValue({ id: 'cert-1', name: 'My Cert' }),
            listVersions: vi.fn().mockResolvedValue([
                { s3BodyKey: 'b1', s3ChainKey: 'c1', s3PrivateKeyKey: 'k1' },
            ]),
            deleteCertificate,
        } as any);

        const res = await DELETE({} as any, makeParams('cert-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual({ success: true });
        expect(deleteMaterial).toHaveBeenCalledWith(['b1', 'c1', 'k1']);
        expect(deleteCertificate).toHaveBeenCalledWith('tenant-1', 'cert-1');
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'delete', status: 'success' })
        );
    });

    it('returns 500 when the repository throws', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({
            getCertificate: vi.fn().mockRejectedValue(new Error('DB down')),
        } as any);

        const res = await DELETE({} as any, makeParams('cert-1'));
        expect(res.status).toBe(500);
    });
});
