import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';

vi.mock('@/lib/db/pg-config', () => ({
    getTenantClient: vi.fn(),
}));

import { getTenantClient } from '@/lib/db/pg-config';
import { DataSourcePostgresRepository } from './postgres';

const makeDSRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'cuid-ds-1',
    tenantId: 'tenant-1',
    knowledgeBaseId: 'kb-1',
    name: 'My Data Source',
    sourceType: 'file-upload',
    status: 'pending',
    config: { fileName: 'test.pdf', fileSize: 1024, mimeType: 'application/pdf', s3Key: 'key', chunkCount: 5 },
    vectorCount: 0,
    vectorKeys: [],
    lastSyncAt: null,
    lastSyncError: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-02T00:00:00Z'),
    ...overrides,
});

describe('DataSourcePostgresRepository', () => {
    let mockPrisma: {
        dataSource: {
            findMany: MockedFunction<any>;
            findFirst: MockedFunction<any>;
            create: MockedFunction<any>;
            updateMany: MockedFunction<any>;
            deleteMany: MockedFunction<any>;
        };
    };

    beforeEach(() => {
        mockPrisma = {
            dataSource: {
                findMany: vi.fn(),
                findFirst: vi.fn(),
                create: vi.fn(),
                updateMany: vi.fn(),
                deleteMany: vi.fn(),
            },
        };
        vi.mocked(getTenantClient).mockReturnValue(mockPrisma as any);
    });

    describe('listDataSources', () => {
        it('queries with knowledgeBaseId and tenantId in where clause', async () => {
            mockPrisma.dataSource.findMany.mockResolvedValue([makeDSRow()]);

            const repo = new DataSourcePostgresRepository();
            const result = await repo.listDataSources('kb-1', 'tenant-1');

            expect(mockPrisma.dataSource.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ knowledgeBaseId: 'kb-1', tenantId: 'tenant-1' }),
                })
            );
            expect(result).toHaveLength(1);
            expect(result[0].id).toBe('cuid-ds-1');
        });

        it('returns empty array when no rows', async () => {
            mockPrisma.dataSource.findMany.mockResolvedValue([]);

            const repo = new DataSourcePostgresRepository();
            const result = await repo.listDataSources('kb-1', 'tenant-1');

            expect(result).toHaveLength(0);
        });

        it('maps DateTime to ISO string', async () => {
            mockPrisma.dataSource.findMany.mockResolvedValue([makeDSRow()]);

            const repo = new DataSourcePostgresRepository();
            const result = await repo.listDataSources('kb-1', 'tenant-1');

            expect(result[0].createdAt).toBe('2024-01-01T00:00:00.000Z');
            expect(result[0].updatedAt).toBe('2024-01-02T00:00:00.000Z');
        });
    });

    describe('getDataSource', () => {
        it('returns null when not found', async () => {
            mockPrisma.dataSource.findFirst.mockResolvedValue(null);

            const repo = new DataSourcePostgresRepository();
            const result = await repo.getDataSource('kb-1', 'ds-missing', 'tenant-1');

            expect(result).toBeNull();
        });

        it('returns DataSource when found', async () => {
            mockPrisma.dataSource.findFirst.mockResolvedValue(makeDSRow({ id: 'ds-found' }));

            const repo = new DataSourcePostgresRepository();
            const result = await repo.getDataSource('kb-1', 'ds-found', 'tenant-1');

            expect(result).not.toBeNull();
            expect(result!.id).toBe('ds-found');
        });

        it('enforces cross-tenant isolation — includes tenantId in where', async () => {
            mockPrisma.dataSource.findFirst.mockResolvedValue(null);

            const repo = new DataSourcePostgresRepository();
            await repo.getDataSource('kb-1', 'ds-1', 'tenant-other');

            expect(mockPrisma.dataSource.findFirst).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ tenantId: 'tenant-other', knowledgeBaseId: 'kb-1' }),
                })
            );
        });
    });

    describe('createDataSource', () => {
        it('creates with tenantId, knowledgeBaseId, vectorCount=0, status=pending', async () => {
            mockPrisma.dataSource.create.mockResolvedValue(
                makeDSRow({ name: 'New DS', status: 'pending', vectorCount: 0 })
            );

            const repo = new DataSourcePostgresRepository();
            const result = await repo.createDataSource(
                'kb-1',
                { name: 'New DS', sourceType: 'file-upload', config: { fileName: 'test.pdf', fileSize: 1024, mimeType: 'application/pdf', s3Key: 'key', chunkCount: 5 } },
                'tenant-1'
            );

            const createArg = mockPrisma.dataSource.create.mock.calls[0][0];
            expect(createArg.data.tenantId).toBe('tenant-1');
            expect(createArg.data.knowledgeBaseId).toBe('kb-1');
            expect(createArg.data.vectorCount).toBe(0);
            expect(createArg.data.status).toBe('pending');
            expect(result.vectorKeys).toEqual([]);
        });
    });

    describe('updateDataSource', () => {
        it('calls updateMany with tenantId, kbId, and dsId in where', async () => {
            mockPrisma.dataSource.updateMany.mockResolvedValue({ count: 1 });

            const repo = new DataSourcePostgresRepository();
            await repo.updateDataSource('kb-1', 'ds-1', { status: 'synced' }, 'tenant-1');

            expect(mockPrisma.dataSource.updateMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ id: 'ds-1', knowledgeBaseId: 'kb-1', tenantId: 'tenant-1' }),
                })
            );
        });

        it('only updates allowed fields', async () => {
            mockPrisma.dataSource.updateMany.mockResolvedValue({ count: 1 });

            const repo = new DataSourcePostgresRepository();
            await repo.updateDataSource('kb-1', 'ds-1', { status: 'synced', vectorCount: 5, vectorKeys: ['k1'] }, 'tenant-1');

            const callArg = mockPrisma.dataSource.updateMany.mock.calls[0][0];
            expect(callArg.data.status).toBe('synced');
            expect(callArg.data.vectorCount).toBe(5);
            expect(callArg.data.vectorKeys).toEqual(['k1']);
        });
    });

    describe('deleteDataSource', () => {
        it('calls deleteMany with tenantId, kbId, and dsId in where', async () => {
            mockPrisma.dataSource.deleteMany.mockResolvedValue({ count: 1 });

            const repo = new DataSourcePostgresRepository();
            await repo.deleteDataSource('kb-1', 'ds-1', 'tenant-1');

            expect(mockPrisma.dataSource.deleteMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ id: 'ds-1', knowledgeBaseId: 'kb-1', tenantId: 'tenant-1' }),
                })
            );
        });
    });
});

describe('DataSourcePostgresRepository — tenant isolation', () => {
    let mockPrisma: {
        dataSource: {
            findMany: MockedFunction<any>;
            findFirst: MockedFunction<any>;
            create: MockedFunction<any>;
            updateMany: MockedFunction<any>;
            deleteMany: MockedFunction<any>;
        };
    };

    beforeEach(() => {
        mockPrisma = {
            dataSource: {
                findMany: vi.fn().mockResolvedValue([]),
                findFirst: vi.fn().mockResolvedValue(null),
                create: vi.fn(),
                updateMany: vi.fn().mockResolvedValue({ count: 1 }),
                deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
            },
        };
        vi.mocked(getTenantClient).mockReturnValue(mockPrisma as any);
    });

    it('listDataSources calls getTenantClient with correct tenantId', async () => {
        const repo = new DataSourcePostgresRepository();
        await repo.listDataSources('kb-1', 'tenant-test');
        expect(getTenantClient).toHaveBeenCalledWith('tenant-test');
    });

    it('getDataSource calls getTenantClient with correct tenantId', async () => {
        const repo = new DataSourcePostgresRepository();
        await repo.getDataSource('kb-1', 'ds-1', 'tenant-test');
        expect(getTenantClient).toHaveBeenCalledWith('tenant-test');
    });

    it('createDataSource calls getTenantClient with correct tenantId', async () => {
        mockPrisma.dataSource.create.mockResolvedValue(makeDSRow({ tenantId: 'tenant-test' }));
        const repo = new DataSourcePostgresRepository();
        await repo.createDataSource(
            'kb-1',
            { name: 'New DS', sourceType: 'file-upload', config: { fileName: 'f.pdf', fileSize: 1024, mimeType: 'application/pdf', s3Key: 'k', chunkCount: 1 } },
            'tenant-test'
        );
        expect(getTenantClient).toHaveBeenCalledWith('tenant-test');
    });

    it('updateDataSource calls getTenantClient with correct tenantId', async () => {
        const repo = new DataSourcePostgresRepository();
        await repo.updateDataSource('kb-1', 'ds-1', { status: 'synced' }, 'tenant-test');
        expect(getTenantClient).toHaveBeenCalledWith('tenant-test');
    });

    it('deleteDataSource calls getTenantClient with correct tenantId', async () => {
        const repo = new DataSourcePostgresRepository();
        await repo.deleteDataSource('kb-1', 'ds-1', 'tenant-test');
        expect(getTenantClient).toHaveBeenCalledWith('tenant-test');
    });
});
