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

type MockCustomRole = {
    findFirst: MockedFunction<(...args: unknown[]) => unknown>;
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
    let mockCustomRole: MockCustomRole;

    beforeEach(() => {
        mockUserTenantRole = {
            findUnique: vi.fn(),
            findMany: vi.fn(),
            upsert: vi.fn(),
        };
        // assignUserRole resolves the CustomRole row so it can populate the
        // UserTenantRole.roleId FK the CASL rule compiler reads from.
        mockCustomRole = {
            findFirst: vi.fn().mockResolvedValue(null),
        };
        vi.mocked(getPrismaClient).mockReturnValue({
            userTenantRole: mockUserTenantRole,
            customRole: mockCustomRole,
        } as never);
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

        it('resolves the CustomRole for the tenant and threads its id into roleId', async () => {
            mockCustomRole.findFirst.mockResolvedValueOnce({ id: 'role-abc' });
            mockUserTenantRole.upsert.mockResolvedValueOnce({});

            await repo.assignUserRole('user-3', 'u3@example.com', 'tenant-3', 'admin', 'assigner@example.com');

            expect(mockCustomRole.findFirst).toHaveBeenCalledWith({
                where: { tenantId: 'tenant-3', name: 'admin' },
            });
            expect(mockUserTenantRole.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    create: expect.objectContaining({ roleId: 'role-abc' }),
                    update: expect.objectContaining({ roleId: 'role-abc' }),
                })
            );
        });

        it('writes roleId null when no CustomRole matches the role name', async () => {
            mockCustomRole.findFirst.mockResolvedValueOnce(null);
            mockUserTenantRole.upsert.mockResolvedValueOnce({});

            await repo.assignUserRole('user-4', 'u4@example.com', 'tenant-4', 'viewer', 'assigner@example.com');

            expect(mockUserTenantRole.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    create: expect.objectContaining({ roleId: null }),
                    update: expect.objectContaining({ roleId: null }),
                })
            );
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

    describe('error wrapping', () => {
        it('getUserTenantRole wraps a DB failure', async () => {
            mockUserTenantRole.findUnique.mockRejectedValueOnce(new Error('DB down'));
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            await expect(repo.getUserTenantRole('u1', 't1')).rejects.toThrow('Failed to get user tenant role: DB down');
            consoleSpy.mockRestore();
        });

        it('getUserAllRoles wraps a DB failure', async () => {
            mockUserTenantRole.findMany.mockRejectedValueOnce(new Error('DB down'));
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            await expect(repo.getUserAllRoles('u1')).rejects.toThrow('Failed to get user roles: DB down');
            consoleSpy.mockRestore();
        });

        it('assignUserRole wraps a DB failure', async () => {
            mockUserTenantRole.upsert.mockRejectedValueOnce(new Error('DB down'));
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            await expect(repo.assignUserRole('u1', 'e@b.co', 't1', 'admin', 'a@b.co')).rejects.toThrow('Failed to assign user role: DB down');
            consoleSpy.mockRestore();
        });

        it('getTenantUsers wraps a DB failure', async () => {
            mockUserTenantRole.findMany.mockRejectedValueOnce(new Error('DB down'));
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            await expect(repo.getTenantUsers('t1')).rejects.toThrow('Failed to get tenant users: DB down');
            consoleSpy.mockRestore();
        });

        it('stringifies a non-Error throw in each wrapped message', async () => {
            mockUserTenantRole.findUnique.mockRejectedValueOnce('raw failure');
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            await expect(repo.getUserTenantRole('u1', 't1')).rejects.toThrow('Failed to get user tenant role: raw failure');
            consoleSpy.mockRestore();
        });

        it('stringifies a non-Error throw for getUserAllRoles, assignUserRole, and getTenantUsers', async () => {
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            mockUserTenantRole.findMany.mockRejectedValueOnce('raw failure');
            await expect(repo.getUserAllRoles('u1')).rejects.toThrow('Failed to get user roles: raw failure');

            mockUserTenantRole.upsert.mockRejectedValueOnce('raw failure');
            await expect(repo.assignUserRole('u1', 'e@b.co', 't1', 'admin', 'a@b.co')).rejects.toThrow('Failed to assign user role: raw failure');

            mockUserTenantRole.findMany.mockRejectedValueOnce('raw failure');
            await expect(repo.getTenantUsers('t1')).rejects.toThrow('Failed to get tenant users: raw failure');

            consoleSpy.mockRestore();
        });
    });
});
