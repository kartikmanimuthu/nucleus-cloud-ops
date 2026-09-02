import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/repository-factory', () => ({ getCertificateRepository: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/db/pg-config', () => ({ getTenantClient: vi.fn() }));
vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/rbac/row-filter', () => ({ getReadRowFilter: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@/lib/certificate-utils', () => ({
    computeExpiryStatus: vi.fn().mockReturnValue('active'),
    parseCertificatePem: vi.fn(),
}));
vi.mock('@/lib/certificate-crypto', () => ({
    parseCertificate: vi.fn().mockReturnValue({
        issuer: 'Let\'s Encrypt', notBefore: new Date('2024-01-01'), notAfter: new Date('2025-01-01'),
        fingerprint: 'abc123', serialNumber: '01',
    }),
    validateKeyPair: vi.fn(),
}));
vi.mock('@/lib/certificate-material', () => ({
    putVersionMaterial: vi.fn().mockResolvedValue({ s3BodyKey: 'k1', s3ChainKey: null, s3PrivateKeyKey: 'k2' }),
    versionS3Prefix: vi.fn().mockReturnValue('tenants/tenant-1/certs/cert-1/v1'),
}));
vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/lib/auth-options', () => ({ authOptions: {} }));

import { getCertificateRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { getTenantClient } from '@/lib/db/pg-config';
import { authorize } from '@/lib/rbac/authorize';
import { AuditService } from '@/lib/audit-service';
import { parseCertificatePem } from '@/lib/certificate-utils';
import { validateKeyPair } from '@/lib/certificate-crypto';
import { getServerSession } from 'next-auth';
import { GET, POST } from './route';

const makeGetRequest = (url = 'http://localhost/api/certificates') => ({ url }) as any;
const makePostRequest = (body: unknown) => ({
    headers: { get: () => 'application/json' },
    json: vi.fn().mockResolvedValue(body),
}) as any;

describe('GET /api/certificates', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getTenantClient).mockReturnValue({
            certificateDeployment: { findMany: vi.fn().mockResolvedValue([]) },
            account: { findMany: vi.fn().mockResolvedValue([]) },
        } as any);
    });

    it('returns 401 for an unauthenticated caller', async () => {
        vi.mocked(getSessionTenantId).mockRejectedValue(new Error('Unauthenticated: no valid session'));

        const res = await GET(makeGetRequest());
        expect(res.status).toBe(401);
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await GET(makeGetRequest());
        expect(res).toBe(authError);
    });

    it('enriches certificates with associated account names from deployments', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({
            listCertificates: vi.fn().mockResolvedValue({ certificates: [{ id: 'cert-1' }], total: 1 }),
        } as any);
        vi.mocked(getTenantClient).mockReturnValue({
            certificateDeployment: {
                findMany: vi.fn().mockResolvedValue([{ certificateId: 'cert-1', accountId: 'acc-1' }]),
            },
            account: { findMany: vi.fn().mockResolvedValue([{ accountId: 'acc-1', name: 'Prod' }]) },
        } as any);

        const res = await GET(makeGetRequest());
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data[0].associatedAccountIds).toEqual(['acc-1']);
        expect(body.data[0].associatedAccountNames).toEqual(['Prod']);
    });

    it('returns 500 when the repository throws', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({
            listCertificates: vi.fn().mockRejectedValue(new Error('DB down')),
        } as any);

        const res = await GET(makeGetRequest());
        expect(res.status).toBe(500);
    });

    it('tolerates a failed account-name lookup, returning certificates with raw ids as names', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({
            listCertificates: vi.fn().mockResolvedValue({ certificates: [{ id: 'cert-1' }], total: 1 }),
        } as any);
        vi.mocked(getTenantClient).mockReturnValue({
            certificateDeployment: { findMany: vi.fn().mockResolvedValue([{ certificateId: 'cert-1', accountId: 'acc-1' }]) },
            account: { findMany: vi.fn().mockRejectedValue(new Error('DB down')) },
        } as any);

        const res = await GET(makeGetRequest());
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.data[0].associatedAccountNames).toEqual(['acc-1']);
    });
});

describe('POST /api/certificates', () => {
    const VALID_BODY = { name: 'My Cert', domainName: 'example.com', body: 'PEM', privateKey: 'PEM-KEY' };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getServerSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
        // vi.clearAllMocks() clears call history but NOT a mockImplementation set
        // by an earlier test — reset these two to their happy-path behavior here.
        vi.mocked(parseCertificatePem).mockImplementation(() => {});
        vi.mocked(validateKeyPair).mockImplementation(() => {});
    });

    it('returns 401 for an unauthenticated caller', async () => {
        vi.mocked(getSessionTenantId).mockRejectedValue(new Error('Unauthenticated'));
        const res = await POST(makePostRequest(VALID_BODY));
        expect(res.status).toBe(500);
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await POST(makePostRequest(VALID_BODY));
        expect(res).toBe(authError);
    });

    it('returns 400 when required fields are missing', async () => {
        const res = await POST(makePostRequest({ name: 'x' }));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toContain('required');
    });

    it('returns 400 when the certificate material fails validation', async () => {
        vi.mocked(parseCertificatePem).mockImplementation(() => { throw new Error('Malformed PEM'); });

        const res = await POST(makePostRequest(VALID_BODY));
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.error).toBe('Malformed PEM');
    });

    it('returns 400 when the private key does not match the certificate', async () => {
        vi.mocked(validateKeyPair).mockImplementation(() => { throw new Error('Key mismatch'); });

        const res = await POST(makePostRequest({ ...VALID_BODY, privateKey: '-----BEGIN PRIVATE KEY----- x' }));
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.error).toBe('Key mismatch');
    });

    it('uploads a valid certificate, logs an audit event, and returns 201', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({
            createWithInitialVersion: vi.fn().mockResolvedValue({ certificate: { id: 'cert-1', name: 'My Cert' } }),
        } as any);

        const res = await POST(makePostRequest({ ...VALID_BODY, privateKey: '-----BEGIN PRIVATE KEY----- x' }));
        const body = await res.json();

        expect(res.status).toBe(201);
        expect(body.data.id).toBe('cert-1');
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'upload', status: 'success' })
        );
    });

    it('returns 500 when the repository throws', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({
            createWithInitialVersion: vi.fn().mockRejectedValue(new Error('DB down')),
        } as any);

        const res = await POST(makePostRequest({ ...VALID_BODY, privateKey: '-----BEGIN PRIVATE KEY----- x' }));
        expect(res.status).toBe(500);
    });

    it('returns 400 when the private key PEM header is malformed', async () => {
        const res = await POST(makePostRequest({ ...VALID_BODY, privateKey: '-----BEGIN CERTIFICATE----- x' }));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toBe('Invalid private key PEM format');
    });

    it('accepts a multipart/form-data upload', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({
            createWithInitialVersion: vi.fn().mockResolvedValue({ certificate: { id: 'cert-1', name: 'My Cert' } }),
        } as any);

        const formData = new FormData();
        formData.set('name', 'My Cert');
        formData.set('domainName', 'example.com');
        formData.set('body', new File(['PEM'], 'cert.pem'));
        formData.set('privateKey', new File(['-----BEGIN PRIVATE KEY----- x'], 'key.pem'));

        const req = { headers: { get: () => 'multipart/form-data; boundary=x' }, formData: vi.fn().mockResolvedValue(formData) } as any;
        const res = await POST(req);
        const body = await res.json();

        expect(res.status).toBe(201);
        expect(body.data.id).toBe('cert-1');
    });

    it('returns 400 for a multipart upload missing the body or private key file', async () => {
        const formData = new FormData();
        formData.set('name', 'My Cert');
        formData.set('domainName', 'example.com');

        const req = { headers: { get: () => 'multipart/form-data; boundary=x' }, formData: vi.fn().mockResolvedValue(formData) } as any;
        const res = await POST(req);
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.error).toContain('Certificate body and private key are required');
    });
});
