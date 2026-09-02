import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFindMany, mockFindFirst, mockCreate, mockUpdateMany, mockDeleteMany } = vi.hoisted(() => ({
    mockFindMany: vi.fn(), mockFindFirst: vi.fn(), mockCreate: vi.fn(), mockUpdateMany: vi.fn(), mockDeleteMany: vi.fn(),
}));

// andWhere is real (importOriginal) — it's pure, and stubbing it would hide the
// row-filter composition listByTenant depends on for Gate 3 tenant-scoping.
vi.mock('@/lib/db/pg-config', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/db/pg-config')>()),
    getTenantClient: () => ({
        skill: { findMany: mockFindMany, findFirst: mockFindFirst, create: mockCreate, updateMany: mockUpdateMany, deleteMany: mockDeleteMany },
    }),
}));

import { SkillPostgresRepository } from './postgres';

const repo = new SkillPostgresRepository();

const ROW = {
    id: 'skill-1', tenantId: 'tenant-1', slug: 'deploy-runbook', name: 'Deploy Runbook',
    description: 'x', tier: 'sys', content: 'do x', source: 'human', isEnabled: true,
    createdBy: 'a@b.co', sourceRunId: null, createdAt: new Date(), updatedAt: new Date(),
};

beforeEach(() => {
    vi.clearAllMocks();
});

describe('listByTenant', () => {
    it('filters to enabled skills by default', async () => {
        mockFindMany.mockResolvedValue([ROW]);
        await repo.listByTenant('tenant-1');
        expect(mockFindMany.mock.calls[0][0].where).toEqual({ tenantId: 'tenant-1', isEnabled: true });
    });

    it('includes disabled skills when explicitly requested', async () => {
        mockFindMany.mockResolvedValue([]);
        await repo.listByTenant('tenant-1', { includeDisabled: true });
        expect(mockFindMany.mock.calls[0][0].where).toEqual({ tenantId: 'tenant-1' });
    });

    it('intersects a Gate-3 row filter under AND', async () => {
        mockFindMany.mockResolvedValue([]);
        await repo.listByTenant('tenant-1', { rowFilter: { accountId: { in: ['a1'] } } });
        expect(mockFindMany.mock.calls[0][0].where.AND).toEqual([{ accountId: { in: ['a1'] } }]);
    });

    it('orders by name and returns transformed records', async () => {
        mockFindMany.mockResolvedValue([ROW]);
        const result = await repo.listByTenant('tenant-1');
        expect(mockFindMany.mock.calls[0][0].orderBy).toEqual({ name: 'asc' });
        expect(result[0].tier).toBe('sys');
    });
});

describe('getBySlug', () => {
    it('scopes by tenantId and slug', async () => {
        mockFindFirst.mockResolvedValue(ROW);
        await repo.getBySlug('tenant-1', 'deploy-runbook');
        expect(mockFindFirst).toHaveBeenCalledWith({ where: { tenantId: 'tenant-1', slug: 'deploy-runbook' } });
    });

    it('returns null when not found', async () => {
        mockFindFirst.mockResolvedValue(null);
        expect(await repo.getBySlug('tenant-1', 'missing')).toBeNull();
    });
});

describe('getById', () => {
    it('scopes by tenantId and id', async () => {
        mockFindFirst.mockResolvedValue(ROW);
        await repo.getById('tenant-1', 'skill-1');
        expect(mockFindFirst).toHaveBeenCalledWith({ where: { tenantId: 'tenant-1', id: 'skill-1' } });
    });

    it('returns null when not found', async () => {
        mockFindFirst.mockResolvedValue(null);
        expect(await repo.getById('tenant-1', 'missing')).toBeNull();
    });
});

describe('create', () => {
    it('binds tenantId explicitly on create', async () => {
        mockCreate.mockResolvedValue(ROW);
        await repo.create('tenant-1', {
            slug: 'x', name: 'x', description: 'x', tier: 'sys', content: 'x', source: 'human', isEnabled: true,
        } as any);
        expect(mockCreate.mock.calls[0][0].data.tenantId).toBe('tenant-1');
    });
});

describe('update', () => {
    it('scopes updateMany by tenantId+id, then re-fetches the row', async () => {
        mockUpdateMany.mockResolvedValue({ count: 1 });
        mockFindFirst.mockResolvedValue({ ...ROW, name: 'Renamed' });

        const result = await repo.update('tenant-1', 'skill-1', { name: 'Renamed' });

        expect(mockUpdateMany).toHaveBeenCalledWith({ where: { tenantId: 'tenant-1', id: 'skill-1' }, data: { name: 'Renamed' } });
        expect(result.name).toBe('Renamed');
    });

    it('throws when the row is gone after the update (cross-tenant id or race)', async () => {
        mockUpdateMany.mockResolvedValue({ count: 0 });
        mockFindFirst.mockResolvedValue(null);
        await expect(repo.update('tenant-1', 'skill-x', { name: 'x' })).rejects.toThrow('Skill skill-x not found after update');
    });
});

describe('remove', () => {
    it('scopes the delete by tenantId+id', async () => {
        mockDeleteMany.mockResolvedValue({ count: 1 });
        await repo.remove('tenant-1', 'skill-1');
        expect(mockDeleteMany).toHaveBeenCalledWith({ where: { tenantId: 'tenant-1', id: 'skill-1' } });
    });
});
