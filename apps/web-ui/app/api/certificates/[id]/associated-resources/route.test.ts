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

const makeParams = (id: string) => ({ params: Promise.resolve({ id }) });

describe('GET /api/certificates/[id]/associated-resources', () => {
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

    it('returns an empty resource list when there are no ACM deployments', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({
            getCertificate: vi.fn().mockResolvedValue({ id: 'cert-1' }),
            listDeployments: vi.fn().mockResolvedValue([]),
        } as any);

        const res = await GET({} as any, makeParams('cert-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data.resources).toEqual([]);
    });

    it('resolves InUseBy ARNs into typed resources per deployment', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({
            getCertificate: vi.fn().mockResolvedValue({ id: 'cert-1' }),
            listDeployments: vi.fn().mockResolvedValue([
                { accountId: 'acc-1', region: 'us-east-1', acmArn: 'arn:aws:acm:us-east-1:123:certificate/abc' },
            ]),
        } as any);
        vi.mocked(getTenantClient).mockReturnValue({
            account: { findMany: vi.fn().mockResolvedValue([{ accountId: 'acc-1', name: 'Prod', roleArn: 'arn:role', externalId: null }]) },
        } as any);
        vi.mocked(assumeAccountRole).mockResolvedValue({ accessKeyId: 'x', secretAccessKey: 'y', sessionToken: 'z' } as any);
        vi.mocked(describeAcmCertificate).mockResolvedValue({
            InUseBy: ['arn:aws:elasticloadbalancing:us-east-1:123:loadbalancer/app/my-alb/abc'],
        } as any);

        const res = await GET({} as any, makeParams('cert-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data.resources).toEqual([
            { arn: expect.stringContaining('loadbalancer'), type: 'ALB/NLB', service: 'ELB', accountId: 'acc-1', accountName: 'Prod', region: 'us-east-1' },
        ]);
    });

    it('classifies every known associated-resource ARN shape, and falls back to Unknown for a malformed ARN', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({
            getCertificate: vi.fn().mockResolvedValue({ id: 'cert-1' }),
            listDeployments: vi.fn().mockResolvedValue([
                { accountId: 'acc-1', region: 'us-east-1', acmArn: 'arn:1' },
            ]),
        } as any);
        vi.mocked(getTenantClient).mockReturnValue({
            account: { findMany: vi.fn().mockResolvedValue([{ accountId: 'acc-1', name: 'Prod', roleArn: 'arn:role', externalId: null }]) },
        } as any);
        vi.mocked(assumeAccountRole).mockResolvedValue({ accessKeyId: 'x' } as any);
        vi.mocked(describeAcmCertificate).mockResolvedValue({
            InUseBy: [
                'arn:aws:apigateway:us-east-1::/domainnames/api.example.com',
                'arn:aws:execute-api:us-east-1:123:abc/prod/GET/resource',
                'arn:aws:cognito-idp:us-east-1:123:userpool/us-east-1_abc',
                'too:short',
            ],
        } as any);

        const res = await GET({} as any, makeParams('cert-1'));
        const body = await res.json();

        expect(body.data.resources.map((r: any) => ({ type: r.type, service: r.service }))).toEqual([
            { type: 'Domain Name', service: 'API Gateway' },
            { type: 'API', service: 'API Gateway' },
            { type: 'User Pool', service: 'Cognito' },
            { type: 'Unknown', service: 'Unknown' },
        ]);
    });

    it('logs and skips a deployment whose ACM lookup fails after assuming the role', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({
            getCertificate: vi.fn().mockResolvedValue({ id: 'cert-1' }),
            listDeployments: vi.fn().mockResolvedValue([
                { accountId: 'acc-1', region: 'us-east-1', acmArn: 'arn:1' },
            ]),
        } as any);
        vi.mocked(getTenantClient).mockReturnValue({
            account: { findMany: vi.fn().mockResolvedValue([{ accountId: 'acc-1', name: 'Prod', roleArn: 'arn:role', externalId: null }]) },
        } as any);
        vi.mocked(assumeAccountRole).mockResolvedValue({ accessKeyId: 'x' } as any);
        vi.mocked(describeAcmCertificate).mockRejectedValue(new Error('ACM throttled'));

        const res = await GET({} as any, makeParams('cert-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data.resources).toEqual([]);
    });

    it('skips a deployment whose account metadata is missing, without failing the request', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({
            getCertificate: vi.fn().mockResolvedValue({ id: 'cert-1' }),
            listDeployments: vi.fn().mockResolvedValue([
                { accountId: 'acc-orphaned', region: 'us-east-1', acmArn: 'arn:aws:acm:us-east-1:123:certificate/abc' },
            ]),
        } as any);
        vi.mocked(getTenantClient).mockReturnValue({
            account: { findMany: vi.fn().mockResolvedValue([]) },
        } as any);

        const res = await GET({} as any, makeParams('cert-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data.resources).toEqual([]);
        expect(assumeAccountRole).not.toHaveBeenCalled();
    });

    it('continues past a per-account AWS lookup failure and returns the resources it could resolve', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({
            getCertificate: vi.fn().mockResolvedValue({ id: 'cert-1' }),
            listDeployments: vi.fn().mockResolvedValue([
                { accountId: 'acc-1', region: 'us-east-1', acmArn: 'arn:1' },
            ]),
        } as any);
        vi.mocked(getTenantClient).mockReturnValue({
            account: { findMany: vi.fn().mockResolvedValue([{ accountId: 'acc-1', name: 'Prod', roleArn: 'arn:role', externalId: null }]) },
        } as any);
        vi.mocked(assumeAccountRole).mockRejectedValue(new Error('AssumeRole denied'));

        const res = await GET({} as any, makeParams('cert-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data.resources).toEqual([]);
    });

    it('returns 500 when the repository throws', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({
            getCertificate: vi.fn().mockRejectedValue(new Error('DB down')),
        } as any);

        const res = await GET({} as any, makeParams('cert-1'));
        expect(res.status).toBe(500);
    });
});
