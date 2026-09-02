import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/repository-factory', () => ({ getCertificateRepository: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/lib/auth-options', () => ({ authOptions: {} }));
vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@/lib/db/pg-config', () => ({ getTenantClient: vi.fn() }));
vi.mock('@/lib/certificate-material', () => ({ loadVersionMaterial: vi.fn() }));
vi.mock('@/lib/certificate-aws', () => ({
    assumeAccountRole: vi.fn(),
    scanAccountCertificates: vi.fn(),
    scannedCertMatchesDomain: vi.fn(),
    importToAcm: vi.fn(),
}));

import { getCertificateRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { getServerSession } from 'next-auth';
import { authorize } from '@/lib/rbac/authorize';
import { AuditService } from '@/lib/audit-service';
import { getTenantClient } from '@/lib/db/pg-config';
import { loadVersionMaterial } from '@/lib/certificate-material';
import { assumeAccountRole, scanAccountCertificates, scannedCertMatchesDomain, importToAcm } from '@/lib/certificate-aws';
import { POST } from './route';

const makeParams = (id: string) => ({ params: Promise.resolve({ id }) });
const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

const FUTURE = new Date(Date.now() + 365 * 86400000).toISOString();
const PAST = new Date(Date.now() - 86400000).toISOString();

function makeRepo(overrides: Record<string, unknown> = {}) {
    return {
        getCertificate: vi.fn().mockResolvedValue({ id: 'cert-1', name: 'My Cert', domainName: 'example.com' }),
        getActiveVersion: vi.fn().mockResolvedValue({ id: 'v1', version: 1, notAfter: FUTURE }),
        getDeployment: vi.fn().mockResolvedValue(null),
        upsertDeployment: vi.fn().mockResolvedValue(undefined),
        createExecution: vi.fn().mockResolvedValue(undefined),
        finishExecution: vi.fn().mockResolvedValue(undefined),
        deleteUnknownRegionDeployments: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

describe('POST /api/certificates/[id]/deploy', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getServerSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
        vi.mocked(getTenantClient).mockReturnValue({
            account: { findFirst: vi.fn().mockResolvedValue({ roleArn: 'arn:role', externalId: null, regions: ['us-east-1'], name: 'Prod', active: true }) },
        } as any);
        vi.mocked(assumeAccountRole).mockResolvedValue({ accessKeyId: 'x' } as any);
        vi.mocked(scanAccountCertificates).mockResolvedValue([]);
        vi.mocked(scannedCertMatchesDomain).mockReturnValue(false);
        vi.mocked(loadVersionMaterial).mockResolvedValue({ body: 'BODY', chain: null, privateKey: 'KEY' });
        vi.mocked(importToAcm).mockResolvedValue('arn:aws:acm:us-east-1:123:certificate/new');
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await POST(makeRequest({ accountId: 'acc-1' }), makeParams('cert-1'));
        expect(res).toBe(authError);
    });

    it('returns 400 when accountId is missing', async () => {
        const res = await POST(makeRequest({}), makeParams('cert-1'));
        expect(res.status).toBe(400);
    });

    it('returns 404 when the certificate does not exist', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue(makeRepo({ getCertificate: vi.fn().mockResolvedValue(null) }) as any);

        const res = await POST(makeRequest({ accountId: 'acc-1' }), makeParams('cert-missing'));
        expect(res.status).toBe(404);
    });

    it('returns 409 when there is no active version', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue(makeRepo({ getActiveVersion: vi.fn().mockResolvedValue(null) }) as any);

        const res = await POST(makeRequest({ accountId: 'acc-1' }), makeParams('cert-1'));
        expect(res.status).toBe(409);
    });

    it('returns 409 with ACTIVE_VERSION_EXPIRED when the active version has expired', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue(
            makeRepo({ getActiveVersion: vi.fn().mockResolvedValue({ id: 'v1', version: 1, notAfter: PAST }) }) as any
        );

        const res = await POST(makeRequest({ accountId: 'acc-1' }), makeParams('cert-1'));
        const body = await res.json();

        expect(res.status).toBe(409);
        expect(body.code).toBe('ACTIVE_VERSION_EXPIRED');
    });

    it('returns 404 when the target account does not exist', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue(makeRepo() as any);
        vi.mocked(getTenantClient).mockReturnValue({ account: { findFirst: vi.fn().mockResolvedValue(null) } } as any);

        const res = await POST(makeRequest({ accountId: 'acc-missing' }), makeParams('cert-1'));
        expect(res.status).toBe(404);
    });

    it('returns 400 when the target account is inactive', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue(makeRepo() as any);
        vi.mocked(getTenantClient).mockReturnValue({
            account: { findFirst: vi.fn().mockResolvedValue({ roleArn: 'arn:role', externalId: null, regions: [], name: 'Old', active: false }) },
        } as any);

        const res = await POST(makeRequest({ accountId: 'acc-1' }), makeParams('cert-1'));
        expect(res.status).toBe(400);
    });

    it('returns 409 ALREADY_PRESENT without force when the cert is already deployed', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue(makeRepo() as any);
        vi.mocked(scanAccountCertificates).mockResolvedValue([{ arn: 'arn:existing', domainName: 'example.com', inUseBy: [] }] as any);
        vi.mocked(scannedCertMatchesDomain).mockReturnValue(true);

        const res = await POST(makeRequest({ accountId: 'acc-1' }), makeParams('cert-1'));
        const body = await res.json();

        expect(res.status).toBe(409);
        expect(body.code).toBe('ALREADY_PRESENT');
        expect(importToAcm).not.toHaveBeenCalled();
    });

    it('deploys successfully, records the execution, and logs a success audit event', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue(makeRepo() as any);

        const res = await POST(makeRequest({ accountId: 'acc-1' }), makeParams('cert-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.data.certificateArn).toBe('arn:aws:acm:us-east-1:123:certificate/new');
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'deploy', status: 'success' })
        );
    });

    it('marks the execution failed and re-throws when importToAcm fails', async () => {
        const repo = makeRepo();
        vi.mocked(getCertificateRepository).mockReturnValue(repo as any);
        vi.mocked(importToAcm).mockRejectedValue(new Error('ACM ValidationException'));

        const res = await POST(makeRequest({ accountId: 'acc-1' }), makeParams('cert-1'));
        const body = await res.json();

        expect(res.status).toBe(500);
        expect(body.error).toBe('ACM ValidationException');
        expect(repo.finishExecution).toHaveBeenCalledWith('tenant-1', expect.any(String), expect.objectContaining({ status: 'failed' }));
    });

    it('returns 500 when assuming the role fails', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue(makeRepo() as any);
        vi.mocked(assumeAccountRole).mockResolvedValue(null);

        const res = await POST(makeRequest({ accountId: 'acc-1' }), makeParams('cert-1'));
        expect(res.status).toBe(500);
    });
});
