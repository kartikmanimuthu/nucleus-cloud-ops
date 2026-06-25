import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';

vi.mock('@/lib/db/pg-config', () => ({
    getPrismaClient: vi.fn(),
}));

import { getPrismaClient } from '@/lib/db/pg-config';
import { RbacPostgresRepository } from './postgres';

type MockUserTenantRole = {
    findUnique: MockedFunction<(...args: unknown[]) => unknown>;
    findMany: MockedFunction<(...args: unknown[]) => unknown>;
    upsert: MockedFunction<(...args: unknown[]) => unknown>;
};

const makeRoleRecord = (overrides: Partial<{
    userId: string;
    tenantId: string;
    email: string;
    role: string;
    assignedAt: Date;
    assignedBy: string;
}> = {}) => ({
    userId: 'user-1',
    tenantId: 'tenant-1',
    email: 'user@example.com',
    role: 'admin',
    assignedAt: new Date('2025-01-01T00:00:00Z'),
    assignedBy: 'admin@example.com',
    ...overrides,
});

describe('RbacPostgresRepository', () => {
    let repo: RbacPostgresRepository;
    let mockUserTenantRole: MockUserTenantRole;

    beforeEach(() => {
        mockUserTenantRole = {
            findUnique: vi.fn(),
            findMany: vi.fn(),
            upsert: vi.fn(),
        };
        vi.mocked(getPrismaClient).mockReturnValue({ userTenantRole: mockUserTenantRole } as never);
        repo = new RbacPostgresRepository();
    });

    describe('getUserTenantRole', () => {
        it('calls findUnique with compound key { userId, tenantId }', async () => {
            mockUserTenantRole.findUnique.mockResolvedValueOnce(makeRoleRecord());

            await repo.getUserTenantRole('user-1', 'tenant-1');

            expect(mockUserTenantRole.findUnique).toHaveBeenCalledWith({
                where: {
                    userId_tenantId: { userId: 'user-1', tenantId: 'tenant-1' },
                },
            });
        });

        it('returns role string when record found', async () => {
            mockUserTenantRole.findUnique.mockResolvedValueOnce(makeRoleRecord({ role: 'editor' }));

            const result = await repo.getUserTenantRole('user-1', 'tenant-1');

            expect(result).toBe('editor');
        });

        it('returns null when record not found', async () => {
            mockUserTenantRole.findUnique.mockResolvedValueOnce(null);

            const result = await repo.getUserTenantRole('user-missing', 'tenant-1');

            expect(result).toBeNull();
        });
    });

    describe('getUserAllRoles', () => {
        it('queries findMany with { where: { userId } }', async () => {
            mockUserTenantRole.findMany.mockResolvedValueOnce([]);

            await repo.getUserAllRoles('user-all');

            expect(mockUserTenantRole.findMany).toHaveBeenCalledWith(
                expect.objectContaining({ where: { userId: 'user-all' } })
            );
        });

        it('returns mapped UserTenantRole array with PK/SK/EntityType fields', async () => {
            mockUserTenantRole.findMany.mockResolvedValueOnce([
                makeRoleRecord({ userId: 'user-mapped', tenantId: 'tenant-mapped' }),
            ]);

            const result = await repo.getUserAllRoles('user-mapped');

            expect(result).toHaveLength(1);
            expect(result[0].PK).toBe('USER#user-mapped');
            expect(result[0].SK).toBe('TENANT#tenant-mapped');
            expect(result[0].EntityType).toBe('UserTenantRole');
        });
    });

    describe('assignUserRole', () => {
        it('calls prisma.userTenantRole.upsert with correct shape', async () => {
            mockUserTenantRole.upsert.mockResolvedValueOnce({});

            await repo.assignUserRole('user-1', 'user@example.com', 'tenant-1', 'admin', 'admin@example.com');

            expect(mockUserTenantRole.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: {
                        userId_tenantId: { userId: 'user-1', tenantId: 'tenant-1' },
                    },
                    create: expect.objectContaining({
                        userId: 'user-1',
                        email: 'user@example.com',
                        tenantId: 'tenant-1',
                        role: 'admin',
                        assignedBy: 'admin@example.com',
                    }),
                    update: expect.objectContaining({
                        role: 'admin',
                        email: 'user@example.com',
                        assignedBy: 'admin@example.com',
                    }),
                })
            );
        });

        it('does not throw on successful upsert', async () => {
            mockUserTenantRole.upsert.mockResolvedValueOnce({});

            await expect(
                repo.assignUserRole('user-2', 'u2@example.com', 'tenant-2', 'viewer', 'assigner@example.com')
            ).resolves.toBeUndefined();
        });
    });

    describe('getTenantUsers', () => {
        it('calls findMany with { where: { tenantId } }', async () => {
            mockUserTenantRole.findMany.mockResolvedValueOnce([]);

            await repo.getTenantUsers('tenant-abc');

            expect(mockUserTenantRole.findMany).toHaveBeenCalledWith(
                expect.objectContaining({ where: { tenantId: 'tenant-abc' } })
            );
        });

        it('returns mapped UserTenantRole array', async () => {
            mockUserTenantRole.findMany.mockResolvedValueOnce([
                makeRoleRecord({ userId: 'u1', tenantId: 'tenant-abc', role: 'viewer' }),
            ]);

            const result = await repo.getTenantUsers('tenant-abc');

            expect(result).toHaveLength(1);
            expect(result[0].userId).toBe('u1');
            expect(result[0].role).toBe('viewer');
        });
    });
});
