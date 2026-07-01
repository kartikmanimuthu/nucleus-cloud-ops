import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';

vi.mock('@/lib/db/pg-config', () => ({
    getPrismaClient: vi.fn(),
    getTenantClient: vi.fn(),
}));

import { getPrismaClient, getTenantClient } from '@/lib/db/pg-config';
import { AgentMemoryPostgresRepository } from './postgres';

const makeRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'mem-1',
    tenantId: 't1',
    userId: 'u1',
    namespace: 'infra/acct-123',
    key: 'prod-ecs-region',
    value: { fact: 'prod ECS runs in us-east-1', source: 'discovery scan', confidence: 'high' },
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-02T00:00:00Z'),
    expiresAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
});

describe('AgentMemoryPostgresRepository', () => {
    let mockPrisma: {
        agentMemory: {
            findMany: MockedFunction<any>;
            count: MockedFunction<any>;
            findFirst: MockedFunction<any>;
            deleteMany: MockedFunction<any>;
        };
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockPrisma = {
            agentMemory: {
                findMany: vi.fn().mockResolvedValue([makeRow()]),
                count: vi.fn().mockResolvedValue(1),
                findFirst: vi.fn().mockResolvedValue(makeRow()),
                deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
            },
        };
        vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as any);
        vi.mocked(getTenantClient).mockReturnValue(mockPrisma as any);
    });

    it('listByTenant scopes to tenantId and flattens value into fact/source/confidence/category', async () => {
        const repo = new AgentMemoryPostgresRepository();
        const result = await repo.listByTenant({ tenantId: 't1' });

        expect(getTenantClient).toHaveBeenCalledWith('t1');
        const arg = mockPrisma.agentMemory.findMany.mock.calls[0][0];
        expect(arg.where.tenantId).toBe('t1');
        expect(result.total).toBe(1);
        expect(result.memories[0]).toMatchObject({
            id: 'mem-1',
            category: 'infra',
            fact: 'prod ECS runs in us-east-1',
            source: 'discovery scan',
            confidence: 'high',
        });
    });

    it('listByTenant translates a known category to a namespace startsWith/equals predicate', async () => {
        const repo = new AgentMemoryPostgresRepository();
        await repo.listByTenant({ tenantId: 't1', category: 'patterns' });

        const arg = mockPrisma.agentMemory.findMany.mock.calls[0][0];
        expect(arg.where.AND).toEqual([
            { OR: [{ namespace: { startsWith: 'patterns/' } }, { namespace: 'patterns' }] },
        ]);
    });

    it('listByTenant translates the "other" category to a negated known-prefix filter', async () => {
        const repo = new AgentMemoryPostgresRepository();
        await repo.listByTenant({ tenantId: 't1', category: 'other' });

        const arg = mockPrisma.agentMemory.findMany.mock.calls[0][0];
        expect(arg.where.AND[0]).toHaveProperty('NOT.OR');
    });

    it('listByTenant searches key and value.fact', async () => {
        const repo = new AgentMemoryPostgresRepository();
        await repo.listByTenant({ tenantId: 't1', search: 'ecs' });

        const arg = mockPrisma.agentMemory.findMany.mock.calls[0][0];
        expect(arg.where.AND).toEqual([
            {
                OR: [
                    { key: { contains: 'ecs', mode: 'insensitive' } },
                    { value: { path: ['fact'], string_contains: 'ecs' } },
                ],
            },
        ]);
    });

    it('getById is scoped by tenantId — cross-tenant returns null', async () => {
        mockPrisma.agentMemory.findFirst.mockResolvedValue(null);
        const repo = new AgentMemoryPostgresRepository();
        const result = await repo.getById('other-tenant', 'mem-1');

        expect(mockPrisma.agentMemory.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'mem-1', tenantId: 'other-tenant' } })
        );
        expect(result).toBeNull();
    });

    it('deleteById deletes only the tenant-scoped row', async () => {
        const repo = new AgentMemoryPostgresRepository();
        await repo.deleteById('t1', 'mem-1');

        expect(getTenantClient).toHaveBeenCalledWith('t1');
        expect(mockPrisma.agentMemory.deleteMany).toHaveBeenCalledWith({
            where: { id: 'mem-1', tenantId: 't1' },
        });
    });
});
