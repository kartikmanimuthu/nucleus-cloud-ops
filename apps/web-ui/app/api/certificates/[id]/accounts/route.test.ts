import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/repository-factory', () => ({ getCertificateRepository: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/db/pg-config', () => ({ getTenantClient: vi.fn() }));

import { getCertificateRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { getTenantClient } from '@/lib/db/pg-config';
import { GET } from './route';

const makeParams = (id: string) => ({ params: Promise.resolve({ id }) });

describe('GET /api/certificates/[id]/accounts', () => {
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
        vi.mocked(getCertificateRepository).mockReturnValue({ getCertificate: vi.fn().mockResolvedValue(null) } as any);
        const res = await GET({} as any, makeParams('cert-missing'));
        expect(res.status).toBe(404);
    });

    it('returns an empty account list when there are no deployments', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({
            getCertificate: vi.fn().mockResolvedValue({ id: 'cert-1' }),
            listDeployments: vi.fn().mockResolvedValue([]),
        } as any);

        const res = await GET({} as any, makeParams('cert-1'));
        const body = await res.json();
        expect(body.data.accounts).toEqual([]);
    });

    it('aggregates multi-region deployments per account, taking the worst link state and earliest expiry', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({
            getCertificate: vi.fn().mockResolvedValue({ id: 'cert-1' }),
            listDeployments: vi.fn().mockResolvedValue([
                { accountId: 'acc-1', region: 'us-east-1', acmArn: 'arn:1', acmNotAfter: '2025-06-01', acmStatus: 'ISSUED', linkState: 'deployed', inUseByCount: 2, lastScannedAt: '2024-06-01' },
                { accountId: 'acc-1', region: 'eu-west-1', acmArn: 'arn:2', acmNotAfter: '2025-01-01', acmStatus: 'ISSUED', linkState: 'error', inUseByCount: 1, lastScannedAt: '2024-06-02' },
            ]),
        } as any);
        vi.mocked(getTenantClient).mockReturnValue({
            account: { findMany: vi.fn().mockResolvedValue([{ accountId: 'acc-1', name: 'Prod', regions: [], connectionStatus: 'connected', active: true }]) },
        } as any);

        const res = await GET({} as any, makeParams('cert-1'));
        const body = await res.json();
        const acc = body.data.accounts[0];

        expect(acc.accountId).toBe('acc-1');
        expect(acc.linkState).toBe('error');
        expect(acc.acmNotAfter).toBe('2025-01-01');
        expect(acc.resourceCount).toBe(3);
        expect(acc.deployments).toHaveLength(2);
    });

    it('returns 500 when the repository throws', async () => {
        vi.mocked(getCertificateRepository).mockReturnValue({
            getCertificate: vi.fn().mockRejectedValue(new Error('DB down')),
        } as any);

        const res = await GET({} as any, makeParams('cert-1'));
        expect(res.status).toBe(500);
    });
});
