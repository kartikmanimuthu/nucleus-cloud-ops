import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
    mockFindMany, mockCount, mockFindUnique, mockCreate, mockUpdate,
    mockVersionFindMany, mockVersionFindFirst, mockVersionCreate, mockVersionUpdate,
    mockVersionUpdateMany, mockVersionDeleteMany,
    mockDeploymentFindFirst, mockDeploymentFindMany, mockDeploymentCreate, mockDeploymentUpdate,
    mockDeploymentDeleteMany,
    mockExecutionFindMany, mockExecutionCreate, mockExecutionUpdateMany, mockExecutionDeleteMany,
    mockCertDelete, mockTransaction,
} = vi.hoisted(() => ({
    mockFindMany: vi.fn(), mockCount: vi.fn(), mockFindUnique: vi.fn(), mockCreate: vi.fn(), mockUpdate: vi.fn(),
    mockVersionFindMany: vi.fn(), mockVersionFindFirst: vi.fn(), mockVersionCreate: vi.fn(),
    mockVersionUpdate: vi.fn(), mockVersionUpdateMany: vi.fn(), mockVersionDeleteMany: vi.fn(),
    mockDeploymentFindFirst: vi.fn(), mockDeploymentFindMany: vi.fn(), mockDeploymentCreate: vi.fn(),
    mockDeploymentUpdate: vi.fn(), mockDeploymentDeleteMany: vi.fn(),
    mockExecutionFindMany: vi.fn(), mockExecutionCreate: vi.fn(), mockExecutionUpdateMany: vi.fn(),
    mockExecutionDeleteMany: vi.fn(),
    mockCertDelete: vi.fn(), mockTransaction: vi.fn(),
}));

const db = {
    certificate: { findMany: mockFindMany, count: mockCount, findUnique: mockFindUnique, create: mockCreate, update: mockUpdate, delete: mockCertDelete },
    certificateVersion: {
        findMany: mockVersionFindMany, findFirst: mockVersionFindFirst, create: mockVersionCreate,
        update: mockVersionUpdate, updateMany: mockVersionUpdateMany, deleteMany: mockVersionDeleteMany,
    },
    certificateDeployment: {
        findFirst: mockDeploymentFindFirst, findMany: mockDeploymentFindMany, create: mockDeploymentCreate,
        update: mockDeploymentUpdate, deleteMany: mockDeploymentDeleteMany,
    },
    certificateExecution: {
        findMany: mockExecutionFindMany, create: mockExecutionCreate, updateMany: mockExecutionUpdateMany,
        deleteMany: mockExecutionDeleteMany,
    },
    $transaction: mockTransaction,
};

// andWhere is real (imported via importOriginal) — it's pure, and stubbing it would hide the
// row-filter composition listCertificates depends on for Gate 3 tenant-scoping.
vi.mock('@/lib/db/pg-config', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/db/pg-config')>()),
    getTenantClient: () => db,
}));

import { CertificatePostgresRepository } from './postgres';

const repo = new CertificatePostgresRepository();

beforeEach(() => {
    vi.clearAllMocks();
    mockTransaction.mockImplementation((cb: (tx: typeof db) => unknown) => cb(db));
});

const CERT_ROW = {
    id: 'cert-1', tenantId: 'tenant-1', name: 'example.com', domainName: 'example.com',
    activeVersionId: 'v-1', status: 'active', issuer: 'Amazon', notBefore: new Date('2026-01-01'),
    notAfter: new Date('2027-01-01'), createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
    createdBy: 'a@b.com',
};

const VERSION_ROW = {
    id: 'v-1', tenantId: 'tenant-1', certificateId: 'cert-1', version: 1, isActive: true, issuer: 'Amazon',
    notBefore: new Date('2026-01-01'), notAfter: new Date('2027-01-01'), fingerprint: 'fp-1', serialNumber: 'sn-1',
    s3BodyKey: 'body-key', s3ChainKey: 'chain-key', s3PrivateKeyKey: 'pk-key', status: 'active',
    uploadedAt: new Date('2026-01-01'), uploadedBy: 'a@b.com',
};

const DEPLOYMENT_ROW = {
    id: 'd-1', tenantId: 'tenant-1', certificateId: 'cert-1', accountId: 'acct-1', region: 'ap-south-1',
    acmArn: 'arn:aws:acm:cert/1', acmDomainName: 'example.com', acmNotAfter: new Date('2027-01-01'),
    acmStatus: 'ISSUED', deployedVersionId: 'v-1', linkState: 'linked', inUseByCount: 2,
    lastScannedAt: new Date('2026-01-01'), lastDeployedAt: new Date('2026-01-01'),
};

const EXECUTION_ROW = {
    id: 'e-1', tenantId: 'tenant-1', certificateId: 'cert-1', executionId: 'exec-1', operation: 'deploy',
    versionId: 'v-1', accountId: 'acct-1', region: 'ap-south-1', status: 'running', acmArn: null,
    message: null, details: null, startedAt: new Date('2026-01-01'), finishedAt: null, duration: null,
    triggeredBy: 'a@b.com', expiresAt: new Date('2027-01-01'),
};

describe('listCertificates', () => {
    beforeEach(() => {
        mockFindMany.mockResolvedValue([CERT_ROW]);
        mockCount.mockResolvedValue(1);
    });

    it('always scopes by tenantId and defaults page/limit', async () => {
        await repo.listCertificates({ tenantId: 'tenant-1' });

        const call = mockFindMany.mock.calls[0][0];
        expect(call.where.tenantId).toBe('tenant-1');
        expect(call.skip).toBe(0);
        expect(call.take).toBe(50);
    });

    it('filters by status and searches name/domainName case-insensitively', async () => {
        await repo.listCertificates({ tenantId: 'tenant-1', status: 'expiring_soon', searchTerm: 'example' });

        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.status).toBe('expiring_soon');
        expect(where.OR).toEqual([
            { name: { contains: 'example', mode: 'insensitive' } },
            { domainName: { contains: 'example', mode: 'insensitive' } },
        ]);
    });

    it('intersects a Gate-3 row filter under AND without discarding the search OR clause', async () => {
        await repo.listCertificates({
            tenantId: 'tenant-1', searchTerm: 'example', rowFilter: { accountId: { in: ['acct-1'] } },
        });

        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.OR).toBeDefined();
        expect(where.AND).toEqual([{ accountId: { in: ['acct-1'] } }]);
    });

    it('paginates using (page-1)*limit as skip', async () => {
        await repo.listCertificates({ tenantId: 'tenant-1', page: 3, limit: 10 });
        expect(mockFindMany.mock.calls[0][0].skip).toBe(20);
        expect(mockFindMany.mock.calls[0][0].take).toBe(10);
    });

    it('returns the transformed page and total', async () => {
        const result = await repo.listCertificates({ tenantId: 'tenant-1' });
        expect(result).toEqual({ certificates: [expect.objectContaining({ id: 'cert-1' })], total: 1 });
    });
});

describe('getCertificate', () => {
    it('returns the transformed certificate when found', async () => {
        mockFindUnique.mockResolvedValue(CERT_ROW);
        const result = await repo.getCertificate('tenant-1', 'cert-1');
        expect(result?.id).toBe('cert-1');
        expect(mockFindUnique).toHaveBeenCalledWith({ where: { id: 'cert-1', tenantId: 'tenant-1' } });
    });

    it('returns null when not found', async () => {
        mockFindUnique.mockResolvedValue(null);
        expect(await repo.getCertificate('tenant-1', 'missing')).toBeNull();
    });

    it('formats null notBefore/notAfter as null rather than throwing', async () => {
        mockFindUnique.mockResolvedValue({ ...CERT_ROW, notBefore: null, notAfter: null });
        const result = await repo.getCertificate('tenant-1', 'cert-1');
        expect(result?.notBefore).toBeNull();
        expect(result?.notAfter).toBeNull();
    });
});

describe('createWithInitialVersion', () => {
    it('creates the certificate and its version 1 inside one transaction, then activates it', async () => {
        mockCreate.mockResolvedValue(CERT_ROW);
        mockVersionCreate.mockResolvedValue(VERSION_ROW);
        mockUpdate.mockResolvedValue({ ...CERT_ROW, activeVersionId: 'v-1' });

        const result = await repo.createWithInitialVersion({
            id: 'cert-1', tenantId: 'tenant-1', name: 'example.com', domainName: 'example.com',
            status: 'active', issuer: 'Amazon', notBefore: '2026-01-01T00:00:00Z', notAfter: '2027-01-01T00:00:00Z',
            createdBy: 'a@b.com', fingerprint: 'fp-1', serialNumber: 'sn-1', s3BodyKey: 'body-key',
            s3ChainKey: 'chain-key', s3PrivateKeyKey: 'pk-key',
        });

        expect(mockCreate).toHaveBeenCalledTimes(1);
        expect(mockVersionCreate).toHaveBeenCalledTimes(1);
        expect(mockUpdate).toHaveBeenCalledWith({
            where: { id: 'cert-1', tenantId: 'tenant-1' },
            data: { activeVersionId: 'v-1' },
        });
        expect(result.certificate.id).toBe('cert-1');
        expect(result.version.id).toBe('v-1');
    });

    it('stores a null notBefore when the input omits it', async () => {
        mockCreate.mockResolvedValue(CERT_ROW);
        mockVersionCreate.mockResolvedValue(VERSION_ROW);
        mockUpdate.mockResolvedValue(CERT_ROW);

        await repo.createWithInitialVersion({
            id: 'cert-1', tenantId: 'tenant-1', name: 'example.com', domainName: 'example.com',
            status: 'active', issuer: null, notAfter: '2027-01-01T00:00:00Z', createdBy: 'a@b.com',
            fingerprint: null, serialNumber: null, s3BodyKey: 'body-key', s3ChainKey: null, s3PrivateKeyKey: 'pk-key',
        } as never);

        expect(mockCreate.mock.calls[0][0].data.notBefore).toBeNull();
        expect(mockVersionCreate.mock.calls[0][0].data.notBefore).toBeNull();
    });
});

describe('deleteCertificate', () => {
    it('deletes executions, deployments, detaches the active pointer, then versions, then the certificate', async () => {
        await repo.deleteCertificate('tenant-1', 'cert-1');

        expect(mockExecutionDeleteMany).toHaveBeenCalledWith({ where: { certificateId: 'cert-1', tenantId: 'tenant-1' } });
        expect(mockDeploymentDeleteMany).toHaveBeenCalledWith({ where: { certificateId: 'cert-1', tenantId: 'tenant-1' } });
        expect(mockUpdate).toHaveBeenCalledWith({
            where: { id: 'cert-1', tenantId: 'tenant-1' }, data: { activeVersionId: null },
        });
        expect(mockVersionDeleteMany).toHaveBeenCalledWith({ where: { certificateId: 'cert-1', tenantId: 'tenant-1' } });
        expect(mockCertDelete).toHaveBeenCalledWith({ where: { id: 'cert-1', tenantId: 'tenant-1' } });
    });
});

describe('updateCachedStatus', () => {
    it('updates only the status field, scoped by tenant', async () => {
        await repo.updateCachedStatus('tenant-1', 'cert-1', 'expired');
        expect(mockUpdate).toHaveBeenCalledWith({
            where: { id: 'cert-1', tenantId: 'tenant-1' }, data: { status: 'expired' },
        });
    });
});

describe('versions', () => {
    it('listVersions orders newest-first and scopes by tenant and certificate', async () => {
        mockVersionFindMany.mockResolvedValue([VERSION_ROW]);
        const result = await repo.listVersions('tenant-1', 'cert-1');
        expect(mockVersionFindMany).toHaveBeenCalledWith({
            where: { certificateId: 'cert-1', tenantId: 'tenant-1' }, orderBy: { version: 'desc' },
        });
        expect(result[0].id).toBe('v-1');
    });

    it('getVersion returns the transformed version when found', async () => {
        mockVersionFindFirst.mockResolvedValue(VERSION_ROW);
        const result = await repo.getVersion('tenant-1', 'cert-1', 'v-1');
        expect(result?.id).toBe('v-1');
    });

    it('getVersion returns null when not found', async () => {
        mockVersionFindFirst.mockResolvedValue(null);
        expect(await repo.getVersion('tenant-1', 'cert-1', 'v-x')).toBeNull();
    });

    it('getActiveVersion filters on isActive true', async () => {
        mockVersionFindFirst.mockResolvedValue(VERSION_ROW);
        await repo.getActiveVersion('tenant-1', 'cert-1');
        expect(mockVersionFindFirst.mock.calls[0][0].where).toEqual({
            certificateId: 'cert-1', tenantId: 'tenant-1', isActive: true,
        });
    });

    it('getActiveVersion returns null when no version is active', async () => {
        mockVersionFindFirst.mockResolvedValue(null);
        expect(await repo.getActiveVersion('tenant-1', 'cert-1')).toBeNull();
    });

    it('findVersionByFingerprint scopes by the exact fingerprint', async () => {
        mockVersionFindFirst.mockResolvedValue(VERSION_ROW);
        const result = await repo.findVersionByFingerprint('tenant-1', 'cert-1', 'fp-1');
        expect(mockVersionFindFirst.mock.calls[0][0].where.fingerprint).toBe('fp-1');
        expect(result?.fingerprint).toBe('fp-1');
    });

    it('findVersionByFingerprint returns null when no version matches', async () => {
        mockVersionFindFirst.mockResolvedValue(null);
        expect(await repo.findVersionByFingerprint('tenant-1', 'cert-1', 'fp-x')).toBeNull();
    });

    it('formats a null notBefore as null on a version', async () => {
        mockVersionFindFirst.mockResolvedValue({ ...VERSION_ROW, notBefore: null });
        const result = await repo.getVersion('tenant-1', 'cert-1', 'v-1');
        expect(result?.notBefore).toBeNull();
    });

    it('nextVersionNumber increments the top version', async () => {
        mockVersionFindFirst.mockResolvedValue({ version: 4 });
        expect(await repo.nextVersionNumber('tenant-1', 'cert-1')).toBe(5);
    });

    it('nextVersionNumber returns 1 when there are no existing versions', async () => {
        mockVersionFindFirst.mockResolvedValue(null);
        expect(await repo.nextVersionNumber('tenant-1', 'cert-1')).toBe(1);
    });

    it('createVersion always creates as inactive', async () => {
        mockVersionCreate.mockResolvedValue(VERSION_ROW);
        await repo.createVersion({
            tenantId: 'tenant-1', certificateId: 'cert-1', version: 2, issuer: 'Amazon',
            notAfter: '2027-01-01T00:00:00Z', fingerprint: 'fp-2', serialNumber: 'sn-2',
            s3BodyKey: 'body-2', s3ChainKey: null, s3PrivateKeyKey: 'pk-2', status: 'active', uploadedBy: 'a@b.com',
        } as never);
        expect(mockVersionCreate.mock.calls[0][0].data.isActive).toBe(false);
        expect(mockVersionCreate.mock.calls[0][0].data.notBefore).toBeNull();
    });

    it('createVersion converts a supplied notBefore', async () => {
        mockVersionCreate.mockResolvedValue(VERSION_ROW);
        await repo.createVersion({
            tenantId: 'tenant-1', certificateId: 'cert-1', version: 2, issuer: 'Amazon',
            notBefore: '2026-01-01T00:00:00Z', notAfter: '2027-01-01T00:00:00Z', fingerprint: 'fp-2',
            serialNumber: 'sn-2', s3BodyKey: 'body-2', s3ChainKey: null, s3PrivateKeyKey: 'pk-2',
            status: 'active', uploadedBy: 'a@b.com',
        } as never);
        expect(mockVersionCreate.mock.calls[0][0].data.notBefore).toBeInstanceOf(Date);
    });

    it('deleteVersion scopes the deleteMany by id, certificate, and tenant', async () => {
        await repo.deleteVersion('tenant-1', 'cert-1', 'v-1');
        expect(mockVersionDeleteMany).toHaveBeenCalledWith({
            where: { id: 'v-1', certificateId: 'cert-1', tenantId: 'tenant-1' },
        });
    });

    it('activateVersion clears every other active flag before activating the target, then syncs the certificate', async () => {
        mockVersionUpdate.mockResolvedValue(VERSION_ROW);
        await repo.activateVersion('tenant-1', 'cert-1', 'v-1');

        expect(mockVersionUpdateMany).toHaveBeenCalledWith({
            where: { certificateId: 'cert-1', tenantId: 'tenant-1' }, data: { isActive: false },
        });
        expect(mockVersionUpdate).toHaveBeenCalledWith({
            where: { id: 'v-1', tenantId: 'tenant-1' }, data: { isActive: true },
        });
        expect(mockUpdate).toHaveBeenCalledWith({
            where: { id: 'cert-1', tenantId: 'tenant-1' },
            data: {
                activeVersionId: 'v-1', status: VERSION_ROW.status, notAfter: VERSION_ROW.notAfter,
                notBefore: VERSION_ROW.notBefore, issuer: VERSION_ROW.issuer,
            },
        });
    });

    it('setVersionFingerprint scopes the update by tenant', async () => {
        await repo.setVersionFingerprint('tenant-1', 'v-1', 'fp-new', 'sn-new');
        expect(mockVersionUpdate).toHaveBeenCalledWith({
            where: { id: 'v-1', tenantId: 'tenant-1' }, data: { fingerprint: 'fp-new', serialNumber: 'sn-new' },
        });
    });
});

describe('deployments', () => {
    it('listDeployments orders by account then region', async () => {
        mockDeploymentFindMany.mockResolvedValue([DEPLOYMENT_ROW]);
        const result = await repo.listDeployments('tenant-1', 'cert-1');
        expect(mockDeploymentFindMany.mock.calls[0][0].orderBy).toEqual([{ accountId: 'asc' }, { region: 'asc' }]);
        expect(result[0].id).toBe('d-1');
    });

    it('getDeployment scopes by certificate, account, and region', async () => {
        mockDeploymentFindFirst.mockResolvedValue(DEPLOYMENT_ROW);
        await repo.getDeployment('tenant-1', 'cert-1', 'acct-1', 'ap-south-1');
        expect(mockDeploymentFindFirst.mock.calls[0][0].where).toEqual({
            certificateId: 'cert-1', tenantId: 'tenant-1', accountId: 'acct-1', region: 'ap-south-1',
        });
    });

    it('getDeployment returns null when no deployment exists for that account/region', async () => {
        mockDeploymentFindFirst.mockResolvedValue(null);
        expect(await repo.getDeployment('tenant-1', 'cert-1', 'acct-1', 'ap-south-1')).toBeNull();
    });

    it('findDeployedInAccount requires a non-null acmArn', async () => {
        mockDeploymentFindFirst.mockResolvedValue(DEPLOYMENT_ROW);
        await repo.findDeployedInAccount('tenant-1', 'cert-1', 'acct-1');
        expect(mockDeploymentFindFirst.mock.calls[0][0].where.acmArn).toEqual({ not: null });
    });

    it('findDeployedInAccount returns null when nothing in the account has a live ACM arn', async () => {
        mockDeploymentFindFirst.mockResolvedValue(null);
        expect(await repo.findDeployedInAccount('tenant-1', 'cert-1', 'acct-1')).toBeNull();
    });

    it('upsertDeployment updates an existing row for the same account+region', async () => {
        mockDeploymentFindFirst.mockResolvedValue({ id: 'd-1' });
        mockDeploymentUpdate.mockResolvedValue(DEPLOYMENT_ROW);

        await repo.upsertDeployment({
            tenantId: 'tenant-1', certificateId: 'cert-1', accountId: 'acct-1', region: 'ap-south-1',
            linkState: 'linked',
        });

        expect(mockDeploymentUpdate).toHaveBeenCalledTimes(1);
        expect(mockDeploymentCreate).not.toHaveBeenCalled();
        const data = mockDeploymentUpdate.mock.calls[0][0].data;
        expect(data.acmArn).toBeNull();
        expect(data.inUseByCount).toBe(0);
    });

    it('upsertDeployment creates a new row, including tenantId/certificateId/accountId/region, when none exists', async () => {
        mockDeploymentFindFirst.mockResolvedValue(null);
        mockDeploymentCreate.mockResolvedValue(DEPLOYMENT_ROW);

        await repo.upsertDeployment({
            tenantId: 'tenant-1', certificateId: 'cert-1', accountId: 'acct-1', region: 'ap-south-1',
            linkState: 'unlinked', acmArn: 'arn:aws:acm:cert/2', acmNotAfter: '2027-06-01T00:00:00Z',
            lastScannedAt: '2026-01-01T00:00:00Z', lastDeployedAt: '2026-01-02T00:00:00Z', inUseByCount: 3,
        });

        expect(mockDeploymentCreate).toHaveBeenCalledTimes(1);
        const data = mockDeploymentCreate.mock.calls[0][0].data;
        expect(data.tenantId).toBe('tenant-1');
        expect(data.certificateId).toBe('cert-1');
        expect(data.accountId).toBe('acct-1');
        expect(data.region).toBe('ap-south-1');
        expect(data.acmArn).toBe('arn:aws:acm:cert/2');
        expect(data.inUseByCount).toBe(3);
        expect(data.acmNotAfter).toBeInstanceOf(Date);
        expect(data.lastScannedAt).toBeInstanceOf(Date);
        expect(data.lastDeployedAt).toBeInstanceOf(Date);
    });

    it('deleteUnknownRegionDeployments scopes to the literal "unknown" region', async () => {
        await repo.deleteUnknownRegionDeployments('tenant-1', 'cert-1', 'acct-1');
        expect(mockDeploymentDeleteMany).toHaveBeenCalledWith({
            where: { certificateId: 'cert-1', tenantId: 'tenant-1', accountId: 'acct-1', region: 'unknown' },
        });
    });
});

describe('executions', () => {
    it('listExecutions defaults to the 50 most recent, newest-first', async () => {
        mockExecutionFindMany.mockResolvedValue([EXECUTION_ROW]);
        await repo.listExecutions('tenant-1', 'cert-1');
        expect(mockExecutionFindMany.mock.calls[0][0]).toMatchObject({
            orderBy: { startedAt: 'desc' }, take: 50,
        });
    });

    it('listExecutions honors an explicit limit', async () => {
        mockExecutionFindMany.mockResolvedValue([]);
        await repo.listExecutions('tenant-1', 'cert-1', 5);
        expect(mockExecutionFindMany.mock.calls[0][0].take).toBe(5);
    });

    it('createExecution defaults optional fields to null and binds tenantId explicitly', async () => {
        mockExecutionCreate.mockResolvedValue(EXECUTION_ROW);
        await repo.createExecution({
            tenantId: 'tenant-1', certificateId: 'cert-1', executionId: 'exec-1', operation: 'deploy',
            status: 'running', triggeredBy: 'a@b.com', expiresAt: '2027-01-01T00:00:00Z',
        });

        const data = mockExecutionCreate.mock.calls[0][0].data;
        expect(data.tenantId).toBe('tenant-1');
        expect(data.versionId).toBeNull();
        expect(data.accountId).toBeNull();
        expect(data.region).toBeNull();
        expect(data.acmArn).toBeNull();
        expect(data.message).toBeNull();
    });

    it('finishExecution sets finishedAt to now and scopes the update to executionId+tenant', async () => {
        await repo.finishExecution('tenant-1', 'exec-1', { status: 'succeeded' });

        expect(mockExecutionUpdateMany).toHaveBeenCalledTimes(1);
        const call = mockExecutionUpdateMany.mock.calls[0][0];
        expect(call.where).toEqual({ executionId: 'exec-1', tenantId: 'tenant-1' });
        expect(call.data.status).toBe('succeeded');
        expect(call.data.finishedAt).toBeInstanceOf(Date);
        expect(call.data.acmArn).toBeUndefined();
    });

    it('finishExecution passes through acmArn, message, details, and duration when given', async () => {
        await repo.finishExecution('tenant-1', 'exec-1', {
            status: 'failed', acmArn: 'arn:aws:acm:cert/1', message: 'boom', details: { code: 1 }, duration: 42,
        });

        const data = mockExecutionUpdateMany.mock.calls[0][0].data;
        expect(data.acmArn).toBe('arn:aws:acm:cert/1');
        expect(data.message).toBe('boom');
        expect(data.details).toEqual({ code: 1 });
        expect(data.duration).toBe(42);
    });
});

describe('mapper null-safety', () => {
    it('toDeploymentRecord formats null acmNotAfter/lastScannedAt/lastDeployedAt as null', async () => {
        mockDeploymentFindFirst.mockResolvedValue({
            ...DEPLOYMENT_ROW, acmNotAfter: null, lastScannedAt: null, lastDeployedAt: null,
        });
        const result = await repo.getDeployment('tenant-1', 'cert-1', 'acct-1', 'ap-south-1');
        expect(result?.acmNotAfter).toBeNull();
        expect(result?.lastScannedAt).toBeNull();
        expect(result?.lastDeployedAt).toBeNull();
    });

    it('toExecutionRecord formats a null finishedAt as null', async () => {
        mockExecutionFindMany.mockResolvedValue([EXECUTION_ROW]);
        const [result] = await repo.listExecutions('tenant-1', 'cert-1');
        expect(result.finishedAt).toBeNull();
    });

    it('toExecutionRecord converts a populated finishedAt', async () => {
        mockExecutionFindMany.mockResolvedValue([{ ...EXECUTION_ROW, finishedAt: new Date('2026-01-02T00:00:00Z') }]);
        const [result] = await repo.listExecutions('tenant-1', 'cert-1');
        expect(result.finishedAt).toBe('2026-01-02T00:00:00.000Z');
    });
});
