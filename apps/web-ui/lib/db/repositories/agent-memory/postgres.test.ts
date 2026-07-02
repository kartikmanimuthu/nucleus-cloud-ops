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
    kind: 'SEMANTIC' as const,
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-02T00:00:00Z'),
    expiresAt: new Date('2026-09-01T00:00:00Z'),
    supersededById: null,
    supersededAt: null,
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

    it('listByTenant builds an OR of per-category predicates for multiple categories', async () => {
        const repo = new AgentMemoryPostgresRepository();
        await repo.listByTenant({ tenantId: 't1', categories: ['infra', 'user'] });

        const arg = mockPrisma.agentMemory.findMany.mock.calls[0][0];
        expect(arg.where.AND).toEqual([
            {
                OR: [
                    { OR: [{ namespace: { startsWith: 'infra/' } }, { namespace: 'infra' }] },
                    { OR: [{ namespace: { startsWith: 'user/' } }, { namespace: 'user' }] },
                ],
            },
        ]);
    });

    it('listByTenant with a single-element categories array keeps the bare per-category shape', async () => {
        const repo = new AgentMemoryPostgresRepository();
        await repo.listByTenant({ tenantId: 't1', categories: ['patterns'] });

        const arg = mockPrisma.agentMemory.findMany.mock.calls[0][0];
        expect(arg.where.AND).toEqual([
            { OR: [{ namespace: { startsWith: 'patterns/' } }, { namespace: 'patterns' }] },
        ]);
    });

    it('listByTenant defaults to updatedAt desc when no sort is requested', async () => {
        const repo = new AgentMemoryPostgresRepository();
        await repo.listByTenant({ tenantId: 't1' });

        const arg = mockPrisma.agentMemory.findMany.mock.calls[0][0];
        expect(arg.orderBy).toEqual({ updatedAt: 'desc' });
    });

    it('listByTenant maps a sort field + direction to orderBy', async () => {
        const repo = new AgentMemoryPostgresRepository();
        await repo.listByTenant({ tenantId: 't1', sortBy: 'createdAt', sortDir: 'asc' });

        const arg = mockPrisma.agentMemory.findMany.mock.calls[0][0];
        expect(arg.orderBy).toEqual({ createdAt: 'asc' });
    });

    it('listByTenant sorts category by the derived namespace column', async () => {
        const repo = new AgentMemoryPostgresRepository();
        await repo.listByTenant({ tenantId: 't1', sortBy: 'category', sortDir: 'desc' });

        const arg = mockPrisma.agentMemory.findMany.mock.calls[0][0];
        expect(arg.orderBy).toEqual({ namespace: 'desc' });
    });

    it('listByTenant paginates via skip/take and returns count as total', async () => {
        mockPrisma.agentMemory.count.mockResolvedValue(42);
        const repo = new AgentMemoryPostgresRepository();
        const result = await repo.listByTenant({ tenantId: 't1', page: 3, limit: 10 });

        const arg = mockPrisma.agentMemory.findMany.mock.calls[0][0];
        expect(arg.skip).toBe(20);
        expect(arg.take).toBe(10);
        expect(result.total).toBe(42);
    });

    it('listByTenant excludes superseded rows', async () => {
        const repo = new AgentMemoryPostgresRepository();
        await repo.listByTenant({ tenantId: 't1' });
        const arg = mockPrisma.agentMemory.findMany.mock.calls[0][0];
        expect(arg.where.supersededById).toBeNull();
    });

    it('getById still returns superseded rows with provenance fields', async () => {
        mockPrisma.agentMemory.findFirst.mockResolvedValueOnce(
            makeRow({ supersededById: 'mem-2', supersededAt: new Date('2026-07-01T00:00:00Z') }),
        );
        const repo = new AgentMemoryPostgresRepository();
        const rec = await repo.getById('t1', 'mem-1');
        expect(rec?.supersededById).toBe('mem-2');
        expect(rec?.supersededAt).toBe('2026-07-01T00:00:00.000Z');
    });

    it('maps episodic rows: category from namespace, fact falls back to outcome', async () => {
        mockPrisma.agentMemory.findFirst.mockResolvedValueOnce(makeRow({
            namespace: 'episodes',
            key: 'thread-th-9',
            kind: 'EPISODIC',
            value: { context: 'c', reasoning: 'r', action: 'a', outcome: 'SUCCEEDED — cycled tasks' },
        }));
        const repo = new AgentMemoryPostgresRepository();
        const rec = await repo.getById('t1', 'mem-1');
        expect(rec?.category).toBe('episodes');
        expect(rec?.fact).toBe('SUCCEEDED — cycled tasks');
    });
});
