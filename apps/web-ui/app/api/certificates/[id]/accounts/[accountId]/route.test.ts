import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/repository-factory', () => ({ getCertificateRepository: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/db/pg-config', () => ({ getTenantClient: vi.fn() }));
vi.mock('@/lib/certificate-aws', () => ({ assumeAccountRole: vi.fn(), describeAcmCertificate: vi.fn() }));

import { getCertificateRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { getTenantClient } from '@/lib/db/pg-config';
import { assumeAccountRole, describeAcmCertificate } from '@/lib/certificate-aws';
import { GET } from './route';

const makeParams = (id: string, accountId: string) => ({ params: Promise.resolve({ id, accountId }) });

function makeRepo(overrides: Record<string, unknown> = {}) {
    return {
        getCertificate: vi.fn().mockResolvedValue({ id: 'cert-1' }),
        findDeployedInAccount: vi.fn().mockResolvedValue({ acmArn: 'arn:1', region: 'us-east-1' }),
        ...overrides,
    };
}

describe('GET /api/certificates/[id]/accounts/[accountId]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getTenantClient).mockReturnValue({
            account: { findFirst: vi.fn().mockResolvedValue({ accountId: 'acc-1', name: 'Prod', roleArn: 'arn:role', externalId: null, regions: ['us-east-1'] }) },
        } as any);
        vi.mocked(assumeAccountRole).mockResolvedValue({ accessKeyId: 'x' } as any);
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await GET({} as any, makeParams('cert-1', 'acc-1'));
        expect(res).toBe(authError);
    });

    it('returns 404 when the certificate does not exist', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue(makeRepo({ getCertificate: vi.fn().mockResolvedValue(null) }) as any);
        const res = await GET({} as any, makeParams('cert-missing', 'acc-1'));
        expect(res.status).toBe(404);
    });

    it('returns 404 when the account does not exist', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue(makeRepo() as any);
        vi.mocked(getTenantClient).mockReturnValue({ account: { findFirst: vi.fn().mockResolvedValue(null) } } as any);

        const res = await GET({} as any, makeParams('cert-1', 'acc-missing'));
        expect(res.status).toBe(404);
    });

    it('returns 404 NOT_DISCOVERED when there is no ACM deployment in the account', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue(makeRepo({ findDeployedInAccount: vi.fn().mockResolvedValue(null) }) as any);

        const res = await GET({} as any, makeParams('cert-1', 'acc-1'));
        const body = await res.json();
        expect(res.status).toBe(404);
        expect(body.code).toBe('NOT_DISCOVERED');
    });

    it('returns 500 when assuming the role fails', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue(makeRepo() as any);
        vi.mocked(assumeAccountRole).mockResolvedValue(null);

        const res = await GET({} as any, makeParams('cert-1', 'acc-1'));
        expect(res.status).toBe(500);
    });

    it('returns 404 when ACM no longer has the certificate', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue(makeRepo() as any);
        vi.mocked(describeAcmCertificate).mockResolvedValue(null);

        const res = await GET({} as any, makeParams('cert-1', 'acc-1'));
        expect(res.status).toBe(404);
    });

    it('returns certificate detail with parsed InUseBy resources', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue(makeRepo() as any);
        vi.mocked(describeAcmCertificate).mockResolvedValue({
            CertificateArn: 'arn:1', Status: 'ISSUED', DomainName: 'example.com', Issuer: 'CA',
            NotBefore: new Date('2024-01-01'), NotAfter: new Date('2025-01-01'), Serial: '01',
            InUseBy: ['arn:aws:cloudfront::123:distribution/ABC'],
        } as any);

        const res = await GET({} as any, makeParams('cert-1', 'acc-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data.certificate.arn).toBe('arn:1');
        expect(body.data.certificate.inUseBy).toEqual([{ arn: expect.stringContaining('distribution'), type: 'Distribution', service: 'CloudFront' }]);
        expect(body.data.account.accountId).toBe('acc-1');
    });

    it('classifies every known associated-resource ARN shape, and falls back to Unknown for a malformed ARN', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue(makeRepo() as any);
        vi.mocked(describeAcmCertificate).mockResolvedValue({
            CertificateArn: 'arn:1', Status: 'ISSUED', DomainName: 'example.com', Issuer: 'CA',
            InUseBy: [
                'arn:aws:apigateway:us-east-1::/domainnames/api.example.com',
                'arn:aws:execute-api:us-east-1:123:abc/prod/GET/resource',
                'arn:aws:cognito-idp:us-east-1:123:userpool/us-east-1_abc',
                'too:short',
            ],
        } as any);

        const res = await GET({} as any, makeParams('cert-1', 'acc-1'));
        const body = await res.json();

        expect(body.data.certificate.inUseBy).toEqual([
            { arn: expect.stringContaining('apigateway'), type: 'Domain Name', service: 'API Gateway' },
            { arn: expect.stringContaining('execute-api'), type: 'API', service: 'API Gateway' },
            { arn: expect.stringContaining('cognito-idp'), type: 'User Pool', service: 'Cognito' },
            { arn: 'too:short', type: 'Unknown', service: 'Unknown' },
        ]);
    });

    it('returns 500 when the repository throws', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue(makeRepo({ getCertificate: vi.fn().mockRejectedValue(new Error('DB down')) }) as any);
        const res = await GET({} as any, makeParams('cert-1', 'acc-1'));
        expect(res.status).toBe(500);
    });
});
