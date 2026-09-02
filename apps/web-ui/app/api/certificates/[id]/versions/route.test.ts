import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/repository-factory', () => ({ getCertificateRepository: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@/lib/certificate-utils', () => ({
    computeExpiryStatus: vi.fn().mockReturnValue('active'),
    parseCertificatePem: vi.fn(),
}));
vi.mock('@/lib/certificate-crypto', () => ({
    parseCertificate: vi.fn().mockReturnValue({
        issuer: 'CA', notBefore: new Date('2024-01-01'), notAfter: new Date('2025-01-01'),
        fingerprint: 'fp-1', serialNumber: '01',
    }),
    validateKeyPair: vi.fn(),
    certificateCoversDomain: vi.fn().mockReturnValue(true),
}));
vi.mock('@/lib/certificate-material', () => ({
    putVersionMaterial: vi.fn().mockResolvedValue({ s3BodyKey: 'k1', s3ChainKey: null, s3PrivateKeyKey: 'k2' }),
    versionS3Prefix: vi.fn().mockReturnValue('prefix'),
}));
vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/lib/auth-options', () => ({ authOptions: {} }));

import { getCertificateRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { AuditService } from '@/lib/audit-service';
import { parseCertificatePem } from '@/lib/certificate-utils';
import { validateKeyPair, certificateCoversDomain } from '@/lib/certificate-crypto';
import { getServerSession } from 'next-auth';
import { GET, POST } from './route';

const makeParams = (id: string) => ({ params: Promise.resolve({ id }) });
const makeRequest = (body: unknown) => ({
    headers: { get: () => 'application/json' },
    json: vi.fn().mockResolvedValue(body),
}) as any;
const VALID_BODY = { body: 'PEM', privateKey: '-----BEGIN PRIVATE KEY----- x' };

describe('GET /api/certificates/[id]/versions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(authorize).mockResolvedValue(null);
    });

    it('returns 404 when the certificate does not exist', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({ getCertificate: vi.fn().mockResolvedValue(null) } as any);
        const res = await GET({} as any, makeParams('cert-missing'));
        expect(res.status).toBe(404);
    });

    it('returns the version list', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({
            getCertificate: vi.fn().mockResolvedValue({ id: 'cert-1' }),
            listVersions: vi.fn().mockResolvedValue([{ id: 'v1', version: 1 }]),
        } as any);

        const res = await GET({} as any, makeParams('cert-1'));
        const body = await res.json();
        expect(body.data).toEqual([{ id: 'v1', version: 1 }]);
    });

    it('returns 500 when the repository throws', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({ getCertificate: vi.fn().mockRejectedValue(new Error('DB down')) } as any);
        const res = await GET({} as any, makeParams('cert-1'));
        expect(res.status).toBe(500);
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);
        const res = await GET({} as any, makeParams('cert-1'));
        expect(res).toBe(authError);
    });
});

describe('POST /api/certificates/[id]/versions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getServerSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
        vi.mocked(parseCertificatePem).mockImplementation(() => {});
        vi.mocked(validateKeyPair).mockImplementation(() => {});
        vi.mocked(certificateCoversDomain).mockReturnValue(true);
    });

    function makeRepo(overrides: Record<string, unknown> = {}) {
        return {
            getCertificate: vi.fn().mockResolvedValue({ id: 'cert-1', name: 'My Cert', domainName: 'example.com' }),
            findVersionByFingerprint: vi.fn().mockResolvedValue(null),
            nextVersionNumber: vi.fn().mockResolvedValue(2),
            createVersion: vi.fn().mockResolvedValue({ id: 'v2', version: 2 }),
            activateVersion: vi.fn().mockResolvedValue(undefined),
            ...overrides,
        };
    }

    it('returns 404 when the certificate does not exist', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue(makeRepo({ getCertificate: vi.fn().mockResolvedValue(null) }) as any);
        const res = await POST(makeRequest(VALID_BODY), makeParams('cert-missing'));
        expect(res.status).toBe(404);
    });

    it('returns 400 when body or privateKey is missing', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue(makeRepo() as any);
        const res = await POST(makeRequest({ body: 'PEM' }), makeParams('cert-1'));
        expect(res.status).toBe(400);
    });

    it('returns 400 when the new version does not cover the certificate domain', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue(makeRepo() as any);
        vi.mocked(certificateCoversDomain).mockReturnValue(false);

        const res = await POST(makeRequest(VALID_BODY), makeParams('cert-1'));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toContain('does not cover');
    });

    it('returns 409 DUPLICATE_MATERIAL when identical material already exists as a version', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue(
            makeRepo({ findVersionByFingerprint: vi.fn().mockResolvedValue({ version: 1 }) }) as any
        );

        const res = await POST(makeRequest(VALID_BODY), makeParams('cert-1'));
        const body = await res.json();
        expect(res.status).toBe(409);
        expect(body.code).toBe('DUPLICATE_MATERIAL');
    });

    it('creates the version, does not activate by default, and logs an audit event', async () => {
        const repo = makeRepo();
        vi.mocked(getCertificateRepository).mockReturnValue(repo as any);

        const res = await POST(makeRequest(VALID_BODY), makeParams('cert-1'));
        const body = await res.json();

        expect(res.status).toBe(201);
        expect(body.data).toEqual({ id: 'v2', version: 2 });
        expect(repo.activateVersion).not.toHaveBeenCalled();
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'upload_version', status: 'success' })
        );
    });

    it('activates the version when activate: true is passed', async () => {
        const repo = makeRepo();
        vi.mocked(getCertificateRepository).mockReturnValue(repo as any);

        await POST(makeRequest({ ...VALID_BODY, activate: true }), makeParams('cert-1'));

        expect(repo.activateVersion).toHaveBeenCalledWith('tenant-1', 'cert-1', 'v2');
    });

    it('returns 500 when the repository throws', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue(
            makeRepo({ createVersion: vi.fn().mockRejectedValue(new Error('DB down')) }) as any
        );

        const res = await POST(makeRequest(VALID_BODY), makeParams('cert-1'));
        expect(res.status).toBe(500);
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);
        vi.mocked(getCertificateRepository).mockReturnValue(makeRepo() as any);

        const res = await POST(makeRequest(VALID_BODY), makeParams('cert-1'));
        expect(res).toBe(authError);
    });

    it('returns 400 when the private key PEM header is malformed', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue(makeRepo() as any);
        const res = await POST(makeRequest({ body: 'PEM', privateKey: '-----BEGIN CERTIFICATE----- x' }), makeParams('cert-1'));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toBe('Invalid private key PEM format');
    });

    it('accepts a multipart/form-data upload, including the activate flag', async () => {
        const repo = makeRepo();
        vi.mocked(getCertificateRepository).mockReturnValue(repo as any);

        const formData = new FormData();
        formData.set('body', new File(['PEM'], 'cert.pem'));
        formData.set('privateKey', new File(['-----BEGIN PRIVATE KEY----- x'], 'key.pem'));
        formData.set('activate', 'true');

        const req = { headers: { get: () => 'multipart/form-data; boundary=x' }, formData: vi.fn().mockResolvedValue(formData) } as any;
        const res = await POST(req, makeParams('cert-1'));

        expect(res.status).toBe(201);
        expect(repo.activateVersion).toHaveBeenCalledWith('tenant-1', 'cert-1', 'v2');
    });

    it('returns 400 for a multipart upload missing the body or private key file', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue(makeRepo() as any);
        const formData = new FormData();
        const req = { headers: { get: () => 'multipart/form-data; boundary=x' }, formData: vi.fn().mockResolvedValue(formData) } as any;

        const res = await POST(req, makeParams('cert-1'));
        expect(res.status).toBe(400);
    });
});
