import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';

vi.mock('@/lib/db/pg-config', () => ({
    getPrismaClient: vi.fn(),
}));

import { getPrismaClient } from '@/lib/db/pg-config';
import { AccountPostgresRepository } from './postgres';

type MockAccount = {
    findMany: MockedFunction<(...args: unknown[]) => unknown>;
    count: MockedFunction<(...args: unknown[]) => unknown>;
    findFirst: MockedFunction<(...args: unknown[]) => unknown>;
    create: MockedFunction<(...args: unknown[]) => unknown>;
    update: MockedFunction<(...args: unknown[]) => unknown>;
    deleteMany: MockedFunction<(...args: unknown[]) => unknown>;
};

const makeRow = (overrides: Partial<{
    id: string;
    accountId: string;
    name: string;
    active: boolean;
    tenantId: string;
    roleArn: string;
    regions: string[];
    connectionStatus: string;
    createdAt: Date;
    updatedAt: Date;
    createdBy: string;
    updatedBy: string;
    externalId: string | null;
    description: string | null;
    connectionError: string | null;
}> = {}) => ({
    id: 'cuid-1',
    accountId: 'acc-1',
    name: 'Test Account',
    active: true,
    tenantId: 'org-default',
    roleArn: 'arn:aws:iam::123:role/test',
    regions: ['us-east-1'],
    connectionStatus: 'unknown',
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    createdBy: 'system',
    updatedBy: 'system',
    externalId: null,
    description: null,
    connectionError: null,
    ...overrides,
});

describe('AccountPostgresRepository', () => {
    let repo: AccountPostgresRepository;
    let mockAccount: MockAccount;

    beforeEach(() => {
        mockAccount = {
            findMany: vi.fn(),
            count: vi.fn(),
            findFirst: vi.fn(),
            create: vi.fn(),
            update: vi.fn(),
            deleteMany: vi.fn(),
        };
        vi.mocked(getPrismaClient).mockReturnValue({ account: mockAccount } as never);
        repo = new AccountPostgresRepository();
    });

    describe('getAccounts', () => {
        it('queries only by tenantId when no filters provided', async () => {
            mockAccount.count.mockResolvedValueOnce(1);
            mockAccount.findMany.mockResolvedValueOnce([makeRow()]);

            const result = await repo.getAccounts({ tenantId: 'org-default' });

            expect(mockAccount.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ tenantId: 'org-default' }),
                })
            );
            expect(result.totalCount).toBe(1);
            expect(result.accounts).toHaveLength(1);
        });

        it('adds OR array with ILIKE conditions when searchTerm is provided', async () => {
            mockAccount.count.mockResolvedValueOnce(1);
            mockAccount.findMany.mockResolvedValueOnce([makeRow()]);

            await repo.getAccounts({ tenantId: 'org-default', searchTerm: 'test' });

            expect(mockAccount.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        OR: expect.arrayContaining([
                            { name: expect.objectContaining({ contains: 'test', mode: 'insensitive' }) },
                            { accountId: expect.objectContaining({ contains: 'test', mode: 'insensitive' }) },
                        ]),
                    }),
                })
            );
        });

        it('sets where.active=true when statusFilter is active', async () => {
            mockAccount.count.mockResolvedValueOnce(1);
            mockAccount.findMany.mockResolvedValueOnce([makeRow()]);

            await repo.getAccounts({ tenantId: 'org-default', statusFilter: 'active' });

            expect(mockAccount.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ active: true }),
                })
            );
        });

        it('sets where.active=false when statusFilter is inactive', async () => {
            mockAccount.count.mockResolvedValueOnce(0);
            mockAccount.findMany.mockResolvedValueOnce([]);

            await repo.getAccounts({ tenantId: 'org-default', statusFilter: 'inactive' });

            expect(mockAccount.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ active: false }),
                })
            );
        });

        it('returns correct totalCount from count query', async () => {
            mockAccount.count.mockResolvedValueOnce(42);
            mockAccount.findMany.mockResolvedValueOnce([makeRow()]);

            const result = await repo.getAccounts({ tenantId: 'org-default' });

            expect(result.totalCount).toBe(42);
        });
    });

    describe('getAccount', () => {
        it('returns null when findFirst returns null', async () => {
            mockAccount.findFirst.mockResolvedValueOnce(null);

            const result = await repo.getAccount('acc-missing', 'org-default');

            expect(result).toBeNull();
        });

        it('returns UIAccount shape when record found', async () => {
            const row = makeRow({ accountId: 'acc-found', name: 'Found Account' });
            mockAccount.findFirst.mockResolvedValueOnce(row);

            const result = await repo.getAccount('acc-found', 'org-default');

            expect(result).not.toBeNull();
            expect(result!.accountId).toBe('acc-found');
            expect(result!.name).toBe('Found Account');
        });
    });

    describe('createAccount', () => {
        it('calls prisma.account.create and returns UIAccount shape', async () => {
            const row = makeRow({ accountId: 'acc-new', name: 'New Account' });
            mockAccount.create.mockResolvedValueOnce(row);

            const result = await repo.createAccount(
                {
                    accountId: 'acc-new',
                    name: 'New Account',
                    roleArn: 'arn:aws:iam::789:role/test',
                    regions: ['us-west-2'],
                    active: true,
                    description: '',
                    connectionStatus: 'unknown',
                    resourceCount: 0,
                    schedulesCount: 0,
                    monthlySavings: 0,
                    tags: [],
                },
                'org-default'
            );

            expect(mockAccount.create).toHaveBeenCalledTimes(1);
            expect(result.accountId).toBe('acc-new');
            expect(result.name).toBe('New Account');
        });

        it('passes tenantId and accountId to prisma create', async () => {
            const row = makeRow({ accountId: 'acc-create-check', tenantId: 'tenant-xyz' });
            mockAccount.create.mockResolvedValueOnce(row);

            await repo.createAccount(
                {
                    accountId: 'acc-create-check',
                    name: 'Check Account',
                    roleArn: 'arn:aws:iam::111:role/test',
                    regions: [],
                    active: true,
                    description: '',
                    connectionStatus: 'unknown',
                    resourceCount: 0,
                    schedulesCount: 0,
                    monthlySavings: 0,
                    tags: [],
                },
                'tenant-xyz'
            );

            expect(mockAccount.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        tenantId: 'tenant-xyz',
                        accountId: 'acc-create-check',
                    }),
                })
            );
        });
    });
});
