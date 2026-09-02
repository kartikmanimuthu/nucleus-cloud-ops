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
import { DELETE } from './route';

const makeParams = (id: string, versionId: string) => ({ params: Promise.resolve({ id, versionId }) });

describe('DELETE /api/certificates/[id]/versions/[versionId]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getServerSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await DELETE({} as any, makeParams('cert-1', 'v1'));
        expect(res).toBe(authError);
    });

    it('returns 404 when the certificate does not exist', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({ getCertificate: vi.fn().mockResolvedValue(null) } as any);
        const res = await DELETE({} as any, makeParams('cert-missing', 'v1'));
        expect(res.status).toBe(404);
    });

    it('returns 404 when the version does not exist', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({
            getCertificate: vi.fn().mockResolvedValue({ id: 'cert-1', name: 'x' }),
            getVersion: vi.fn().mockResolvedValue(null),
        } as any);

        const res = await DELETE({} as any, makeParams('cert-1', 'v-missing'));
        expect(res.status).toBe(404);
    });

    it('returns 409 ACTIVE_VERSION when trying to delete the active version', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({
            getCertificate: vi.fn().mockResolvedValue({ id: 'cert-1', name: 'x' }),
            getVersion: vi.fn().mockResolvedValue({ id: 'v1', version: 1, isActive: true }),
        } as any);

        const res = await DELETE({} as any, makeParams('cert-1', 'v1'));
        const body = await res.json();
        expect(res.status).toBe(409);
        expect(body.code).toBe('ACTIVE_VERSION');
        expect(deleteMaterial).not.toHaveBeenCalled();
    });

    it('deletes S3 material and the version row, then logs an audit event', async () => {
        const deleteVersion = vi.fn().mockResolvedValue(undefined);
        vi.mocked(getCertificateRepository).mockReturnValue({
            getCertificate: vi.fn().mockResolvedValue({ id: 'cert-1', name: 'My Cert' }),
            getVersion: vi.fn().mockResolvedValue({ id: 'v1', version: 1, isActive: false, s3BodyKey: 'b', s3ChainKey: 'c', s3PrivateKeyKey: 'k' }),
            deleteVersion,
        } as any);

        const res = await DELETE({} as any, makeParams('cert-1', 'v1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual({ success: true });
        expect(deleteMaterial).toHaveBeenCalledWith(['b', 'c', 'k']);
        expect(deleteVersion).toHaveBeenCalledWith('tenant-1', 'cert-1', 'v1');
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'delete_version', status: 'success' })
        );
    });

    it('returns 500 when the repository throws', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({
            getCertificate: vi.fn().mockRejectedValue(new Error('DB down')),
        } as any);

        const res = await DELETE({} as any, makeParams('cert-1', 'v1'));
        expect(res.status).toBe(500);
    });
});
