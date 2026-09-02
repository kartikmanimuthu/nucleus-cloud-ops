import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';

// Partial mock: only the client factories are stubbed. andWhere() is the real
// implementation — it is pure, and a stub of it would hide the row-filter
// composition this repository depends on.
vi.mock('@/lib/db/pg-config', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/db/pg-config')>()),
    getPrismaClient: vi.fn(),
    getTenantClient: vi.fn(),
}));

import { getPrismaClient, getTenantClient } from '@/lib/db/pg-config';
import { InventoryPostgresRepository } from './postgres';

const makeRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'cuid-1',
    tenantId: 'org-default',
    accountId: 'acc-1',
    region: 'us-east-1',
    resourceType: 'ec2_instances',
    resourceId: 'i-123',
    name: 'my-instance',
    status: 'running',
    tags: { Env: 'prod' },
    metadata: { instanceType: 't3.micro' },
    discoveredAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-02T00:00:00Z'),
    ...overrides,
});

describe('InventoryPostgresRepository', () => {
    let mockPrisma: {
        inventoryResource: {
            findMany: MockedFunction<any>;
            count: MockedFunction<any>;
            findUnique: MockedFunction<any>;
            upsert: MockedFunction<any>;
            deleteMany: MockedFunction<any>;
            groupBy: MockedFunction<any>;
        };
        account: {
            findFirst: MockedFunction<any>;
        };
        $transaction: MockedFunction<any>;
    };

    beforeEach(() => {
        mockPrisma = {
            inventoryResource: {
                findMany: vi.fn(),
                count: vi.fn(),
                findUnique: vi.fn(),
                upsert: vi.fn(),
                deleteMany: vi.fn(),
                groupBy: vi.fn(),
            },
            account: {
                findFirst: vi.fn().mockResolvedValue({ tenantId: 'org-default' }),
            },
            $transaction: vi.fn(),
        };
        vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as any);
        vi.mocked(getTenantClient).mockReturnValue(mockPrisma as any);
    });

    describe('listResources', () => {
        it('queries with tenantId in where clause', async () => {
            mockPrisma.inventoryResource.count.mockResolvedValue(1);
            mockPrisma.inventoryResource.findMany.mockResolvedValue([makeRow()]);

            const repo = new InventoryPostgresRepository();
            const result = await repo.listResources({ tenantId: 'org-default' });

            expect(mockPrisma.inventoryResource.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ tenantId: 'org-default' }),
                })
            );
            expect(result.total).toBe(1);
            expect(result.resources).toHaveLength(1);
        });

        it('adds accountId to where clause when provided', async () => {
            mockPrisma.inventoryResource.count.mockResolvedValue(1);
            mockPrisma.inventoryResource.findMany.mockResolvedValue([makeRow()]);

            const repo = new InventoryPostgresRepository();
            await repo.listResources({ tenantId: 'org-default', accountId: 'acc-1' });

            const callArg = mockPrisma.inventoryResource.findMany.mock.calls[0][0];
            expect(callArg.where.accountId).toBe('acc-1');
        });

        it('adds resourceType to where clause when provided', async () => {
            mockPrisma.inventoryResource.count.mockResolvedValue(1);
            mockPrisma.inventoryResource.findMany.mockResolvedValue([makeRow()]);

            const repo = new InventoryPostgresRepository();
            await repo.listResources({ tenantId: 'org-default', resourceType: 'ec2_instances' });

            const callArg = mockPrisma.inventoryResource.findMany.mock.calls[0][0];
            expect(callArg.where.resourceType).toBe('ec2_instances');
        });

        it('unrestricted searchTerm takes the raw-SQL fulltext path, not ILIKE', async () => {
            // No rowFilter → listResources delegates to listResourcesFulltext,
            // which never touches inventoryResource.findMany.
            mockPrisma.$queryRawUnsafe = vi
                .fn()
                .mockResolvedValueOnce([{ total: 0 }])
                .mockResolvedValueOnce([]);

            const repo = new InventoryPostgresRepository();
            await repo.listResources({ tenantId: 'org-default', searchTerm: 'prod' });

            expect(mockPrisma.inventoryResource.findMany).not.toHaveBeenCalled();
            expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalled();
        });

        it('adds ILIKE name/resourceId OR filter for searchTerm when a Gate 3 row filter is active', async () => {
            // $queryRawUnsafe is not intercepted by the tenant extension and a Prisma
            // `where` fragment cannot be spliced into raw SQL, so a restricted caller
            // (rowFilter present) falls back to the Prisma path even with a searchTerm.
            mockPrisma.inventoryResource.count.mockResolvedValue(1);
            mockPrisma.inventoryResource.findMany.mockResolvedValue([makeRow()]);

            const repo = new InventoryPostgresRepository();
            await repo.listResources({
                tenantId: 'org-default',
                searchTerm: 'prod',
                rowFilter: { region: 'us-east-1' },
            });

            const callArg = mockPrisma.inventoryResource.findMany.mock.calls[0][0];
            expect(callArg.where.OR).toEqual([
                { name: { contains: 'prod', mode: 'insensitive' } },
                { resourceId: { contains: 'prod', mode: 'insensitive' } },
            ]);
            expect(callArg.where.AND).toEqual(
                expect.arrayContaining([{ region: 'us-east-1' }])
            );
        });

        it('applies skip/take for pagination', async () => {
            mockPrisma.inventoryResource.count.mockResolvedValue(100);
            mockPrisma.inventoryResource.findMany.mockResolvedValue([]);

            const repo = new InventoryPostgresRepository();
            await repo.listResources({ tenantId: 'org-default', page: 3, limit: 10 });

            const callArg = mockPrisma.inventoryResource.findMany.mock.calls[0][0];
            expect(callArg.skip).toBe(20); // (3-1) * 10
            expect(callArg.take).toBe(10);
        });

        it('cross-tenant isolation — tenantId always in where clause', async () => {
            mockPrisma.inventoryResource.count.mockResolvedValue(0);
            mockPrisma.inventoryResource.findMany.mockResolvedValue([]);

            const repo = new InventoryPostgresRepository();
            await repo.listResources({ tenantId: 'tenant-x' });

            const callArg = mockPrisma.inventoryResource.findMany.mock.calls[0][0];
            expect(callArg.where.tenantId).toBe('tenant-x');
        });

        it('filters by a set of accountIds when accountId is absent', async () => {
            mockPrisma.inventoryResource.count.mockResolvedValue(0);
            mockPrisma.inventoryResource.findMany.mockResolvedValue([]);
            const repo = new InventoryPostgresRepository();
            await repo.listResources({ tenantId: 'org-default', accountIds: ['a1', 'a2'] });
            expect(mockPrisma.inventoryResource.findMany.mock.calls[0][0].where.accountId).toEqual({ in: ['a1', 'a2'] });
        });

        it('adds region to where clause when provided', async () => {
            mockPrisma.inventoryResource.count.mockResolvedValue(0);
            mockPrisma.inventoryResource.findMany.mockResolvedValue([]);
            const repo = new InventoryPostgresRepository();
            await repo.listResources({ tenantId: 'org-default', region: 'us-west-2' });
            expect(mockPrisma.inventoryResource.findMany.mock.calls[0][0].where.region).toBe('us-west-2');
        });

        it('searches name/resourceId when a searchTerm is given alongside a row filter', async () => {
            mockPrisma.inventoryResource.count.mockResolvedValue(0);
            mockPrisma.inventoryResource.findMany.mockResolvedValue([]);
            const repo = new InventoryPostgresRepository();
            await repo.listResources({ tenantId: 'org-default', searchTerm: 'prod', rowFilter: { region: 'x' } });
            expect(mockPrisma.inventoryResource.findMany.mock.calls[0][0].where.OR).toBeDefined();
        });

        it('ignores an empty rowFilter object — still takes the fulltext path', async () => {
            mockPrisma.$queryRawUnsafe = vi.fn().mockResolvedValueOnce([{ total: 0 }]).mockResolvedValueOnce([]);
            const repo = new InventoryPostgresRepository();
            await repo.listResources({ tenantId: 'org-default', searchTerm: 'prod', rowFilter: {} });
            expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalled();
            expect(mockPrisma.inventoryResource.findMany).not.toHaveBeenCalled();
        });

        it('wraps a repository failure in a descriptive error', async () => {
            mockPrisma.inventoryResource.findMany.mockRejectedValue(new Error('DB down'));
            mockPrisma.inventoryResource.count.mockRejectedValue(new Error('DB down'));
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const repo = new InventoryPostgresRepository();
            await expect(repo.listResources({ tenantId: 'org-default' })).rejects.toThrow('Failed to list resources: DB down');
            consoleSpy.mockRestore();
        });

        it('stringifies a non-Error throw in the wrapped message', async () => {
            mockPrisma.inventoryResource.findMany.mockRejectedValue('raw failure');
            mockPrisma.inventoryResource.count.mockRejectedValue('raw failure');
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const repo = new InventoryPostgresRepository();
            await expect(repo.listResources({ tenantId: 'org-default' })).rejects.toThrow('Failed to list resources: raw failure');
            consoleSpy.mockRestore();
        });

        it('filters to isCurrent = true rows', async () => {
            mockPrisma.inventoryResource.count.mockResolvedValue(1);
            mockPrisma.inventoryResource.findMany.mockResolvedValue([makeRow()]);

            const repo = new InventoryPostgresRepository();
            await repo.listResources({ tenantId: 'org-default' });

            const callArg = mockPrisma.inventoryResource.findMany.mock.calls[0][0];
            expect(callArg.where.isCurrent).toBe(true);

            const countArg = mockPrisma.inventoryResource.count.mock.calls[0][0];
            expect(countArg.where.isCurrent).toBe(true);
        });
    });

    describe('getResource', () => {
        it('returns null when not found', async () => {
            mockPrisma.inventoryResource.findUnique.mockResolvedValue(null);

            const repo = new InventoryPostgresRepository();
            const result = await repo.getResource('org-default', 'acc-1', 'ec2_instances', 'i-999');

            expect(result).toBeNull();
        });

        it('returns resource when found', async () => {
            mockPrisma.inventoryResource.findUnique.mockResolvedValue(makeRow());

            const repo = new InventoryPostgresRepository();
            const result = await repo.getResource('org-default', 'acc-1', 'ec2_instances', 'i-123');

            expect(result).not.toBeNull();
            expect(result!.resourceId).toBe('i-123');
            expect(result!.tenantId).toBe('org-default');
        });

        it('uses compound unique key with tenantId', async () => {
            mockPrisma.inventoryResource.findUnique.mockResolvedValue(null);

            const repo = new InventoryPostgresRepository();
            await repo.getResource('tenant-x', 'acc-1', 'ec2_instances', 'i-123');

            expect(mockPrisma.inventoryResource.findUnique).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        tenantId_accountId_resourceType_resourceId: expect.objectContaining({
                            tenantId: 'tenant-x',
                        }),
                    }),
                })
            );
        });

        it('wraps a repository failure in a descriptive error', async () => {
            mockPrisma.inventoryResource.findUnique.mockRejectedValue(new Error('DB down'));
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const repo = new InventoryPostgresRepository();
            await expect(repo.getResource('org-default', 'acc-1', 'ec2_instances', 'i-1'))
                .rejects.toThrow('Failed to get resource: DB down');
            consoleSpy.mockRestore();
        });
    });

    describe('upsertResource', () => {
        it('calls prisma upsert with compound unique key', async () => {
            mockPrisma.inventoryResource.upsert.mockResolvedValue(makeRow());

            const repo = new InventoryPostgresRepository();
            const result = await repo.upsertResource({
                tenantId: 'org-default',
                accountId: 'acc-1',
                region: 'us-east-1',
                resourceType: 'ec2_instances',
                resourceId: 'i-123',
                name: 'my-instance',
                status: 'running',
                tags: {},
                metadata: {},
                discoveredAt: '2024-01-01T00:00:00Z',
                updatedAt: '2024-01-01T00:00:00Z',
            });

            expect(mockPrisma.inventoryResource.upsert).toHaveBeenCalledOnce();
            const callArg = mockPrisma.inventoryResource.upsert.mock.calls[0][0];
            expect(callArg.where.tenantId_accountId_resourceType_resourceId.tenantId).toBe('org-default');
            expect(result.resourceId).toBe('i-123');
        });

        it('defaults discoveredAt to now when omitted, on create', async () => {
            mockPrisma.inventoryResource.upsert.mockResolvedValue(makeRow());
            const before = Date.now();
            const repo = new InventoryPostgresRepository();
            await repo.upsertResource({
                tenantId: 'org-default', accountId: 'acc-1', region: 'us-east-1', resourceType: 'ec2_instances',
                resourceId: 'i-1', tags: {}, metadata: {}, updatedAt: new Date().toISOString(),
            } as any);
            const discoveredAt: Date = mockPrisma.inventoryResource.upsert.mock.calls[0][0].create.discoveredAt;
            expect(discoveredAt.getTime()).toBeGreaterThanOrEqual(before);
        });

        it.each(['', 'default', 'org-default', undefined])(
            'resolves tenantId from the account when the input tenantId is %s',
            async (input) => {
                mockPrisma.account.findFirst.mockResolvedValue({ tenantId: 'resolved-tenant' });
                mockPrisma.inventoryResource.upsert.mockResolvedValue(makeRow({ tenantId: 'resolved-tenant' }));

                const repo = new InventoryPostgresRepository();
                await repo.upsertResource({
                    tenantId: input as any, accountId: 'acc-1', region: 'us-east-1', resourceType: 'ec2_instances',
                    resourceId: 'i-1', tags: {}, metadata: {}, discoveredAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
                } as any);

                expect(mockPrisma.account.findFirst).toHaveBeenCalledWith({ where: { accountId: 'acc-1' }, select: { tenantId: true } });
                expect(getTenantClient).toHaveBeenCalledWith('resolved-tenant');
            },
        );

        it('skips the upsert and returns null when no account owns the accountId (unresolvable tenant)', async () => {
            mockPrisma.account.findFirst.mockResolvedValue(null);
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const repo = new InventoryPostgresRepository();
            const result = await repo.upsertResource({
                tenantId: 'default', accountId: 'acc-orphan', region: 'us-east-1', resourceType: 'ec2_instances',
                resourceId: 'i-1', tags: {}, metadata: {}, discoveredAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            } as any);
            expect(result).toBeNull();
            expect(mockPrisma.inventoryResource.upsert).not.toHaveBeenCalled();
            consoleSpy.mockRestore();
        });

        it('wraps a repository failure in a descriptive error', async () => {
            mockPrisma.inventoryResource.upsert.mockRejectedValue(new Error('DB down'));
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const repo = new InventoryPostgresRepository();
            await expect(repo.upsertResource({
                tenantId: 'org-default', accountId: 'acc-1', region: 'us-east-1', resourceType: 'ec2_instances',
                resourceId: 'i-1', tags: {}, metadata: {}, discoveredAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            } as any)).rejects.toThrow('Failed to upsert resource: DB down');
            consoleSpy.mockRestore();
        });
    });

    describe('upsertBatch', () => {
        it('returns 0 for empty array', async () => {
            const repo = new InventoryPostgresRepository();
            const result = await repo.upsertBatch([]);
            expect(result).toBe(0);
            expect(mockPrisma.$transaction).not.toHaveBeenCalled();
        });

        it('wraps upserts in a transaction and returns count', async () => {
            mockPrisma.$transaction.mockResolvedValue([makeRow(), makeRow()]);

            const resources = [
                {
                    tenantId: 'org-default',
                    accountId: 'acc-1',
                    region: 'us-east-1',
                    resourceType: 'ec2_instances',
                    resourceId: 'i-1',
                    tags: {},
                    metadata: {},
                    discoveredAt: '2024-01-01T00:00:00Z',
                    updatedAt: '2024-01-01T00:00:00Z',
                },
                {
                    tenantId: 'org-default',
                    accountId: 'acc-1',
                    region: 'us-east-1',
                    resourceType: 'ec2_instances',
                    resourceId: 'i-2',
                    tags: {},
                    metadata: {},
                    discoveredAt: '2024-01-01T00:00:00Z',
                    updatedAt: '2024-01-01T00:00:00Z',
                },
            ];

            const repo = new InventoryPostgresRepository();
            const result = await repo.upsertBatch(resources);

            expect(mockPrisma.$transaction).toHaveBeenCalledOnce();
            expect(result).toBe(2);
        });

        it('resolves tenantId from the account when the batch tenantId is missing/default', async () => {
            mockPrisma.account.findFirst.mockResolvedValue({ tenantId: 'resolved-tenant' });
            mockPrisma.$transaction.mockResolvedValue([makeRow()]);

            const repo = new InventoryPostgresRepository();
            await repo.upsertBatch([{
                tenantId: 'default', accountId: 'acc-1', region: 'us-east-1', resourceType: 'ec2_instances',
                resourceId: 'i-1', tags: {}, metadata: {}, discoveredAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
            } as any]);

            expect(mockPrisma.account.findFirst).toHaveBeenCalledWith({ where: { accountId: 'acc-1' }, select: { tenantId: true } });
            expect(getTenantClient).toHaveBeenCalledWith('resolved-tenant');
        });

        it('returns 0 and skips the transaction when no account owns the batch accountId', async () => {
            mockPrisma.account.findFirst.mockResolvedValue(null);
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const repo = new InventoryPostgresRepository();
            const result = await repo.upsertBatch([{
                tenantId: 'default', accountId: 'acc-orphan', region: 'us-east-1', resourceType: 'ec2_instances',
                resourceId: 'i-1', tags: {}, metadata: {}, discoveredAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
            } as any]);
            expect(result).toBe(0);
            expect(mockPrisma.$transaction).not.toHaveBeenCalled();
            consoleSpy.mockRestore();
        });

        it('defaults discoveredAt to now on create when omitted', async () => {
            mockPrisma.$transaction.mockImplementation((ops: unknown[]) => Promise.all(ops as Promise<unknown>[]));
            mockPrisma.inventoryResource.upsert.mockResolvedValue(makeRow());
            const before = Date.now();

            const repo = new InventoryPostgresRepository();
            await repo.upsertBatch([{
                tenantId: 'org-default', accountId: 'acc-1', region: 'us-east-1', resourceType: 'ec2_instances',
                resourceId: 'i-1', tags: {}, metadata: {}, updatedAt: new Date().toISOString(),
            } as any]);

            const discoveredAt: Date = mockPrisma.inventoryResource.upsert.mock.calls[0][0].create.discoveredAt;
            expect(discoveredAt.getTime()).toBeGreaterThanOrEqual(before);
        });

        it('wraps a repository failure in a descriptive error', async () => {
            mockPrisma.$transaction.mockRejectedValue(new Error('DB down'));
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const repo = new InventoryPostgresRepository();
            await expect(repo.upsertBatch([{
                tenantId: 'org-default', accountId: 'acc-1', region: 'us-east-1', resourceType: 'ec2_instances',
                resourceId: 'i-1', tags: {}, metadata: {}, discoveredAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
            } as any])).rejects.toThrow('Failed to batch upsert resources: DB down');
            consoleSpy.mockRestore();
        });
    });

    describe('getResourceCounts', () => {
        it('uses groupBy with tenantId filter', async () => {
            mockPrisma.inventoryResource.groupBy.mockResolvedValue([
                { resourceType: 'ec2_instances', _count: { resourceType: 5 } },
                { resourceType: 'rds_instances', _count: { resourceType: 2 } },
            ]);

            const repo = new InventoryPostgresRepository();
            const result = await repo.getResourceCounts('org-default');

            expect(mockPrisma.inventoryResource.groupBy).toHaveBeenCalledWith(
                expect.objectContaining({
                    by: ['resourceType'],
                    where: expect.objectContaining({ tenantId: 'org-default' }),
                })
            );
            expect(result).toHaveLength(2);
            expect(result[0].count).toBe(5);
        });

        it('wraps a repository failure in a descriptive error', async () => {
            mockPrisma.inventoryResource.groupBy.mockRejectedValue(new Error('DB down'));
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const repo = new InventoryPostgresRepository();
            await expect(repo.getResourceCounts('org-default')).rejects.toThrow('Failed to get resource counts: DB down');
            consoleSpy.mockRestore();
        });
    });

    describe('deleteResourcesByAccount', () => {
        it('calls deleteMany with tenantId and accountId', async () => {
            mockPrisma.inventoryResource.deleteMany.mockResolvedValue({ count: 10 });

            const repo = new InventoryPostgresRepository();
            const result = await repo.deleteResourcesByAccount('org-default', 'acc-1');

            expect(mockPrisma.inventoryResource.deleteMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { tenantId: 'org-default', accountId: 'acc-1' },
                })
            );
            expect(result).toBe(10);
        });

        it('wraps a repository failure in a descriptive error', async () => {
            mockPrisma.inventoryResource.deleteMany.mockRejectedValue(new Error('DB down'));
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const repo = new InventoryPostgresRepository();
            await expect(repo.deleteResourcesByAccount('org-default', 'acc-1')).rejects.toThrow('Failed to delete resources: DB down');
            consoleSpy.mockRestore();
        });
    });

    describe('listResourcesFulltext (via searchTerm)', () => {
        it('includes isCurrent = true in the WHERE clause', async () => {
            mockPrisma.$queryRawUnsafe = vi
                .fn()
                .mockResolvedValueOnce([{ total: 0 }])
                .mockResolvedValueOnce([]);

            const repo = new InventoryPostgresRepository();
            await repo.listResources({ tenantId: 'org-default', searchTerm: 'prod' });

            const countSql = mockPrisma.$queryRawUnsafe.mock.calls[0][0];
            const dataSql = mockPrisma.$queryRawUnsafe.mock.calls[1][0];
            expect(countSql).toContain('"isCurrent" = true');
            expect(dataSql).toContain('"isCurrent" = true');
        });

        it('binds tenantId and searchTerm as the first two positional params on both queries', async () => {
            mockPrisma.$queryRawUnsafe = vi.fn().mockResolvedValueOnce([{ total: 0 }]).mockResolvedValueOnce([]);
            const repo = new InventoryPostgresRepository();
            await repo.listResources({ tenantId: 'org-default', searchTerm: 'prod' });

            expect(mockPrisma.$queryRawUnsafe.mock.calls[0]).toEqual(
                expect.arrayContaining(['org-default', 'prod']),
            );
        });

        it('appends an accountId predicate, bound as a parameter, when given', async () => {
            mockPrisma.$queryRawUnsafe = vi.fn().mockResolvedValueOnce([{ total: 0 }]).mockResolvedValueOnce([]);
            const repo = new InventoryPostgresRepository();
            await repo.listResources({ tenantId: 'org-default', searchTerm: 'prod', accountId: 'acc-1' });

            expect(mockPrisma.$queryRawUnsafe.mock.calls[0][0]).toContain('"accountId" = $3');
            expect(mockPrisma.$queryRawUnsafe.mock.calls[0]).toContain('acc-1');
        });

        it('appends an accountId ANY() predicate when accountIds is given without accountId', async () => {
            mockPrisma.$queryRawUnsafe = vi.fn().mockResolvedValueOnce([{ total: 0 }]).mockResolvedValueOnce([]);
            const repo = new InventoryPostgresRepository();
            await repo.listResources({ tenantId: 'org-default', searchTerm: 'prod', accountIds: ['acc-1', 'acc-2'] });

            expect(mockPrisma.$queryRawUnsafe.mock.calls[0][0]).toContain('"accountId" = ANY($3)');
        });

        it('appends a region predicate when given', async () => {
            mockPrisma.$queryRawUnsafe = vi.fn().mockResolvedValueOnce([{ total: 0 }]).mockResolvedValueOnce([]);
            const repo = new InventoryPostgresRepository();
            await repo.listResources({ tenantId: 'org-default', searchTerm: 'prod', region: 'us-west-2' });

            expect(mockPrisma.$queryRawUnsafe.mock.calls[0][0]).toContain('region = $3');
        });

        it('appends a resourceType predicate when given', async () => {
            mockPrisma.$queryRawUnsafe = vi.fn().mockResolvedValueOnce([{ total: 0 }]).mockResolvedValueOnce([]);
            const repo = new InventoryPostgresRepository();
            await repo.listResources({ tenantId: 'org-default', searchTerm: 'prod', resourceType: 'ec2_instances' });

            expect(mockPrisma.$queryRawUnsafe.mock.calls[0][0]).toContain('"resourceType" = $3');
        });

        it('stacks every optional predicate together with correctly incrementing placeholders', async () => {
            mockPrisma.$queryRawUnsafe = vi.fn().mockResolvedValueOnce([{ total: 0 }]).mockResolvedValueOnce([]);
            const repo = new InventoryPostgresRepository();
            await repo.listResources({
                tenantId: 'org-default', searchTerm: 'prod', accountId: 'acc-1', region: 'us-west-2', resourceType: 'ec2_instances',
            });

            const sql = mockPrisma.$queryRawUnsafe.mock.calls[0][0];
            expect(sql).toContain('"accountId" = $3');
            expect(sql).toContain('region = $4');
            expect(sql).toContain('"resourceType" = $5');
        });

        it('returns the counted total and ranked rows, defaulting total to 0 when the count query is empty', async () => {
            mockPrisma.$queryRawUnsafe = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([makeRow()]);
            const repo = new InventoryPostgresRepository();
            const result = await repo.listResources({ tenantId: 'org-default', searchTerm: 'prod' });
            expect(result.total).toBe(0);
            expect(result.resources).toHaveLength(1);
        });

        it('orders by ts_rank then discoveredAt desc, with limit/offset bound as the trailing params', async () => {
            mockPrisma.$queryRawUnsafe = vi.fn().mockResolvedValueOnce([{ total: 0 }]).mockResolvedValueOnce([]);
            const repo = new InventoryPostgresRepository();
            await repo.listResources({ tenantId: 'org-default', searchTerm: 'prod', page: 2, limit: 10 });

            const dataSql = mockPrisma.$queryRawUnsafe.mock.calls[1][0];
            const dataParams = mockPrisma.$queryRawUnsafe.mock.calls[1].slice(1);
            expect(dataSql).toContain('ORDER BY ts_rank');
            expect(dataParams).toEqual(expect.arrayContaining([10, 10])); // limit=10, skip=(2-1)*10=10
        });
    });
});

describe('InventoryPostgresRepository — remaining branches', () => {
    let mockPrisma: {
        inventoryResource: {
            findMany: MockedFunction<any>; count: MockedFunction<any>; findUnique: MockedFunction<any>;
            upsert: MockedFunction<any>; deleteMany: MockedFunction<any>; groupBy: MockedFunction<any>;
        };
        account: { findFirst: MockedFunction<any> };
        $transaction: MockedFunction<any>;
    };

    beforeEach(() => {
        mockPrisma = {
            inventoryResource: {
                findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn(), groupBy: vi.fn(),
            },
            account: { findFirst: vi.fn().mockResolvedValue({ tenantId: 'org-default' }) },
            $transaction: vi.fn(),
        };
        vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as any);
        vi.mocked(getTenantClient).mockReturnValue(mockPrisma as any);
    });

    it('defaults null tags/metadata to {} in the mapped resource', async () => {
        mockPrisma.inventoryResource.findUnique.mockResolvedValue(makeRow({ tags: null, metadata: null }));
        const repo = new InventoryPostgresRepository();
        const result = await repo.getResource('org-default', 'acc-1', 'ec2_instances', 'i-1');
        expect(result?.tags).toEqual({});
        expect(result?.metadata).toEqual({});
    });

    it('skips the resolution branch entirely for an already-real tenantId in upsertBatch', async () => {
        mockPrisma.$transaction.mockResolvedValue([makeRow()]);
        const repo = new InventoryPostgresRepository();
        await repo.upsertBatch([{
            tenantId: 'tenant-real', accountId: 'acc-1', region: 'us-east-1', resourceType: 'ec2_instances',
            resourceId: 'i-1', tags: {}, metadata: {}, discoveredAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
        } as any]);
        expect(mockPrisma.account.findFirst).not.toHaveBeenCalled();
        expect(getTenantClient).toHaveBeenCalledWith('tenant-real');
    });

    it.each([
        ['getResource', (r: InventoryPostgresRepository) => r.getResource('org-default', 'acc-1', 'ec2_instances', 'i-1'), 'findUnique', 'Failed to get resource: raw failure'],
        ['upsertResource', (r: InventoryPostgresRepository) => r.upsertResource({
            tenantId: 'tenant-real', accountId: 'acc-1', region: 'us-east-1', resourceType: 'ec2_instances',
            resourceId: 'i-1', tags: {}, metadata: {}, discoveredAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
        } as any), 'upsert', 'Failed to upsert resource: raw failure'],
        ['getResourceCounts', (r: InventoryPostgresRepository) => r.getResourceCounts('org-default'), 'groupBy', 'Failed to get resource counts: raw failure'],
        ['deleteResourcesByAccount', (r: InventoryPostgresRepository) => r.deleteResourcesByAccount('org-default', 'acc-1'), 'deleteMany', 'Failed to delete resources: raw failure'],
    ] as const)('%s stringifies a non-Error throw', async (_name, call, mockKey, expected) => {
        (mockPrisma.inventoryResource as any)[mockKey].mockRejectedValue('raw failure');
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const repo = new InventoryPostgresRepository();
        await expect(call(repo)).rejects.toThrow(expected);
        consoleSpy.mockRestore();
    });

    it('upsertBatch stringifies a non-Error throw', async () => {
        mockPrisma.$transaction.mockRejectedValue('raw failure');
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const repo = new InventoryPostgresRepository();
        await expect(repo.upsertBatch([{
            tenantId: 'tenant-real', accountId: 'acc-1', region: 'us-east-1', resourceType: 'ec2_instances',
            resourceId: 'i-1', tags: {}, metadata: {}, discoveredAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
        } as any])).rejects.toThrow('Failed to batch upsert resources: raw failure');
        consoleSpy.mockRestore();
    });
});

describe('InventoryPostgresRepository — tenant isolation', () => {
    let mockPrisma: {
        inventoryResource: {
            findMany: MockedFunction<any>;
            count: MockedFunction<any>;
            findUnique: MockedFunction<any>;
            upsert: MockedFunction<any>;
            deleteMany: MockedFunction<any>;
            groupBy: MockedFunction<any>;
        };
        $transaction: MockedFunction<any>;
    };

    beforeEach(() => {
        mockPrisma = {
            inventoryResource: {
                findMany: vi.fn().mockResolvedValue([]),
                count: vi.fn().mockResolvedValue(0),
                findUnique: vi.fn().mockResolvedValue(null),
                upsert: vi.fn(),
                deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
                groupBy: vi.fn().mockResolvedValue([]),
            },
            $transaction: vi.fn().mockResolvedValue([]),
        };
        vi.mocked(getTenantClient).mockReturnValue(mockPrisma as any);
        vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as any);
    });

    it('listResources calls getTenantClient with correct tenantId', async () => {
        const repo = new InventoryPostgresRepository();
        await repo.listResources({ tenantId: 'tenant-test' });
        expect(getTenantClient).toHaveBeenCalledWith('tenant-test');
    });

    it('getResource calls getTenantClient with correct tenantId', async () => {
        const repo = new InventoryPostgresRepository();
        await repo.getResource('tenant-test', 'acc-1', 'ec2_instances', 'i-123');
        expect(getTenantClient).toHaveBeenCalledWith('tenant-test');
    });

    it('upsertResource calls getTenantClient with resolved tenantId', async () => {
        mockPrisma.inventoryResource.upsert.mockResolvedValue({
            id: 'cuid-1', tenantId: 'tenant-test', accountId: 'acc-1', region: 'us-east-1',
            resourceType: 'ec2_instances', resourceId: 'i-123', name: null, status: null,
            tags: {}, metadata: {}, discoveredAt: new Date(), updatedAt: new Date(),
        });
        const repo = new InventoryPostgresRepository();
        await repo.upsertResource({
            tenantId: 'tenant-test', accountId: 'acc-1', region: 'us-east-1',
            resourceType: 'ec2_instances', resourceId: 'i-123',
            tags: {}, metadata: {}, discoveredAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
        expect(getTenantClient).toHaveBeenCalledWith('tenant-test');
    });

    it('getResourceCounts calls getTenantClient with correct tenantId', async () => {
        const repo = new InventoryPostgresRepository();
        await repo.getResourceCounts('tenant-test');
        expect(getTenantClient).toHaveBeenCalledWith('tenant-test');
    });

    it('deleteResourcesByAccount calls getTenantClient with correct tenantId', async () => {
        const repo = new InventoryPostgresRepository();
        await repo.deleteResourcesByAccount('tenant-test', 'acc-1');
        expect(getTenantClient).toHaveBeenCalledWith('tenant-test');
    });
});
