import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';

vi.mock('@/lib/db/pg-config', () => ({
    getTenantClient: vi.fn(),
}));

import { getTenantClient } from '@/lib/db/pg-config';
import { KnowledgeBasePostgresRepository } from './postgres';

const makeKBRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'cuid-kb-1',
    tenantId: 'tenant-1',
    name: 'My Knowledge Base',
    description: 'A test KB',
    status: 'active',
    vectorCount: 0,
    dataSourceCount: 0,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-02T00:00:00Z'),
    createdBy: 'user-1',
    ...overrides,
});

describe('KnowledgeBasePostgresRepository', () => {
    let mockPrisma: {
        knowledgeBase: {
            findMany: MockedFunction<any>;
            findFirst: MockedFunction<any>;
            create: MockedFunction<any>;
            updateMany: MockedFunction<any>;
            deleteMany: MockedFunction<any>;
        };
    };

    beforeEach(() => {
        mockPrisma = {
            knowledgeBase: {
                findMany: vi.fn(),
                findFirst: vi.fn(),
                create: vi.fn(),
                updateMany: vi.fn(),
                deleteMany: vi.fn(),
            },
        };
        vi.mocked(getTenantClient).mockReturnValue(mockPrisma as any);
    });

    describe('listKnowledgeBases', () => {
        it('queries with tenantId in where clause', async () => {
            mockPrisma.knowledgeBase.findMany.mockResolvedValue([makeKBRow()]);

            const repo = new KnowledgeBasePostgresRepository();
            const result = await repo.listKnowledgeBases('tenant-1');

            expect(mockPrisma.knowledgeBase.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ tenantId: 'tenant-1' }),
                })
            );
            expect(result).toHaveLength(1);
            expect(result[0].id).toBe('cuid-kb-1');
        });

        it('returns empty array when no rows', async () => {
            mockPrisma.knowledgeBase.findMany.mockResolvedValue([]);

            const repo = new KnowledgeBasePostgresRepository();
            const result = await repo.listKnowledgeBases('tenant-1');

            expect(result).toHaveLength(0);
        });

        it('maps DateTime to ISO string', async () => {
            mockPrisma.knowledgeBase.findMany.mockResolvedValue([makeKBRow()]);

            const repo = new KnowledgeBasePostgresRepository();
            const result = await repo.listKnowledgeBases('tenant-1');

            expect(result[0].createdAt).toBe('2024-01-01T00:00:00.000Z');
            expect(result[0].updatedAt).toBe('2024-01-02T00:00:00.000Z');
        });
    });

    describe('getKnowledgeBase', () => {
        it('returns null when not found', async () => {
            mockPrisma.knowledgeBase.findFirst.mockResolvedValue(null);

            const repo = new KnowledgeBasePostgresRepository();
            const result = await repo.getKnowledgeBase('kb-missing', 'tenant-1');

            expect(result).toBeNull();
        });

        it('returns KnowledgeBase when found', async () => {
            mockPrisma.knowledgeBase.findFirst.mockResolvedValue(makeKBRow({ id: 'kb-found' }));

            const repo = new KnowledgeBasePostgresRepository();
            const result = await repo.getKnowledgeBase('kb-found', 'tenant-1');

            expect(result).not.toBeNull();
            expect(result!.id).toBe('kb-found');
        });

        it('enforces cross-tenant isolation — includes tenantId in where', async () => {
            mockPrisma.knowledgeBase.findFirst.mockResolvedValue(null);

            const repo = new KnowledgeBasePostgresRepository();
            await repo.getKnowledgeBase('kb-1', 'tenant-other');

            expect(mockPrisma.knowledgeBase.findFirst).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ id: 'kb-1', tenantId: 'tenant-other' }),
                })
            );
        });
    });

    describe('createKnowledgeBase', () => {
        it('creates with tenantId, vectorCount=0, dataSourceCount=0', async () => {
            mockPrisma.knowledgeBase.create.mockResolvedValue(
                makeKBRow({ name: 'New KB', vectorCount: 0, dataSourceCount: 0 })
            );

            const repo = new KnowledgeBasePostgresRepository();
            const result = await repo.createKnowledgeBase({ name: 'New KB' }, 'tenant-1', 'user-1');

            const createArg = mockPrisma.knowledgeBase.create.mock.calls[0][0];
            expect(createArg.data.tenantId).toBe('tenant-1');
            expect(createArg.data.vectorCount).toBe(0);
            expect(createArg.data.dataSourceCount).toBe(0);
            expect(createArg.data.status).toBe('active');
            expect(result.name).toBe('New KB');
        });
    });

    describe('updateKnowledgeBase', () => {
        it('calls updateMany with tenantId and kbId in where', async () => {
            mockPrisma.knowledgeBase.updateMany.mockResolvedValue({ count: 1 });

            const repo = new KnowledgeBasePostgresRepository();
            await repo.updateKnowledgeBase('kb-1', { name: 'Updated' }, 'tenant-1');

            expect(mockPrisma.knowledgeBase.updateMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ id: 'kb-1', tenantId: 'tenant-1' }),
                })
            );
        });
    });

    describe('deleteKnowledgeBase', () => {
        it('calls deleteMany with tenantId and kbId in where', async () => {
            mockPrisma.knowledgeBase.deleteMany.mockResolvedValue({ count: 1 });

            const repo = new KnowledgeBasePostgresRepository();
            await repo.deleteKnowledgeBase('kb-1', 'tenant-1');

            expect(mockPrisma.knowledgeBase.deleteMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ id: 'kb-1', tenantId: 'tenant-1' }),
                })
            );
        });
    });

    describe('updateDataSourceCount', () => {
        it('uses Prisma increment for atomic update', async () => {
            mockPrisma.knowledgeBase.updateMany.mockResolvedValue({ count: 1 });

            const repo = new KnowledgeBasePostgresRepository();
            await repo.updateDataSourceCount('kb-1', 1, 'tenant-1');

            const callArg = mockPrisma.knowledgeBase.updateMany.mock.calls[0][0];
            expect(callArg.data.dataSourceCount).toEqual({ increment: 1 });
            expect(callArg.where).toMatchObject({ id: 'kb-1', tenantId: 'tenant-1' });
        });

        it('supports negative delta for decrement', async () => {
            mockPrisma.knowledgeBase.updateMany.mockResolvedValue({ count: 1 });

            const repo = new KnowledgeBasePostgresRepository();
            await repo.updateDataSourceCount('kb-1', -1, 'tenant-1');

            const callArg = mockPrisma.knowledgeBase.updateMany.mock.calls[0][0];
            expect(callArg.data.dataSourceCount).toEqual({ increment: -1 });
        });
    });

    describe('updateVectorCount', () => {
        it('uses Prisma increment for atomic update', async () => {
            mockPrisma.knowledgeBase.updateMany.mockResolvedValue({ count: 1 });

            const repo = new KnowledgeBasePostgresRepository();
            await repo.updateVectorCount('kb-1', 50, 'tenant-1');

            const callArg = mockPrisma.knowledgeBase.updateMany.mock.calls[0][0];
            expect(callArg.data.vectorCount).toEqual({ increment: 50 });
            expect(callArg.where).toMatchObject({ id: 'kb-1', tenantId: 'tenant-1' });
        });
    });
});

describe('KnowledgeBasePostgresRepository — tenant isolation', () => {
    let mockPrisma: {
        knowledgeBase: {
            findMany: MockedFunction<any>;
            findFirst: MockedFunction<any>;
            create: MockedFunction<any>;
            updateMany: MockedFunction<any>;
            deleteMany: MockedFunction<any>;
        };
    };

    beforeEach(() => {
        mockPrisma = {
            knowledgeBase: {
                findMany: vi.fn().mockResolvedValue([]),
                findFirst: vi.fn().mockResolvedValue(null),
                create: vi.fn(),
                updateMany: vi.fn().mockResolvedValue({ count: 1 }),
                deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
            },
        };
        vi.mocked(getTenantClient).mockReturnValue(mockPrisma as any);
    });

    it('listKnowledgeBases calls getTenantClient with correct tenantId', async () => {
        const repo = new KnowledgeBasePostgresRepository();
        await repo.listKnowledgeBases('tenant-test');
        expect(getTenantClient).toHaveBeenCalledWith('tenant-test');
    });

    it('getKnowledgeBase calls getTenantClient with correct tenantId', async () => {
        const repo = new KnowledgeBasePostgresRepository();
        await repo.getKnowledgeBase('kb-1', 'tenant-test');
        expect(getTenantClient).toHaveBeenCalledWith('tenant-test');
    });

    it('createKnowledgeBase calls getTenantClient with correct tenantId', async () => {
        mockPrisma.knowledgeBase.create.mockResolvedValue(makeKBRow({ tenantId: 'tenant-test' }));
        const repo = new KnowledgeBasePostgresRepository();
        await repo.createKnowledgeBase({ name: 'New KB' }, 'tenant-test', 'user-1');
        expect(getTenantClient).toHaveBeenCalledWith('tenant-test');
    });

    it('updateKnowledgeBase calls getTenantClient with correct tenantId', async () => {
        const repo = new KnowledgeBasePostgresRepository();
        await repo.updateKnowledgeBase('kb-1', { name: 'Updated' }, 'tenant-test');
        expect(getTenantClient).toHaveBeenCalledWith('tenant-test');
    });

    it('deleteKnowledgeBase calls getTenantClient with correct tenantId', async () => {
        const repo = new KnowledgeBasePostgresRepository();
        await repo.deleteKnowledgeBase('kb-1', 'tenant-test');
        expect(getTenantClient).toHaveBeenCalledWith('tenant-test');
    });
});
