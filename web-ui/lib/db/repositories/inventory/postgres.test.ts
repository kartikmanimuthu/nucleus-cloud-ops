import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';

vi.mock('@/lib/db/pg-config', () => ({
    getPrismaClient: vi.fn(),
}));

import { getPrismaClient } from '@/lib/db/pg-config';
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
            $transaction: vi.fn(),
        };
        vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as any);
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

        it('adds ILIKE name filter for searchTerm', async () => {
            mockPrisma.inventoryResource.count.mockResolvedValue(1);
            mockPrisma.inventoryResource.findMany.mockResolvedValue([makeRow()]);

            const repo = new InventoryPostgresRepository();
            await repo.listResources({ tenantId: 'org-default', searchTerm: 'prod' });

            const callArg = mockPrisma.inventoryResource.findMany.mock.calls[0][0];
            expect(callArg.where.name).toEqual({
                contains: 'prod',
                mode: 'insensitive',
            });
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
    });
});
