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

    describe('updateDataSource — content', () => {
        it('writes content when provided', async () => {
            mockPrisma.dataSource.updateMany.mockResolvedValue({ count: 1 });

            const repo = new DataSourcePostgresRepository();
            await repo.updateDataSource('kb-1', 'ds-1', { content: '# Hello', status: 'synced' }, 'tenant-1');

            const callArg = mockPrisma.dataSource.updateMany.mock.calls[0][0];
            expect(callArg.data.content).toBe('# Hello');
            expect(callArg.data.status).toBe('synced');
        });
    });

    describe('getDataSourceContent', () => {
        it('returns content string, scoped by tenant/kb/ds', async () => {
            mockPrisma.dataSource.findFirst.mockResolvedValue({ content: '# Doc body' });

            const repo = new DataSourcePostgresRepository();
            const result = await repo.getDataSourceContent('kb-1', 'ds-1', 'tenant-1');

            expect(result).toBe('# Doc body');
            expect(mockPrisma.dataSource.findFirst).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ id: 'ds-1', knowledgeBaseId: 'kb-1', tenantId: 'tenant-1' }),
                    select: { content: true },
                })
            );
        });

        it('returns null when row not found', async () => {
            mockPrisma.dataSource.findFirst.mockResolvedValue(null);
            const repo = new DataSourcePostgresRepository();
            expect(await repo.getDataSourceContent('kb-1', 'missing', 'tenant-1')).toBeNull();
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

describe('rowToDS', () => {
    it('converts a populated lastSyncAt to an ISO string', async () => {
        const mockPrisma = { dataSource: { findFirst: vi.fn() } };
        vi.mocked(getTenantClient).mockReturnValue(mockPrisma as any);
        mockPrisma.dataSource.findFirst.mockResolvedValue(makeDSRow({ lastSyncAt: new Date('2026-01-01T00:00:00Z') }));

        const repo = new DataSourcePostgresRepository();
        const ds = await repo.getDataSource('kb-1', 'ds-1', 'tenant-1');
        expect(ds?.lastSyncAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('defaults null lastSyncError/lastErrorMessage/lastErrorDetail to undefined', async () => {
        const mockPrisma = { dataSource: { findFirst: vi.fn() } };
        vi.mocked(getTenantClient).mockReturnValue(mockPrisma as any);
        mockPrisma.dataSource.findFirst.mockResolvedValue(makeDSRow({
            lastSyncError: null, lastErrorMessage: null, lastErrorDetail: null,
        }));

        const repo = new DataSourcePostgresRepository();
        const ds = await repo.getDataSource('kb-1', 'ds-1', 'tenant-1');
        expect(ds?.lastSyncError).toBeUndefined();
        expect(ds?.lastErrorMessage).toBeUndefined();
        expect(ds?.lastErrorDetail).toBeUndefined();
    });
});

describe('updateDataSource — lastSyncAt conversion', () => {
    it('converts a string lastSyncAt update to a Date', async () => {
        const mockPrisma = { dataSource: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };
        vi.mocked(getTenantClient).mockReturnValue(mockPrisma as any);

        const repo = new DataSourcePostgresRepository();
        await repo.updateDataSource('kb-1', 'ds-1', { lastSyncAt: '2026-01-01T00:00:00Z' } as any, 'tenant-1');

        const data = mockPrisma.dataSource.updateMany.mock.calls[0][0].data;
        expect(data.lastSyncAt).toBeInstanceOf(Date);
    });

    it('passes through a non-string lastSyncAt (already a Date) unchanged', async () => {
        const mockPrisma = { dataSource: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };
        vi.mocked(getTenantClient).mockReturnValue(mockPrisma as any);
        const date = new Date('2026-01-01T00:00:00Z');

        const repo = new DataSourcePostgresRepository();
        await repo.updateDataSource('kb-1', 'ds-1', { lastSyncAt: date } as any, 'tenant-1');

        expect(mockPrisma.dataSource.updateMany.mock.calls[0][0].data.lastSyncAt).toBe(date);
    });

    it('ignores an unrecognized field not in the allowlist', async () => {
        const mockPrisma = { dataSource: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };
        vi.mocked(getTenantClient).mockReturnValue(mockPrisma as any);

        const repo = new DataSourcePostgresRepository();
        await repo.updateDataSource('kb-1', 'ds-1', { id: 'attacker-supplied' } as any, 'tenant-1');

        expect(mockPrisma.dataSource.updateMany.mock.calls[0][0].data).toEqual({});
    });
});

describe('DataSourcePostgresRepository — error wrapping', () => {
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
                findMany: vi.fn().mockRejectedValue(new Error('DB down')),
                findFirst: vi.fn().mockRejectedValue(new Error('DB down')),
                create: vi.fn().mockRejectedValue(new Error('DB down')),
                updateMany: vi.fn().mockRejectedValue(new Error('DB down')),
                deleteMany: vi.fn().mockRejectedValue(new Error('DB down')),
            },
        };
        vi.mocked(getTenantClient).mockReturnValue(mockPrisma as any);
    });

    const cases: Array<[string, (repo: DataSourcePostgresRepository) => Promise<unknown>, string]> = [
        ['listDataSources', (r) => r.listDataSources('kb-1', 'tenant-1'), 'Failed to list data sources: DB down'],
        ['getDataSource', (r) => r.getDataSource('kb-1', 'ds-1', 'tenant-1'), 'Failed to get data source: DB down'],
        ['createDataSource', (r) => r.createDataSource('kb-1', { name: 'x', sourceType: 'file-upload', config: {} } as any, 'tenant-1'), 'Failed to create data source: DB down'],
        ['updateDataSource', (r) => r.updateDataSource('kb-1', 'ds-1', { status: 'synced' } as any, 'tenant-1'), 'Failed to update data source: DB down'],
        ['deleteDataSource', (r) => r.deleteDataSource('kb-1', 'ds-1', 'tenant-1'), 'Failed to delete data source: DB down'],
        ['getDataSourceContent', (r) => r.getDataSourceContent('kb-1', 'ds-1', 'tenant-1'), 'Failed to get data source content: DB down'],
    ];

    it.each(cases)('%s wraps a repository failure in a descriptive error', async (_name, call, expectedMessage) => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const repo = new DataSourcePostgresRepository();
        await expect(call(repo)).rejects.toThrow(expectedMessage);
        consoleSpy.mockRestore();
    });

    it.each(cases)('%s stringifies a non-Error throw', async (_name, call) => {
        for (const m of Object.values(mockPrisma.dataSource)) (m as MockedFunction<any>).mockRejectedValue('raw failure');
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const repo = new DataSourcePostgresRepository();
        await expect(call(repo)).rejects.toThrow(/raw failure$/);
        consoleSpy.mockRestore();
    });
});
