import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/repository-factory', () => ({ getCertificateRepository: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@/lib/db/pg-config', () => ({ getTenantClient: vi.fn() }));
vi.mock('@/lib/certificate-aws', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/certificate-aws')>()),
    assumeAccountRole: vi.fn(),
    scanAccountCertificates: vi.fn(),
    scannedCertMatchesDomain: vi.fn(),
}));

import { getCertificateRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { AuditService } from '@/lib/audit-service';
import { getTenantClient } from '@/lib/db/pg-config';
import { assumeAccountRole, scanAccountCertificates, scannedCertMatchesDomain } from '@/lib/certificate-aws';
import { POST } from './route';

const makeParams = (id: string) => ({ params: Promise.resolve({ id }) });

function makeRepo(overrides: Record<string, unknown> = {}) {
    return {
        getCertificate: vi.fn().mockResolvedValue({ id: 'cert-1', name: 'My Cert', domainName: 'example.com' }),
        upsertDeployment: vi.fn().mockResolvedValue(undefined),
        deleteUnknownRegionDeployments: vi.fn().mockResolvedValue(undefined),
        createExecution: vi.fn().mockResolvedValue(undefined),
        finishExecution: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

describe('POST /api/certificates/[id]/discover', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getTenantClient).mockReturnValue({
            account: { findMany: vi.fn().mockResolvedValue([{ accountId: 'acc-1', name: 'Prod', roleArn: 'arn:role', externalId: null, regions: ['us-east-1'] }]) },
        } as any);
        vi.mocked(assumeAccountRole).mockResolvedValue({ accessKeyId: 'x' } as any);
        vi.mocked(scanAccountCertificates).mockResolvedValue([]);
        vi.mocked(scannedCertMatchesDomain).mockReturnValue(false);
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await POST({} as any, makeParams('cert-1'));
        expect(res).toBe(authError);
    });

    it('returns 404 when the certificate does not exist', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue(makeRepo({ getCertificate: vi.fn().mockResolvedValue(null) }) as any);

        const res = await POST({} as any, makeParams('cert-missing'));
        expect(res.status).toBe(404);
    });

    it('returns status: success and 0 matches when no account has the cert', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue(makeRepo() as any);

        const res = await POST({} as any, makeParams('cert-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data.status).toBe('success');
        expect(body.data.matched).toBe(0);
        expect(body.data.targets).toBe(1);
    });

    it('records a matched deployment and reports matched: 1', async () => {
        const repo = makeRepo();
        vi.mocked(getCertificateRepository).mockReturnValue(repo as any);
        vi.mocked(scanAccountCertificates).mockResolvedValue([{ arn: 'arn:found', domainName: 'example.com', notAfter: new Date(), status: 'ISSUED', inUseBy: [] }] as any);
        vi.mocked(scannedCertMatchesDomain).mockReturnValue(true);

        const res = await POST({} as any, makeParams('cert-1'));
        const body = await res.json();

        expect(body.data.matched).toBe(1);
        expect(repo.upsertDeployment).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acc-1', acmArn: 'arn:found' }));
        expect(AuditService.logUserAction).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
    });

    it('reports status: partial and does not fail the request when a per-account scan errors', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue(makeRepo() as any);
        vi.mocked(assumeAccountRole).mockRejectedValue(new Error('AssumeRole denied'));

        const res = await POST({} as any, makeParams('cert-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data.status).toBe('partial');
        expect(body.data.errored).toBe(1);
        expect(AuditService.logUserAction).toHaveBeenCalledWith(expect.objectContaining({ status: 'warning' }));
    });

    it('records "assume role failed" when assumeAccountRole resolves falsy rather than throwing', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue(makeRepo() as any);
        vi.mocked(assumeAccountRole).mockResolvedValue(null as any);

        const res = await POST({} as any, makeParams('cert-1'));
        const body = await res.json();

        expect(body.data.status).toBe('partial');
        expect(body.data.results[0].error).toBe('assume role failed');
    });

    it('falls back to the generic "scan failed" message for a non-Error rejection', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue(makeRepo() as any);
        vi.mocked(scanAccountCertificates).mockRejectedValue('not an Error instance');

        const res = await POST({} as any, makeParams('cert-1'));
        const body = await res.json();

        expect(body.data.results[0].error).toBe('scan failed');
    });

    it('times out a per-account scan that takes longer than the per-task budget', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue(makeRepo() as any);
        vi.useFakeTimers();
        try {
            vi.mocked(assumeAccountRole).mockImplementation(() => new Promise(() => {})); // never resolves
            const resPromise = POST({} as any, makeParams('cert-1'));
            await vi.advanceTimersByTimeAsync(12_001);
            const res = await resPromise;
            const body = await res.json();

            expect(body.data.results[0].error).toContain('timed out after 12000ms');
        } finally {
            vi.useRealTimers();
        }
    });

    it('returns 500 when the repository throws', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue(makeRepo({ getCertificate: vi.fn().mockRejectedValue(new Error('DB down')) }) as any);

        const res = await POST({} as any, makeParams('cert-1'));
        expect(res.status).toBe(500);
    });
});
