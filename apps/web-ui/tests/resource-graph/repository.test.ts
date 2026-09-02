import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQueryRawUnsafe = vi.fn().mockResolvedValue([]);

vi.mock('@/lib/db/pg-config', () => ({
    getTenantClient: vi.fn(() => ({ $queryRawUnsafe: mockQueryRawUnsafe })),
}));

import { ResourceGraphPostgresRepository } from '@/lib/db/repositories/resource-graph/postgres';

describe('ResourceGraphPostgresRepository', () => {
    const repo = new ResourceGraphPostgresRepository();

    beforeEach(() => vi.clearAllMocks());

    it('binds tenantId as the first parameter on getNeighbors', async () => {
        await repo.getNeighbors({ tenantId: 't-1', resourceType: 'ec2_instances', resourceId: 'i-1' });

        const [sql, ...params] = mockQueryRawUnsafe.mock.calls[0];
        expect(sql).toContain('WITH RECURSIVE');
        expect(sql).toContain('"tenantId" = $1');
        expect(params[0]).toBe('t-1');
        expect(params[1]).toBe('ec2_instances');
        expect(params[2]).toBe('i-1');
    });

    it('walks inbound only for getBlastRadius', async () => {
        await repo.getBlastRadius({ tenantId: 't-1', resourceType: 'ec2_instances', resourceId: 'i-1' });

        const [sql] = mockQueryRawUnsafe.mock.calls[0];
        expect(sql).toContain('"toType" = $2');
        expect(sql).toContain('"toId" = $3');
    });

    it('clamps depth to 5 and limit to 500', async () => {
        await repo.getNeighbors({ tenantId: 't-1', resourceType: 'ec2_instances', resourceId: 'i-1', depth: 99, limit: 9999 });

        const params = mockQueryRawUnsafe.mock.calls[0].slice(1);
        expect(params).toContain(5);
        expect(params).toContain(500);
    });

    it('defaults depth to 1 for neighbors and 3 for blast radius', async () => {
        await repo.getNeighbors({ tenantId: 't-1', resourceType: 'ec2_instances', resourceId: 'i-1' });
        expect(mockQueryRawUnsafe.mock.calls[0].slice(1)).toContain(1);

        mockQueryRawUnsafe.mockClear();
        await repo.getBlastRadius({ tenantId: 't-1', resourceType: 'ec2_instances', resourceId: 'i-1' });
        expect(mockQueryRawUnsafe.mock.calls[0].slice(1)).toContain(3);
    });
});
