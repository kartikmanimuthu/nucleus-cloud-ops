import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { PermissionSet } from './types';

// Mock Prisma client before importing the service
vi.mock('@/lib/db/pg-config', () => ({
    getPrismaClient: vi.fn(),
}));

import { getPrismaClient } from '@/lib/db/pg-config';
import {
    createCustomRole,
    getCustomRoles,
    getCustomRole,
    updateCustomRole,
    deleteCustomRole,
    getCustomRolePermissions,
} from './custom-role-service';

const FULL_PERMISSIONS: PermissionSet = {
    Accounts: ['create', 'read', 'update', 'delete'],
    Schedules: ['create', 'read', 'update', 'delete'],
    AIOps: ['create', 'read', 'update', 'delete'],
    Inventory: ['create', 'read', 'update', 'delete'],
    Settings: ['create', 'read', 'update', 'delete'],
    CloudShell: ['create', 'read', 'update', 'delete'],
};

const MINIMAL_PERMISSIONS: PermissionSet = {
    Accounts: ['read'],
    Schedules: [],
    AIOps: [],
    Inventory: [],
    Settings: [],
    CloudShell: [],
};

const EMPTY_PERMISSIONS: PermissionSet = {
    Accounts: [],
    Schedules: [],
    AIOps: [],
    Inventory: [],
    Settings: [],
    CloudShell: [],
};

const MOCK_ROLE = {
    id: 'role-1',
    tenantId: 'tenant-1',
    name: 'DevOps',
    permissions: MINIMAL_PERMISSIONS,
    level: 1,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    createdBy: 'user@example.com',
};

// Build a fresh mock prisma object for each test
function buildMockPrisma() {
    const mockPrisma = {
        customRole: {
            create: vi.fn(),
            findMany: vi.fn(),
            findFirst: vi.fn(),
            update: vi.fn(),
            delete: vi.fn(),
            count: vi.fn(),
        },
        userTenantRole: {
            updateMany: vi.fn(),
        },
        $transaction: vi.fn(),
    };
    // Default: transaction passes through to callback
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma));
    return mockPrisma;
}

let mockPrisma: ReturnType<typeof buildMockPrisma>;

beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma = buildMockPrisma();
    (getPrismaClient as ReturnType<typeof vi.fn>).mockReturnValue(mockPrisma);
});

// ---------------------------------------------------------------------------
// createCustomRole
// ---------------------------------------------------------------------------

describe('createCustomRole', () => {
    it('returns role with auto-computed level', async () => {
        mockPrisma.customRole.count.mockResolvedValue(0);
        mockPrisma.customRole.create.mockResolvedValue({ ...MOCK_ROLE, level: 1 });

        const result = await createCustomRole('tenant-1', { name: 'DevOps', permissions: MINIMAL_PERMISSIONS }, 'user@example.com');

        expect(result.level).toBe(1);
        expect(mockPrisma.customRole.create).toHaveBeenCalledOnce();
        const createCall = mockPrisma.customRole.create.mock.calls[0][0];
        expect(createCall.data.level).toBe(1); // getAutoLevel(MINIMAL_PERMISSIONS) = 1 (only 1 action)
    });

    it('rejects when tenant already has 10 custom roles', async () => {
        mockPrisma.customRole.count.mockResolvedValue(10);

        await expect(
            createCustomRole('tenant-1', { name: 'NewRole', permissions: MINIMAL_PERMISSIONS }, 'user@example.com')
        ).rejects.toThrow('Maximum');
    });

    it('rejects duplicate name within same tenant (Prisma unique constraint)', async () => {
        mockPrisma.customRole.count.mockResolvedValue(0);
        const uniqueError = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        mockPrisma.customRole.create.mockRejectedValue(uniqueError);

        await expect(
            createCustomRole('tenant-1', { name: 'DevOps', permissions: MINIMAL_PERMISSIONS }, 'user@example.com')
        ).rejects.toThrow('already exists');
    });

    it('rejects predefined role names (case-insensitive)', async () => {
        for (const name of ['Owner', 'Admin', 'Member', 'Viewer', 'owner', 'ADMIN']) {
            await expect(
                createCustomRole('tenant-1', { name, permissions: MINIMAL_PERMISSIONS }, 'user@example.com')
            ).rejects.toThrow('predefined');
        }
    });

    it('rejects empty permissions (at least one action required)', async () => {
        await expect(
            createCustomRole('tenant-1', { name: 'EmptyRole', permissions: EMPTY_PERMISSIONS }, 'user@example.com')
        ).rejects.toThrow('permission');
    });
});

// ---------------------------------------------------------------------------
// getCustomRoles
// ---------------------------------------------------------------------------

describe('getCustomRoles', () => {
    it('returns only roles for the given tenantId', async () => {
        mockPrisma.customRole.findMany.mockResolvedValue([MOCK_ROLE]);

        const result = await getCustomRoles('tenant-1');

        expect(result).toHaveLength(1);
        expect(result[0].tenantId).toBe('tenant-1');
        expect(mockPrisma.customRole.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { tenantId: 'tenant-1' } })
        );
    });
});

// ---------------------------------------------------------------------------
// updateCustomRole
// ---------------------------------------------------------------------------

describe('updateCustomRole', () => {
    it('updates name and permissions, recomputes level', async () => {
        const updatedRole = { ...MOCK_ROLE, name: 'SeniorDevOps', permissions: FULL_PERMISSIONS, level: 4 };
        mockPrisma.customRole.update.mockResolvedValue(updatedRole);

        const result = await updateCustomRole('tenant-1', 'role-1', {
            name: 'SeniorDevOps',
            permissions: FULL_PERMISSIONS,
        });

        expect(result.level).toBe(4); // FULL_PERMISSIONS = 20 actions = Owner level
        expect(mockPrisma.customRole.update).toHaveBeenCalledOnce();
        const updateCall = mockPrisma.customRole.update.mock.calls[0][0];
        expect(updateCall.data.level).toBe(4);
        expect(updateCall.data.name).toBe('SeniorDevOps');
    });
});

// ---------------------------------------------------------------------------
// deleteCustomRole
// ---------------------------------------------------------------------------

describe('deleteCustomRole', () => {
    it('deletes the role and downgrades assigned users to Viewer', async () => {
        mockPrisma.customRole.delete.mockResolvedValue(MOCK_ROLE);
        mockPrisma.userTenantRole.updateMany.mockResolvedValue({ count: 2 });

        await deleteCustomRole('tenant-1', 'role-1');

        expect(mockPrisma.$transaction).toHaveBeenCalledOnce();
        expect(mockPrisma.customRole.delete).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'role-1' } })
        );
        expect(mockPrisma.userTenantRole.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { tenantId: 'tenant-1', role: MOCK_ROLE.name },
                data: { role: 'Viewer' },
            })
        );
    });
});

// ---------------------------------------------------------------------------
// getCustomRolePermissions
// ---------------------------------------------------------------------------

describe('getCustomRolePermissions', () => {
    it('returns PermissionSet for existing custom role', async () => {
        mockPrisma.customRole.findFirst.mockResolvedValue(MOCK_ROLE);

        const result = await getCustomRolePermissions('DevOps', 'tenant-1');

        expect(result).toEqual(MINIMAL_PERMISSIONS);
        expect(mockPrisma.customRole.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({ where: { tenantId: 'tenant-1', name: 'DevOps' } })
        );
    });

    it('returns null for non-existent role', async () => {
        mockPrisma.customRole.findFirst.mockResolvedValue(null);

        const result = await getCustomRolePermissions('NonExistent', 'tenant-1');

        expect(result).toBeNull();
    });
});
