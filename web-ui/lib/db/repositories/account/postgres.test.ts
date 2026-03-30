import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';

vi.mock('@/lib/db/pg-config', () => ({
    getPrismaClient: vi.fn(),
}));

import { getPrismaClient } from '@/lib/db/pg-config';
import { AccountPostgresRepository } from './postgres';

const makeRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'cuid-1',
    accountId: 'acc-1',
    name: 'Test Account',
    active: true,
    regions: ['us-east-1'],
    roleArn: 'arn:aws:iam::123456789012:role/NucleusRole',
    tenantId: 'org-default',
    connectionStatus: 'connected',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-02T00:00:00Z'),
    createdBy: 'system',
    updatedBy: 'system',
    externalId: null,
    description: null,
    connectionError: null,
    ...overrides,
});

describe('AccountPostgresRepository', () => {
    let mockPrisma: {
        account: {
            findMany: MockedFunction<any>;
            count: MockedFunction<any>;
            findFirst: MockedFunction<any>;
            create: MockedFunction<any>;
            update: MockedFunction<any>;
            deleteMany: MockedFunction<any>;
        };
    };

    beforeEach(() => {
        mockPrisma = {
            account: {
                findMany: vi.fn(),
                count: vi.fn(),
                findFirst: vi.fn(),
                create: vi.fn(),
                update: vi.fn(),
                deleteMany: vi.fn(),
            },
        };
        vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as any);
    });

    describe('getAccounts', () => {
        it('queries only by tenantId when no filters provided', async () => {
            mockPrisma.account.count.mockResolvedValue(1);
            mockPrisma.account.findMany.mockResolvedValue([makeRow()]);

            const repo = new AccountPostgresRepository();
            const result = await repo.getAccounts({ tenantId: 'org-default' });

            expect(mockPrisma.account.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ tenantId: 'org-default' }),
                })
            );
            expect(result.totalCount).toBe(1);
            expect(result.accounts).toHaveLength(1);
            expect(result.accounts[0].accountId).toBe('acc-1');
        });

        it('adds OR array with ILIKE when searchTerm is provided', async () => {
            mockPrisma.account.count.mockResolvedValue(1);
            mockPrisma.account.findMany.mockResolvedValue([makeRow()]);

            const repo = new AccountPostgresRepository();
            await repo.getAccounts({ tenantId: 'org-default', searchTerm: 'acme' });

            const callArg = mockPrisma.account.findMany.mock.calls[0][0];
            expect(callArg.where.OR).toBeDefined();
            expect(callArg.where.OR).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ name: expect.objectContaining({ contains: 'acme', mode: 'insensitive' }) }),
                ])
            );
        });

        it('sets where.active=true for statusFilter="active"', async () => {
            mockPrisma.account.count.mockResolvedValue(1);
            mockPrisma.account.findMany.mockResolvedValue([makeRow({ active: true })]);

            const repo = new AccountPostgresRepository();
            await repo.getAccounts({ tenantId: 'org-default', statusFilter: 'active' });

            const callArg = mockPrisma.account.findMany.mock.calls[0][0];
            expect(callArg.where.active).toBe(true);
        });

        it('sets where.active=false for statusFilter="inactive"', async () => {
            mockPrisma.account.count.mockResolvedValue(1);
            mockPrisma.account.findMany.mockResolvedValue([makeRow({ active: false })]);

            const repo = new AccountPostgresRepository();
            await repo.getAccounts({ tenantId: 'org-default', statusFilter: 'inactive' });

            const callArg = mockPrisma.account.findMany.mock.calls[0][0];
            expect(callArg.where.active).toBe(false);
        });

        it('does NOT add active filter when statusFilter is "all"', async () => {
            mockPrisma.account.count.mockResolvedValue(2);
            mockPrisma.account.findMany.mockResolvedValue([makeRow(), makeRow({ id: 'cuid-2', accountId: 'acc-2', active: false })]);

            const repo = new AccountPostgresRepository();
            await repo.getAccounts({ tenantId: 'org-default', statusFilter: 'all' });

            const callArg = mockPrisma.account.findMany.mock.calls[0][0];
            expect(callArg.where.active).toBeUndefined();
        });

        it('applies pagination via skip and take', async () => {
            mockPrisma.account.count.mockResolvedValue(20);
            mockPrisma.account.findMany.mockResolvedValue([]);

            const repo = new AccountPostgresRepository();
            await repo.getAccounts({ tenantId: 'org-default', page: 3, limit: 5 });

            const callArg = mockPrisma.account.findMany.mock.calls[0][0];
            expect(callArg.skip).toBe(10); // (3-1) * 5
            expect(callArg.take).toBe(5);
        });
    });

    describe('getAccount', () => {
        it('returns null when findFirst returns null', async () => {
            mockPrisma.account.findFirst.mockResolvedValue(null);

            const repo = new AccountPostgresRepository();
            const result = await repo.getAccount('acc-missing', 'org-default');

            expect(result).toBeNull();
        });

        it('returns UIAccount when record is found', async () => {
            mockPrisma.account.findFirst.mockResolvedValue(makeRow({ name: 'Acme Corp' }));

            const repo = new AccountPostgresRepository();
            const result = await repo.getAccount('acc-1', 'org-default');

            expect(result).not.toBeNull();
            expect(result!.name).toBe('Acme Corp');
            expect(result!.accountId).toBe('acc-1');
        });

        it('includes tenantId in the findFirst where clause', async () => {
            mockPrisma.account.findFirst.mockResolvedValue(null);

            const repo = new AccountPostgresRepository();
            await repo.getAccount('acc-1', 'my-tenant');

            expect(mockPrisma.account.findFirst).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ tenantId: 'my-tenant', accountId: 'acc-1' }),
                })
            );
        });
    });

    describe('createAccount', () => {
        it('calls prisma.account.create and returns mapped UIAccount', async () => {
            mockPrisma.account.create.mockResolvedValue(
                makeRow({ name: 'New Account', accountId: 'acc-new' })
            );

            const repo = new AccountPostgresRepository();
            const result = await repo.createAccount(
                {
                    accountId: 'acc-new',
                    name: 'New Account',
                    roleArn: 'arn:aws:iam::111:role/R',
                    regions: ['eu-west-1'],
                    active: true,
                    connectionStatus: 'unknown',
                    createdBy: 'alice',
                    updatedBy: 'alice',
                    tags: [],
                    description: '',
                    lastValidated: '',
                    resourceCount: 0,
                    schedulesCount: 0,
                    monthlySavings: 0,
                },
                'org-default'
            );

            expect(mockPrisma.account.create).toHaveBeenCalledOnce();
            expect(result.name).toBe('New Account');
        });
    });
});

describe('AccountPostgresRepository — updateAccount', () => {
    let mockPrisma: {
        account: {
            update: MockedFunction<any>;
        };
    };

    beforeEach(() => {
        mockPrisma = {
            account: {
                update: vi.fn(),
            },
        };
        vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as any);
    });

    it('calls update with tenantId_accountId composite key', async () => {
        mockPrisma.account.update.mockResolvedValue(makeRow({ name: 'Updated Name' }));

        const repo = new AccountPostgresRepository();
        await repo.updateAccount('acc-1', { name: 'Updated Name' }, 'org-default');

        expect(mockPrisma.account.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { tenantId_accountId: { tenantId: 'org-default', accountId: 'acc-1' } },
            })
        );
    });

    it('only includes defined fields in data payload', async () => {
        mockPrisma.account.update.mockResolvedValue(makeRow({ active: false }));

        const repo = new AccountPostgresRepository();
        await repo.updateAccount('acc-1', { active: false }, 'org-default');

        const callArg = mockPrisma.account.update.mock.calls[0][0];
        expect(callArg.data.active).toBe(false);
        expect(callArg.data.name).toBeUndefined();
    });

    it('returns mapped UIAccount after update', async () => {
        mockPrisma.account.update.mockResolvedValue(makeRow({ name: 'Renamed', connectionStatus: 'connected' }));

        const repo = new AccountPostgresRepository();
        const result = await repo.updateAccount('acc-1', { name: 'Renamed' }, 'org-default');

        expect(result.name).toBe('Renamed');
        expect(result.accountId).toBe('acc-1');
    });

    it('throws wrapped error when prisma update fails', async () => {
        mockPrisma.account.update.mockRejectedValue(new Error('Record not found'));

        const repo = new AccountPostgresRepository();
        await expect(repo.updateAccount('acc-missing', { name: 'X' }, 'org-default')).rejects.toThrow(
            'Failed to update account'
        );
    });
});

describe('AccountPostgresRepository — deleteAccount', () => {
    let mockPrisma: {
        account: {
            deleteMany: MockedFunction<any>;
        };
    };

    beforeEach(() => {
        mockPrisma = {
            account: {
                deleteMany: vi.fn(),
            },
        };
        vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as any);
    });

    it('calls deleteMany with tenantId and accountId in where clause', async () => {
        mockPrisma.account.deleteMany.mockResolvedValue({ count: 1 });

        const repo = new AccountPostgresRepository();
        await repo.deleteAccount('acc-del', 'org-default');

        expect(mockPrisma.account.deleteMany).toHaveBeenCalledWith({
            where: { tenantId: 'org-default', accountId: 'acc-del' },
        });
    });

    it('does not throw when deleteMany returns count=0 (already deleted)', async () => {
        mockPrisma.account.deleteMany.mockResolvedValue({ count: 0 });

        const repo = new AccountPostgresRepository();
        await expect(repo.deleteAccount('acc-gone', 'org-default')).resolves.toBeUndefined();
    });

    it('throws wrapped error when deleteMany fails', async () => {
        mockPrisma.account.deleteMany.mockRejectedValue(new Error('DB error'));

        const repo = new AccountPostgresRepository();
        await expect(repo.deleteAccount('acc-1', 'org-default')).rejects.toThrow('Failed to delete account');
    });
});

describe('AccountPostgresRepository — getAccounts connectionFilter and defaults', () => {
    let mockPrisma: {
        account: {
            findMany: MockedFunction<any>;
            count: MockedFunction<any>;
        };
    };

    beforeEach(() => {
        mockPrisma = {
            account: {
                findMany: vi.fn().mockResolvedValue([]),
                count: vi.fn().mockResolvedValue(0),
            },
        };
        vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as any);
    });

    it('sets where.connectionStatus when connectionFilter is not "all"', async () => {
        const repo = new AccountPostgresRepository();
        await repo.getAccounts({ tenantId: 'org-default', connectionFilter: 'connected' });

        const callArg = mockPrisma.account.findMany.mock.calls[0][0];
        expect(callArg.where.connectionStatus).toBe('connected');
    });

    it('does NOT set where.connectionStatus when connectionFilter is "all"', async () => {
        const repo = new AccountPostgresRepository();
        await repo.getAccounts({ tenantId: 'org-default', connectionFilter: 'all' });

        const callArg = mockPrisma.account.findMany.mock.calls[0][0];
        expect(callArg.where.connectionStatus).toBeUndefined();
    });

    it('uses page=1 and limit=10 as defaults when not provided', async () => {
        const repo = new AccountPostgresRepository();
        await repo.getAccounts({ tenantId: 'org-default' });

        const callArg = mockPrisma.account.findMany.mock.calls[0][0];
        expect(callArg.skip).toBe(0); // (1-1) * 10
        expect(callArg.take).toBe(10);
    });

    it('orders results by createdAt desc', async () => {
        const repo = new AccountPostgresRepository();
        await repo.getAccounts({ tenantId: 'org-default' });

        const callArg = mockPrisma.account.findMany.mock.calls[0][0];
        expect(callArg.orderBy).toEqual({ createdAt: 'desc' });
    });
});

describe('AccountPostgresRepository — cross-tenant isolation', () => {
    let mockPrisma: { account: { findMany: MockedFunction<any>; count: MockedFunction<any>; findUnique: MockedFunction<any>; create: MockedFunction<any>; update: MockedFunction<any>; delete: MockedFunction<any> } };

    beforeEach(() => {
        mockPrisma = {
            account: {
                findMany: vi.fn().mockResolvedValue([]),
                count: vi.fn().mockResolvedValue(0),
                findUnique: vi.fn().mockResolvedValue(null),
                create: vi.fn(),
                update: vi.fn(),
                delete: vi.fn(),
            },
        };
        vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as any);
    });

    it('getAccounts for tenant-A never returns tenant-B records', async () => {
        // Arrange: mock returns empty for tenant-A (simulating no cross-tenant leak)
        mockPrisma.account.count.mockResolvedValue(0);
        mockPrisma.account.findMany.mockResolvedValue([]);

        // Act
        const repo = new AccountPostgresRepository();
        const result = await repo.getAccounts({ tenantId: 'tenant-a' });

        // Assert: findMany was called with tenantId='tenant-a' in WHERE clause
        expect(mockPrisma.account.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ tenantId: 'tenant-a' }),
            })
        );
        expect(result.accounts).toHaveLength(0);
        expect(result.totalCount).toBe(0);
    });

    it('getAccounts queries do not include a different tenantId in the WHERE clause', async () => {
        mockPrisma.account.count.mockResolvedValue(2);
        mockPrisma.account.findMany.mockResolvedValue([
            { id: 'c1', accountId: 'acc-1', name: 'Acme Corp', active: true, regions: ['us-east-1'], roleArn: 'arn:aws:iam::111:role/r', tenantId: 'tenant-a', connectionStatus: 'connected', createdAt: new Date(), updatedAt: new Date(), createdBy: 'system', updatedBy: 'system', externalId: null, description: null, connectionError: null },
            { id: 'c2', accountId: 'acc-2', name: 'Beta Inc', active: false, regions: ['us-west-2'], roleArn: 'arn:aws:iam::222:role/r', tenantId: 'tenant-a', connectionStatus: 'unknown', createdAt: new Date(), updatedAt: new Date(), createdBy: 'admin', updatedBy: 'admin', externalId: null, description: null, connectionError: null },
        ]);

        const repo = new AccountPostgresRepository();
        const result = await repo.getAccounts({ tenantId: 'tenant-a' });

        // The WHERE clause must contain tenant-a, NOT tenant-b
        const callArg = mockPrisma.account.findMany.mock.calls[0][0];
        expect(callArg.where.tenantId).toBe('tenant-a');
        expect(callArg.where.tenantId).not.toBe('tenant-b');
        expect(result.accounts).toHaveLength(2);
    });

    it('getAccount for tenant-A does not expose tenant-B record', async () => {
        // findFirst returns null (tenant-B record not found under tenant-A lookup)
        // Note: getAccount uses findFirst with { where: { tenantId, accountId } }
        const mockPrismaWithFindFirst = {
            account: {
                findFirst: vi.fn().mockResolvedValue(null),
            },
        };
        vi.mocked(getPrismaClient).mockReturnValue(mockPrismaWithFindFirst as any);

        const repo = new AccountPostgresRepository();
        const result = await repo.getAccount('acc-tenant-b', 'tenant-a');

        expect(mockPrismaWithFindFirst.account.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ tenantId: 'tenant-a', accountId: 'acc-tenant-b' }),
            })
        );
        expect(result).toBeNull();
    });
});
