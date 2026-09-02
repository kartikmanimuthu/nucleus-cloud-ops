import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/repository-factory', () => ({ getCertificateRepository: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/lib/auth-options', () => ({ authOptions: {} }));
vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@/lib/db/pg-config', () => ({ getTenantClient: vi.fn() }));
vi.mock('@/lib/certificate-material', () => ({ loadVersionMaterial: vi.fn() }));
vi.mock('@/lib/certificate-aws', () => ({ assumeAccountRole: vi.fn(), importToAcm: vi.fn() }));

import { getCertificateRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { getServerSession } from 'next-auth';
import { authorize } from '@/lib/rbac/authorize';
import { AuditService } from '@/lib/audit-service';
import { getTenantClient } from '@/lib/db/pg-config';
import { loadVersionMaterial } from '@/lib/certificate-material';
import { assumeAccountRole, importToAcm } from '@/lib/certificate-aws';
import { POST } from './route';

const makeParams = (id: string) => ({ params: Promise.resolve({ id }) });
const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

const FUTURE = new Date(Date.now() + 365 * 86400000).toISOString();
const PAST = new Date(Date.now() - 86400000).toISOString();

function makeRepo(overrides: Record<string, unknown> = {}) {
    return {
        getCertificate: vi.fn().mockResolvedValue({ id: 'cert-1', name: 'My Cert', domainName: 'example.com' }),
        getActiveVersion: vi.fn().mockResolvedValue({ id: 'v1', version: 1, notAfter: FUTURE }),
        listDeployments: vi.fn().mockResolvedValue([{ accountId: 'acc-1', region: 'us-east-1', acmArn: 'arn:existing' }]),
        upsertDeployment: vi.fn().mockResolvedValue(undefined),
        createExecution: vi.fn().mockResolvedValue(undefined),
        finishExecution: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

describe('POST /api/certificates/[id]/reimport', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getServerSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
        vi.mocked(getTenantClient).mockReturnValue({
            account: { findFirst: vi.fn().mockResolvedValue({ roleArn: 'arn:role', externalId: null, name: 'Prod' }) },
        } as any);
        vi.mocked(loadVersionMaterial).mockResolvedValue({ body: 'BODY', chain: null, privateKey: 'KEY' });
        vi.mocked(assumeAccountRole).mockResolvedValue({ accessKeyId: 'x' } as any);
        vi.mocked(importToAcm).mockResolvedValue('arn:existing');
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

    it('returns 409 ACTIVE_VERSION_EXPIRED when the active version has expired', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue(
            makeRepo({ getActiveVersion: vi.fn().mockResolvedValue({ id: 'v1', version: 1, notAfter: PAST }) }) as any
        );

        const res = await POST(makeRequest({ accountId: 'acc-1' }), makeParams('cert-1'));
        const body = await res.json();
        expect(res.status).toBe(409);
        expect(body.code).toBe('ACTIVE_VERSION_EXPIRED');
    });

    it('returns 409 NOT_DISCOVERED when no deployment exists in the target account', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue(makeRepo({ listDeployments: vi.fn().mockResolvedValue([]) }) as any);

        const res = await POST(makeRequest({ accountId: 'acc-1' }), makeParams('cert-1'));
        const body = await res.json();
        expect(res.status).toBe(409);
        expect(body.code).toBe('NOT_DISCOVERED');
    });

    it('returns 404 when the account does not exist', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue(makeRepo() as any);
        vi.mocked(getTenantClient).mockReturnValue({ account: { findFirst: vi.fn().mockResolvedValue(null) } } as any);

        const res = await POST(makeRequest({ accountId: 'acc-1' }), makeParams('cert-1'));
        expect(res.status).toBe(404);
    });

    it('reimports to every deployed region and reports success', async () => {
        const repo = makeRepo();
        vi.mocked(getCertificateRepository).mockReturnValue(repo as any);

        const res = await POST(makeRequest({ accountId: 'acc-1' }), makeParams('cert-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.data.status).toBe('success');
        expect(body.data.perRegion).toEqual([{ region: 'us-east-1', arn: 'arn:existing', ok: true }]);
        expect(AuditService.logUserAction).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
    });

    it('reports status: partial when some regions fail and others succeed', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue(
            makeRepo({ listDeployments: vi.fn().mockResolvedValue([
                { accountId: 'acc-1', region: 'us-east-1', acmArn: 'arn:1' },
                { accountId: 'acc-1', region: 'eu-west-1', acmArn: 'arn:2' },
            ]) }) as any
        );
        vi.mocked(importToAcm).mockResolvedValueOnce('arn:1').mockRejectedValueOnce(new Error('ACM error'));

        const res = await POST(makeRequest({ accountId: 'acc-1' }), makeParams('cert-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.data.status).toBe('partial');
    });

    it('reports status: failed (success: false) when every region fails', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue(makeRepo() as any);
        vi.mocked(assumeAccountRole).mockResolvedValue(null);

        const res = await POST(makeRequest({ accountId: 'acc-1' }), makeParams('cert-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.success).toBe(false);
        expect(body.data.status).toBe('failed');
        expect(AuditService.logUserAction).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
    });

    it('returns 500 when the repository throws before reimport begins', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue(makeRepo({ getCertificate: vi.fn().mockRejectedValue(new Error('DB down')) }) as any);

        const res = await POST(makeRequest({ accountId: 'acc-1' }), makeParams('cert-1'));
        expect(res.status).toBe(500);
    });
});
