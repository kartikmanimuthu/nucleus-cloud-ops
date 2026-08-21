import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { PermissionSet } from './types';
import type { SubjectOverrides } from './role-subject-overrides';

// Mock Prisma client before importing the service
vi.mock('@/lib/db/pg-config', () => ({
    getPrismaClient: vi.fn(),
}));

/**
 * runRbacMutation owns the transaction, lockout assertion, ledger append and
 * version bump, and is covered by its own suite. Here it is reduced to 'run the
 * callback' so these remain unit tests of the ROLE service; what matters is that
 * every mutation goes through it, which the assertions below pin.
 */
vi.mock('./registry-service', () => ({
    runRbacMutation: vi.fn(async (_input: unknown, work: (tx: unknown) => Promise<unknown>) =>
        work((getPrismaClient as ReturnType<typeof vi.fn>)())
    ),
}));

vi.mock('./role-rule-sync', () => ({
    syncRoleRules: vi.fn(async () => ({ created: 0, deleted: 0, skipped: [] })),
}));

// Unmocked, this is the real set-reconciler running against the fake tx, which
// requires rbacRoleRule.createMany/deleteMany that buildMockPrisma doesn't
// provide. Mocked here — same idiom as role-rule-sync above — so the tests
// below can assert what the service PASSED to it, which is the only way to
// observe the castRole(role, input.overrides ?? {}) wiring at all: nothing
// about the mock's own behavior can prove the caller forwarded overrides
// correctly.
vi.mock('./role-subject-overrides', () => ({
    syncRoleSubjectOverrides: vi.fn(async () => ({ created: 0, deleted: 0, skipped: [] })),
}));

import { getPrismaClient } from '@/lib/db/pg-config';
import { ROLE_PERMISSIONS } from './permissions';
import { runRbacMutation } from './registry-service';
import { syncRoleRules } from './role-rule-sync';
import { syncRoleSubjectOverrides } from './role-subject-overrides';
import {
    createCustomRole,
    getCustomRoles,
    getCustomRole,
    updateCustomRole,
    deleteCustomRole,
    getCustomRolePermissions,
    getPresetRoles,
} from './custom-role-service';

const FULL_PERMISSIONS: PermissionSet = {
    Accounts: ['create', 'read', 'update', 'delete'],
    Schedules: ['create', 'read', 'update', 'delete'],
    AIOps: ['create', 'read', 'update', 'delete'],
    Inventory: ['create', 'read', 'update', 'delete'],
    Settings: ['create', 'read', 'update', 'delete'],
    Dashboard: ['read'],
};

const MINIMAL_PERMISSIONS: PermissionSet = {
    Accounts: ['read'],
    Schedules: [],
    AIOps: [],
    Inventory: [],
    Settings: [],
    Dashboard: [],
};

const EMPTY_PERMISSIONS: PermissionSet = {
    Accounts: [],
    Schedules: [],
    AIOps: [],
    Inventory: [],
    Settings: [],
    Dashboard: [],
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

const ACTOR = { userId: 'user-1', email: 'user@example.com' };

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
        // Read by loadAdminRegistry() (registry-admin.ts), which createCustomRole
        // and updateCustomRole now call to get the grantable-cell ceiling for
        // getAutoLevel(). Not mocked away like registry-service/role-rule-sync
        // above: it's the real implementation running against this fake client,
        // so its Promise.all needs every one of these to resolve.
        rbacModule: { findMany: vi.fn() },
        rbacAction: { findMany: vi.fn() },
        rbacSubject: { findMany: vi.fn() },
        rbacSubjectModule: { findMany: vi.fn() },
        rbacModuleAction: { findMany: vi.fn() },
        // findMany is read by loadRoleModuleGrants() (preset grants); groupBy by
        // loadAdminRegistry() (rule counts).
        rbacRoleRule: { findMany: vi.fn(), groupBy: vi.fn() },
        $transaction: vi.fn(),
    };
    // Both real registry readers run against this fake client and Promise.all every
    // one of these, so each needs to resolve even in tests that care about none of
    // them. Empty is the honest default: no registry, no rules.
    mockPrisma.rbacModule.findMany.mockResolvedValue([]);
    mockPrisma.rbacAction.findMany.mockResolvedValue([]);
    mockPrisma.rbacSubject.findMany.mockResolvedValue([]);
    mockPrisma.rbacSubjectModule.findMany.mockResolvedValue([]);
    mockPrisma.rbacModuleAction.findMany.mockResolvedValue([]);
    mockPrisma.rbacRoleRule.findMany.mockResolvedValue([]);
    mockPrisma.rbacRoleRule.groupBy.mockResolvedValue([]);
    // Default: transaction passes through to callback
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma));
    return mockPrisma;
}

/**
 * loadAdminRegistry() is now on the path of every role level computation, so
 * it must resolve to something even in tests that don't care about the
 * registry. Default: 21 grantable cells — one action per module, `count` of
 * them — which reproduces the legacy static Owner ceiling (21 actions), so
 * every pre-existing level assertion in this file keeps meaning what it did
 * before this wiring existed. The test that cares about the ceiling itself
 * overrides this with a different count.
 */
function mockGrantableCells(prisma: ReturnType<typeof buildMockPrisma>, count: number) {
    const cells = Array.from({ length: count }, (_, i) => ({
        moduleId: `m${i}`,
        actionId: `a${i}`,
        grantable: true,
    }));
    prisma.rbacModule.findMany.mockResolvedValue(
        cells.map((c) => ({ id: c.moduleId, key: c.moduleId, tenantId: null }))
    );
    prisma.rbacAction.findMany.mockResolvedValue(
        cells.map((c) => ({ id: c.actionId, key: c.actionId, tenantId: null }))
    );
    prisma.rbacSubject.findMany.mockResolvedValue([]);
    prisma.rbacSubjectModule.findMany.mockResolvedValue([]);
    prisma.rbacModuleAction.findMany.mockResolvedValue(cells);
    prisma.rbacRoleRule.groupBy.mockResolvedValue([]);
}

let mockPrisma: ReturnType<typeof buildMockPrisma>;

beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma = buildMockPrisma();
    (getPrismaClient as ReturnType<typeof vi.fn>).mockReturnValue(mockPrisma);
    mockGrantableCells(mockPrisma, 21);
});

// ---------------------------------------------------------------------------
// createCustomRole
// ---------------------------------------------------------------------------

describe('createCustomRole', () => {
    it('returns role with auto-computed level', async () => {
        mockPrisma.customRole.count.mockResolvedValue(0);
        mockPrisma.customRole.create.mockResolvedValue({ ...MOCK_ROLE, level: 1 });

        const result = await createCustomRole('tenant-1', { name: 'DevOps', permissions: MINIMAL_PERMISSIONS }, ACTOR);

        expect(result.level).toBe(1);
        expect(mockPrisma.customRole.create).toHaveBeenCalledOnce();
        const createCall = mockPrisma.customRole.create.mock.calls[0][0];
        expect(createCall.data.level).toBe(1); // getAutoLevel(MINIMAL_PERMISSIONS) = 1 (only 1 action)
    });

    it('rejects when tenant already has 10 custom roles', async () => {
        mockPrisma.customRole.count.mockResolvedValue(10);

        await expect(
            createCustomRole('tenant-1', { name: 'NewRole', permissions: MINIMAL_PERMISSIONS }, ACTOR)
        ).rejects.toThrow('Maximum');
    });

    it('rejects duplicate name within same tenant (Prisma unique constraint)', async () => {
        mockPrisma.customRole.count.mockResolvedValue(0);
        const uniqueError = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        mockPrisma.customRole.create.mockRejectedValue(uniqueError);

        await expect(
            createCustomRole('tenant-1', { name: 'DevOps', permissions: MINIMAL_PERMISSIONS }, ACTOR)
        ).rejects.toThrow('already exists');
    });

    it('rejects predefined role names (case-insensitive)', async () => {
        for (const name of ['Owner', 'Admin', 'Member', 'Viewer', 'owner', 'ADMIN']) {
            await expect(
                createCustomRole('tenant-1', { name, permissions: MINIMAL_PERMISSIONS }, ACTOR)
            ).rejects.toThrow('predefined');
        }
    });

    it('rejects empty permissions (at least one action required)', async () => {
        await expect(
            createCustomRole('tenant-1', { name: 'EmptyRole', permissions: EMPTY_PERMISSIONS }, ACTOR)
        ).rejects.toThrow('permission');
    });

    /**
     * FINDING 3: hasAnyPermission (use-matrix-state.ts, client-side Save gate)
     * counts a subject-level override grant as "the role has a permission".
     * Before the fix, the server's validateInput counted ONLY module-level
     * actions, so a role with zero module grants and one subject override
     * grant — fully valid to the CASL compiler — passed the client's Save
     * gate and then threw a raw 500 here.
     */
    it('does NOT reject a role with zero module permissions but a subject-level override grant', async () => {
        mockPrisma.customRole.count.mockResolvedValue(0);
        mockPrisma.customRole.create.mockResolvedValue({ ...MOCK_ROLE, name: 'ProviderReader', permissions: EMPTY_PERMISSIONS, level: 0 });
        const overrides: SubjectOverrides = { Provider: { grant: ['read'], deny: [] } };

        await expect(
            createCustomRole(
                'tenant-1',
                { name: 'ProviderReader', permissions: EMPTY_PERMISSIONS, overrides },
                ACTOR
            )
        ).resolves.toBeDefined();
    });

    it('still rejects when overrides exist but contain only denies (no grant)', async () => {
        const overrides: SubjectOverrides = { Provider: { grant: [], deny: ['read'] } };

        await expect(
            createCustomRole(
                'tenant-1',
                { name: 'EmptyRole', permissions: EMPTY_PERMISSIONS, overrides },
                ACTOR
            )
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
            expect.objectContaining({ where: { tenantId: 'tenant-1', type: 'custom' }, orderBy: { name: 'asc' } })
        );
    });
});

// ---------------------------------------------------------------------------
// updateCustomRole
// ---------------------------------------------------------------------------

describe('updateCustomRole', () => {
    it('updates name and permissions, recomputes level', async () => {
        // update/delete now read the role first so the ledger can record a
        // `before` snapshot, and so a missing role fails before the write.
        mockPrisma.customRole.findFirst.mockResolvedValue(MOCK_ROLE);
        const updatedRole = { ...MOCK_ROLE, name: 'SeniorDevOps', permissions: FULL_PERMISSIONS, level: 4 };
        mockPrisma.customRole.update.mockResolvedValue(updatedRole);

        const result = await updateCustomRole('tenant-1', 'role-1', {
            name: 'SeniorDevOps',
            permissions: FULL_PERMISSIONS,
        }, ACTOR);

        expect(result.level).toBe(4); // FULL_PERMISSIONS = 21 actions = Owner level
        expect(mockPrisma.customRole.update).toHaveBeenCalledOnce();
        const updateCall = mockPrisma.customRole.update.mock.calls[0][0];
        expect(updateCall.data.level).toBe(4);
        expect(updateCall.data.name).toBe('SeniorDevOps');
    });

    // FINDING 3, update side: same gap as createCustomRole above — a save that
    // clears every module permission but leaves a subject-level override grant
    // in place must not throw.
    it('does NOT reject an update with zero module permissions but a subject-level override grant', async () => {
        mockPrisma.customRole.findFirst.mockResolvedValue(MOCK_ROLE);
        mockPrisma.customRole.update.mockResolvedValue({ ...MOCK_ROLE, permissions: EMPTY_PERMISSIONS, level: 0 });
        const overrides: SubjectOverrides = { Provider: { grant: ['read'], deny: [] } };

        await expect(
            updateCustomRole('tenant-1', 'role-1', { name: 'DevOps', permissions: EMPTY_PERMISSIONS, overrides }, ACTOR)
        ).resolves.toBeDefined();
    });
});

// ---------------------------------------------------------------------------
// deleteCustomRole
// ---------------------------------------------------------------------------

describe('deleteCustomRole', () => {
    it('deletes the role and downgrades assigned users to Viewer', async () => {
        // update/delete now read the role first so the ledger can record a
        // `before` snapshot, and so a missing role fails before the write.
        mockPrisma.customRole.findFirst.mockResolvedValue(MOCK_ROLE);
        mockPrisma.customRole.delete.mockResolvedValue(MOCK_ROLE);
        mockPrisma.userTenantRole.updateMany.mockResolvedValue({ count: 2 });

        await deleteCustomRole('tenant-1', 'role-1', ACTOR);

        // The transaction now belongs to runRbacMutation, so asserting on
        // $transaction would only prove the mock. What matters is that delete
        // goes through the audited write path at all: it is what bumps the RBAC
        // version, without which cached abilities keep granting a deleted role.
        expect(runRbacMutation).toHaveBeenCalledOnce();
        expect((runRbacMutation as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
            entityType: 'role',
            entityId: 'role-1',
            operation: 'delete',
        });
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
            expect.objectContaining({
                where: {
                    OR: [
                        { tenantId: 'tenant-1', name: 'DevOps', type: 'custom' },
                        { type: 'preset', name: 'DevOps' },
                    ],
                },
                orderBy: { type: 'asc' },
            })
        );
    });

    it('returns null for non-existent role', async () => {
        mockPrisma.customRole.findFirst.mockResolvedValue(null);

        const result = await getCustomRolePermissions('NonExistent', 'tenant-1');

        expect(result).toBeNull();
    });
});

describe('getPresetRoles', () => {
    // REGRESSION: preset rows are created ONLY by libs/prisma/seed.ts, and the container
    // entrypoint runs `prisma migrate deploy` and never the seed. Any environment that was not
    // manually seeded therefore had none, this returned [], and the invite-a-member dialog's Role
    // dropdown was empty — you could not invite anyone at all.
    it('returns all four predefined roles when the DB has none', async () => {
        const mockPrisma = buildMockPrisma();
        mockPrisma.customRole.findMany.mockResolvedValue([]);
        vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as never);

        const roles = await getPresetRoles();

        expect(roles.map((r) => r.name)).toEqual(['Owner', 'Admin', 'Member', 'Viewer']);
        expect(roles.map((r) => r.level)).toEqual([4, 3, 2, 1]);
        // Permissions must be real, not empty — the roles page renders them.
        expect(Object.values(roles[0].permissions).flat().length).toBeGreaterThan(0);
    });

    it('is ordered by level descending, so Owner leads', async () => {
        const mockPrisma = buildMockPrisma();
        mockPrisma.customRole.findMany.mockResolvedValue([]);
        vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as never);

        const levels = (await getPresetRoles()).map((r) => r.level);
        expect(levels).toEqual([...levels].sort((a, b) => b - a));
    });

    it('prefers a seeded DB row over the synthesized one', async () => {
        // A seeded environment must behave exactly as before, and an edited preset must survive.
        const mockPrisma = buildMockPrisma();
        mockPrisma.customRole.findMany.mockResolvedValue([
            { ...MOCK_ROLE, id: 'preset-owner', tenantId: null, name: 'Owner', level: 4 },
        ]);
        vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as never);

        const roles = await getPresetRoles();
        const owner = roles.find((r) => r.name === 'Owner')!;
        expect(owner.createdBy).toBe('user@example.com'); // from the DB row, not 'system'
        expect(roles).toHaveLength(4); // the other three still filled in
    });

    it('uses the ids the seed would have used, so a later seed is a no-op upsert', async () => {
        const mockPrisma = buildMockPrisma();
        mockPrisma.customRole.findMany.mockResolvedValue([]);
        vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as never);

        expect((await getPresetRoles()).map((r) => r.id)).toEqual([
            'preset-owner',
            'preset-admin',
            'preset-member',
            'preset-viewer',
        ]);
    });

    /**
     * The shape a database built by `migrate deploy` actually has: the four preset rows
     * exist with an EMPTY legacy blob (20260730000000_dynamic_abac writes '{}'::jsonb on
     * purpose) and the grants live in rbac_role_rules.
     */
    function presetRowWithEmptyBlob(name: string, level: number) {
        return {
            id: `preset-${name.toLowerCase()}`,
            tenantId: null,
            name,
            permissions: {},
            level,
            createdAt: new Date('2026-01-01'),
            updatedAt: new Date('2026-01-01'),
            createdBy: 'system',
        };
    }

    function mockRules(
        prisma: ReturnType<typeof buildMockPrisma>,
        rules: Array<{ roleId: string; moduleKey: string; actionKey: string }>,
        registry?: { modules?: Array<{ id: string; key: string; tenantId: string | null }> }
    ) {
        const moduleKeys = [...new Set(rules.map((r) => r.moduleKey))];
        const actionKeys = [...new Set(rules.map((r) => r.actionKey))];
        prisma.rbacModule.findMany.mockResolvedValue(
            registry?.modules ?? moduleKeys.map((k) => ({ id: `mod-${k}`, key: k, tenantId: null }))
        );
        prisma.rbacAction.findMany.mockResolvedValue(
            actionKeys.map((k) => ({ id: `act-${k}`, key: k, tenantId: null }))
        );
        prisma.rbacRoleRule.findMany.mockResolvedValue(
            rules.map((r, i) => ({
                id: `rule-${i}`,
                tenantId: null,
                roleId: r.roleId,
                moduleId: `mod-${r.moduleKey}`,
                actionId: `act-${r.actionKey}`,
                subjectId: null,
                inverted: false,
            }))
        );
    }

    // REGRESSION: the Roles screen read `custom_roles.permissions` and the dynamic_abac
    // migration empties that blob for presets on purpose, so every preset card said
    // "No permissions" on every deployed environment while the roles in fact granted
    // everything. Read the rules instead — the same rows the CASL engine reads.
    it('reads preset grants from rbac_role_rules, not the empty legacy blob', async () => {
        const mockPrisma = buildMockPrisma();
        mockPrisma.customRole.findMany.mockResolvedValue([presetRowWithEmptyBlob('Owner', 4)]);
        mockRules(mockPrisma, [
            { roleId: 'preset-owner', moduleKey: 'Accounts', actionKey: 'read' },
            { roleId: 'preset-owner', moduleKey: 'Accounts', actionKey: 'create' },
            { roleId: 'preset-owner', moduleKey: 'Dashboard', actionKey: 'read' },
        ]);
        vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as never);

        const owner = (await getPresetRoles('tenant-1')).find((r) => r.name === 'Owner')!;

        // Sorted into the grid's column order, not insertion order.
        expect(owner.permissions).toEqual({ Accounts: ['create', 'read'], Dashboard: ['read'] });
    });

    // A preset with no rules means the registry seed never ran. authorize() is still
    // resolving presets from ROLE_PERMISSIONS in that state (the legacy path is the
    // default and what production runs), so the card must show those, not nothing.
    it('falls back to the code matrix when a preset has no rules at all', async () => {
        const mockPrisma = buildMockPrisma();
        mockPrisma.customRole.findMany.mockResolvedValue([presetRowWithEmptyBlob('Owner', 4)]);
        vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as never);

        const owner = (await getPresetRoles('tenant-1')).find((r) => r.name === 'Owner')!;

        // Compared against the live constant, not this file's FULL_PERMISSIONS: the matrix
        // gained IAM when Members/Roles split out of Settings, and this assertion is about
        // the fallback reaching ROLE_PERMISSIONS at all, whatever it currently holds.
        expect(owner.permissions).toEqual(ROLE_PERMISSIONS.Owner);
    });

    // The shadowed-id trap documented in loadAdminRegistry(): a preset rule points at the
    // GLOBAL module id and is never rewritten when a tenant authors an override of the
    // same key. Resolving ids against only the winning rows drops every preset grant on
    // exactly the tenants that have customised something.
    it('resolves a preset rule pointing at the global module id a tenant override shadows', async () => {
        const mockPrisma = buildMockPrisma();
        mockPrisma.customRole.findMany.mockResolvedValue([presetRowWithEmptyBlob('Viewer', 1)]);
        mockRules(
            mockPrisma,
            [{ roleId: 'preset-viewer', moduleKey: 'Accounts', actionKey: 'read' }],
            {
                modules: [
                    { id: 'mod-Accounts', key: 'Accounts', tenantId: null }, // what the rule points at
                    { id: 'tenant-mod-Accounts', key: 'Accounts', tenantId: 'tenant-1' }, // the override
                ],
            }
        );
        vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as never);

        const viewer = (await getPresetRoles('tenant-1')).find((r) => r.name === 'Viewer')!;

        expect(viewer.permissions).toEqual({ Accounts: ['read'] });
    });

    // Subject-level and `cannot` rules cannot be expressed in a Record<Module, Action[]>,
    // so they are excluded in the QUERY rather than flattened into a shape that would
    // misstate them. Asserted on the where clause because that filtering is the database's.
    it('asks only for module-level positive rules', async () => {
        const mockPrisma = buildMockPrisma();
        mockPrisma.customRole.findMany.mockResolvedValue([presetRowWithEmptyBlob('Owner', 4)]);
        vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as never);

        await getPresetRoles('tenant-1');

        expect(mockPrisma.rbacRoleRule.findMany).toHaveBeenCalledWith({
            where: expect.objectContaining({
                roleId: { in: ['preset-owner'] },
                subjectId: null,
                inverted: false,
            }),
        });
    });
});

/**
 * The gap this wiring closed: the roles screen wrote `custom_roles.permissions`
 * while CASL read `rbac_role_rules`, and nothing connected them. With
 * DYNAMIC_ABAC_ENABLED on that made role edits silently inert — accepted, saved,
 * and with no effect on anyone's access.
 *
 * These pin the connection itself, so it cannot be dropped without a red test.
 */
describe('role mutations reach the CASL engine', () => {
    it('create projects the permission blob onto rbac_role_rules', async () => {
        mockPrisma.customRole.count.mockResolvedValue(0);
        mockPrisma.customRole.create.mockResolvedValue({ ...MOCK_ROLE, level: 1 });

        await createCustomRole('tenant-1', { name: 'DevOps', permissions: MINIMAL_PERMISSIONS }, ACTOR);

        expect(syncRoleRules).toHaveBeenCalledOnce();
        expect((syncRoleRules as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({
            roleId: MOCK_ROLE.id,
            tenantId: 'tenant-1',
            permissions: MINIMAL_PERMISSIONS,
        });
    });

    it('update re-syncs, so revoking a permission actually revokes it', async () => {
        mockPrisma.customRole.findFirst.mockResolvedValue(MOCK_ROLE);
        mockPrisma.customRole.update.mockResolvedValue({ ...MOCK_ROLE, permissions: EMPTY_PERMISSIONS });

        await updateCustomRole('tenant-1', 'role-1', { name: 'DevOps', permissions: FULL_PERMISSIONS }, ACTOR);

        expect(syncRoleRules).toHaveBeenCalledOnce();
        expect((syncRoleRules as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({
            roleId: 'role-1',
            permissions: FULL_PERMISSIONS,
        });
    });

    it('create and update both run inside the audited write path', async () => {
        mockPrisma.customRole.count.mockResolvedValue(0);
        mockPrisma.customRole.create.mockResolvedValue({ ...MOCK_ROLE, level: 1 });

        await createCustomRole('tenant-1', { name: 'DevOps', permissions: MINIMAL_PERMISSIONS }, ACTOR);

        expect(runRbacMutation).toHaveBeenCalledOnce();
        expect((runRbacMutation as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
            entityType: 'role',
            operation: 'create',
            actor: { userId: 'user-1', tenantId: 'tenant-1' },
        });
    });
});

/**
 * The privilege-escalation gap this closes: getAutoLevel() used to compare a
 * role's tick count against the static ROLE_PERMISSIONS.Owner set (21
 * actions) no matter how many grantable cells the registry actually has. Once
 * modules are addable from the UI, an ordinary role's tick count clears 21
 * across unrelated modules and silently reaches level 4 — the level that may
 * assign roles to other people (MIN_ASSIGN_LEVEL in permissions.ts) — with
 * nobody having granted that. createCustomRole/updateCustomRole must derive
 * the ceiling from loadAdminRegistry() instead.
 */
describe('role levelling uses the registry ceiling, not the static Owner set', () => {
    it('levels a role against the registry cell count, not the static Owner set', async () => {
        // 21 ticks clears the static ceiling. With 40 grantable cells in the
        // registry it must not reach level 4 — the level that may assign roles.
        mockPrisma.customRole.count.mockResolvedValue(0);
        mockGrantableCells(mockPrisma, 40);
        mockPrisma.customRole.create.mockResolvedValue({
            ...MOCK_ROLE,
            name: 'Wide',
            permissions: FULL_PERMISSIONS,
            level: 3,
        });

        await createCustomRole('tenant-1', { name: 'Wide', permissions: FULL_PERMISSIONS }, ACTOR);

        expect(mockPrisma.customRole.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ level: 3 }) })
        );
    });

    it('applies the same registry ceiling on update', async () => {
        mockPrisma.customRole.findFirst.mockResolvedValue(MOCK_ROLE);
        mockGrantableCells(mockPrisma, 40);
        mockPrisma.customRole.update.mockResolvedValue({
            ...MOCK_ROLE,
            name: 'Wide',
            permissions: FULL_PERMISSIONS,
            level: 3,
        });

        await updateCustomRole('tenant-1', 'role-1', { name: 'Wide', permissions: FULL_PERMISSIONS }, ACTOR);

        expect(mockPrisma.customRole.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ level: 3 }) })
        );
    });
});

/**
 * The gap this wiring closed: the roles screen wrote `custom_roles.permissions`
 * while CASL read `rbac_role_rules`, and nothing connected them. With
 * DYNAMIC_ABAC_ENABLED on that made role edits silently inert — accepted, saved,
 * and with no effect on anyone's access.
 *
 * These pin the connection itself, so it cannot be dropped without a red test.
 */
describe('role mutations reach the CASL engine', () => {
    it('create projects the permission blob onto rbac_role_rules', async () => {
        mockPrisma.customRole.count.mockResolvedValue(0);
        mockPrisma.customRole.create.mockResolvedValue({ ...MOCK_ROLE, level: 1 });

        await createCustomRole('tenant-1', { name: 'DevOps', permissions: MINIMAL_PERMISSIONS }, ACTOR);

        expect(syncRoleRules).toHaveBeenCalledOnce();
        expect((syncRoleRules as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({
            roleId: MOCK_ROLE.id,
            tenantId: 'tenant-1',
            permissions: MINIMAL_PERMISSIONS,
        });
    });

    it('update re-syncs, so revoking a permission actually revokes it', async () => {
        mockPrisma.customRole.findFirst.mockResolvedValue(MOCK_ROLE);
        mockPrisma.customRole.update.mockResolvedValue({ ...MOCK_ROLE, permissions: EMPTY_PERMISSIONS });

        await updateCustomRole('tenant-1', 'role-1', { name: 'DevOps', permissions: FULL_PERMISSIONS }, ACTOR);

        expect(syncRoleRules).toHaveBeenCalledOnce();
        expect((syncRoleRules as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({
            roleId: 'role-1',
            permissions: FULL_PERMISSIONS,
        });
    });

    it('create and update both run inside the audited write path', async () => {
        mockPrisma.customRole.count.mockResolvedValue(0);
        mockPrisma.customRole.create.mockResolvedValue({ ...MOCK_ROLE, level: 1 });

        await createCustomRole('tenant-1', { name: 'DevOps', permissions: MINIMAL_PERMISSIONS }, ACTOR);

        expect(runRbacMutation).toHaveBeenCalledOnce();
        expect((runRbacMutation as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
            entityType: 'role',
            operation: 'create',
            actor: { userId: 'user-1', tenantId: 'tenant-1' },
        });
    });
});

/**
 * The privilege-escalation gap this closes: getAutoLevel() used to compare a
 * role's tick count against the static ROLE_PERMISSIONS.Owner set (21
 * actions) no matter how many grantable cells the registry actually has. Once
 * modules are addable from the UI, an ordinary role's tick count clears 21
 * across unrelated modules and silently reaches level 4 — the level that may
 * assign roles to other people (MIN_ASSIGN_LEVEL in permissions.ts) — with
 * nobody having granted that. createCustomRole/updateCustomRole must derive
 * the ceiling from loadAdminRegistry() instead.
 */
describe('role levelling uses the registry ceiling, not the static Owner set', () => {
    it('levels a role against the registry cell count, not the static Owner set', async () => {
        // 21 ticks clears the static ceiling. With 40 grantable cells in the
        // registry it must not reach level 4 — the level that may assign roles.
        mockPrisma.customRole.count.mockResolvedValue(0);
        mockGrantableCells(mockPrisma, 40);
        mockPrisma.customRole.create.mockResolvedValue({
            ...MOCK_ROLE,
            name: 'Wide',
            permissions: FULL_PERMISSIONS,
            level: 3,
        });

        await createCustomRole('tenant-1', { name: 'Wide', permissions: FULL_PERMISSIONS }, ACTOR);

        expect(mockPrisma.customRole.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ level: 3 }) })
        );
    });

    it('applies the same registry ceiling on update', async () => {
        mockPrisma.customRole.findFirst.mockResolvedValue(MOCK_ROLE);
        mockGrantableCells(mockPrisma, 40);
        mockPrisma.customRole.update.mockResolvedValue({
            ...MOCK_ROLE,
            name: 'Wide',
            permissions: FULL_PERMISSIONS,
            level: 3,
        });

        await updateCustomRole('tenant-1', 'role-1', { name: 'Wide', permissions: FULL_PERMISSIONS }, ACTOR);

        expect(mockPrisma.customRole.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ level: 3 }) })
        );
    });
});

/**
 * The gap this wiring closed: the roles screen wrote `custom_roles.permissions`
 * while CASL read `rbac_role_rules`, and nothing connected them. With
 * DYNAMIC_ABAC_ENABLED on that made role edits silently inert — accepted, saved,
 * and with no effect on anyone's access.
 *
 * These pin the connection itself, so it cannot be dropped without a red test.
 */
describe('role mutations reach the CASL engine', () => {
    it('create projects the permission blob onto rbac_role_rules', async () => {
        mockPrisma.customRole.count.mockResolvedValue(0);
        mockPrisma.customRole.create.mockResolvedValue({ ...MOCK_ROLE, level: 1 });

        await createCustomRole('tenant-1', { name: 'DevOps', permissions: MINIMAL_PERMISSIONS }, ACTOR);

        expect(syncRoleRules).toHaveBeenCalledOnce();
        expect((syncRoleRules as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({
            roleId: MOCK_ROLE.id,
            tenantId: 'tenant-1',
            permissions: MINIMAL_PERMISSIONS,
        });
    });

    it('update re-syncs, so revoking a permission actually revokes it', async () => {
        mockPrisma.customRole.findFirst.mockResolvedValue(MOCK_ROLE);
        mockPrisma.customRole.update.mockResolvedValue({ ...MOCK_ROLE, permissions: EMPTY_PERMISSIONS });

        await updateCustomRole('tenant-1', 'role-1', { name: 'DevOps', permissions: FULL_PERMISSIONS }, ACTOR);

        expect(syncRoleRules).toHaveBeenCalledOnce();
        expect((syncRoleRules as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({
            roleId: 'role-1',
            permissions: FULL_PERMISSIONS,
        });
    });

    it('create and update both run inside the audited write path', async () => {
        mockPrisma.customRole.count.mockResolvedValue(0);
        mockPrisma.customRole.create.mockResolvedValue({ ...MOCK_ROLE, level: 1 });

        await createCustomRole('tenant-1', { name: 'DevOps', permissions: MINIMAL_PERMISSIONS }, ACTOR);

        expect(runRbacMutation).toHaveBeenCalledOnce();
        expect((runRbacMutation as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
            entityType: 'role',
            operation: 'create',
            actor: { userId: 'user-1', tenantId: 'tenant-1' },
        });
    });
});

/**
 * The privilege-escalation gap this closes: getAutoLevel() used to compare a
 * role's tick count against the static ROLE_PERMISSIONS.Owner set (21
 * actions) no matter how many grantable cells the registry actually has. Once
 * modules are addable from the UI, an ordinary role's tick count clears 21
 * across unrelated modules and silently reaches level 4 — the level that may
 * assign roles to other people (MIN_ASSIGN_LEVEL in permissions.ts) — with
 * nobody having granted that. createCustomRole/updateCustomRole must derive
 * the ceiling from loadAdminRegistry() instead.
 */
describe('role levelling uses the registry ceiling, not the static Owner set', () => {
    it('levels a role against the registry cell count, not the static Owner set', async () => {
        // 21 ticks clears the static ceiling. With 40 grantable cells in the
        // registry it must not reach level 4 — the level that may assign roles.
        mockPrisma.customRole.count.mockResolvedValue(0);
        mockGrantableCells(mockPrisma, 40);
        mockPrisma.customRole.create.mockResolvedValue({
            ...MOCK_ROLE,
            name: 'Wide',
            permissions: FULL_PERMISSIONS,
            level: 3,
        });

        await createCustomRole('tenant-1', { name: 'Wide', permissions: FULL_PERMISSIONS }, ACTOR);

        expect(mockPrisma.customRole.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ level: 3 }) })
        );
    });

    it('applies the same registry ceiling on update', async () => {
        mockPrisma.customRole.findFirst.mockResolvedValue(MOCK_ROLE);
        mockGrantableCells(mockPrisma, 40);
        mockPrisma.customRole.update.mockResolvedValue({
            ...MOCK_ROLE,
            name: 'Wide',
            permissions: FULL_PERMISSIONS,
            level: 3,
        });

        await updateCustomRole('tenant-1', 'role-1', { name: 'Wide', permissions: FULL_PERMISSIONS }, ACTOR);

        expect(mockPrisma.customRole.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ level: 3 }) })
        );
    });
});

/**
 * The gap this closes: `overrides: SubjectOverrides` was threaded through
 * createCustomRole/updateCustomRole/getCustomRoles/getCustomRole/getPresetRoles/
 * castRole, but no test in this file ever read `.overrides` off a return value
 * or observed the syncRoleSubjectOverrides call args. A mutation test proved
 * it: reverting `castRole(role, input.overrides ?? {})` to `castRole(role)` in
 * updateCustomRole left the entire (then 33-test) suite green.
 *
 * syncRoleSubjectOverrides is mocked (see the top of this file) purely so
 * these tests can assert what the service handed it — the mock's own
 * behavior proves nothing about the caller.
 */
describe('subject overrides pass through create/update', () => {
    it('createCustomRole returns the overrides it was given, and forwards them to the reconciler', async () => {
        mockPrisma.customRole.count.mockResolvedValue(0);
        mockPrisma.customRole.create.mockResolvedValue({ ...MOCK_ROLE, level: 1 });
        const overrides: SubjectOverrides = { Account: { grant: ['read'], deny: [] } };

        const result = await createCustomRole(
            'tenant-1',
            { name: 'DevOps', permissions: MINIMAL_PERMISSIONS, overrides },
            ACTOR
        );

        expect(result.overrides).toEqual(overrides);
        expect(syncRoleSubjectOverrides).toHaveBeenCalledOnce();
        expect((syncRoleSubjectOverrides as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({
            roleId: MOCK_ROLE.id,
            tenantId: 'tenant-1',
            overrides,
        });
    });

    it('updateCustomRole returns the overrides it was given, and forwards them to the reconciler', async () => {
        mockPrisma.customRole.findFirst.mockResolvedValue(MOCK_ROLE);
        mockPrisma.customRole.update.mockResolvedValue({ ...MOCK_ROLE, permissions: FULL_PERMISSIONS, level: 4 });
        const overrides: SubjectOverrides = { Schedule: { grant: ['delete'], deny: ['read'] } };

        const result = await updateCustomRole(
            'tenant-1',
            'role-1',
            { name: 'DevOps', permissions: FULL_PERMISSIONS, overrides },
            ACTOR
        );

        expect(result.overrides).toEqual(overrides);
        expect(syncRoleSubjectOverrides).toHaveBeenCalledOnce();
        expect((syncRoleSubjectOverrides as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({
            roleId: 'role-1',
            overrides,
        });
    });

    // The trap the brief names explicitly: syncRoleSubjectOverrides is a
    // full-SET reconciler, so `input.overrides ?? {}` is correct ONLY because
    // an omitted `overrides` genuinely means "no overrides" (clear them), not
    // "leave whatever is already there alone". A service that instead skipped
    // the reconciler call when `overrides` was absent (the "leave it alone"
    // bug the CustomRoleInput.overrides doc comment warns against) would pass
    // this test's assertion on the return value's shape but fail the
    // assertion on what was actually sent to the reconciler.
    it('updateCustomRole with overrides omitted treats it as "no overrides" (clears), not "leave existing overrides alone"', async () => {
        mockPrisma.customRole.findFirst.mockResolvedValue(MOCK_ROLE);
        mockPrisma.customRole.update.mockResolvedValue({ ...MOCK_ROLE, permissions: FULL_PERMISSIONS, level: 4 });

        const result = await updateCustomRole(
            'tenant-1',
            'role-1',
            { name: 'DevOps', permissions: FULL_PERMISSIONS },
            ACTOR
        );

        expect(result.overrides).toEqual({});
        expect(syncRoleSubjectOverrides).toHaveBeenCalledOnce();
        expect((syncRoleSubjectOverrides as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({
            roleId: 'role-1',
            overrides: {},
        });
    });
});

/**
 * FINDING 1: an update that changes ONLY a subject override (no module-level
 * permission change) must still leave a ledger row where before !== after.
 * Before the fix, updateCustomRole's runRbacMutation call passed
 * `before: before.permissions, after: input.permissions` — neither field ever
 * looks at overrides, so a real permission change (denying a subject grant)
 * was recorded as before === after: a permission changed with zero audit
 * trail of what changed. createCustomRole never had this gap (it already
 * passes the whole `input`, overrides included); only update did.
 */
describe('updateCustomRole ledger captures subject overrides (Finding 1)', () => {
    it('records a before/after ledger entry that differs when only an override changes', async () => {
        mockPrisma.customRole.findFirst.mockResolvedValue(MOCK_ROLE);
        mockPrisma.customRole.update.mockResolvedValue({ ...MOCK_ROLE });
        // No pre-existing subject-level rule for this role: the ledger's
        // `before` snapshot must show an empty overrides object.
        mockPrisma.rbacRoleRule.findMany.mockResolvedValue([]);

        const overrides: SubjectOverrides = { Settings: { grant: [], deny: ['update'] } };

        await updateCustomRole(
            'tenant-1',
            'role-1',
            // Same permissions as MOCK_ROLE — the module-level grants do not
            // change at all. Only the subject override is new.
            { name: MOCK_ROLE.name, permissions: MOCK_ROLE.permissions, overrides },
            ACTOR
        );

        expect(runRbacMutation).toHaveBeenCalledOnce();
        const mutationInput = (runRbacMutation as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
            before: unknown;
            after: unknown;
        };

        expect(mutationInput).toMatchObject({
            before: { permissions: MOCK_ROLE.permissions, overrides: {} },
            after: { permissions: MOCK_ROLE.permissions, overrides },
        });
        // The crux of the finding: before and after must be distinguishable in
        // the ledger even though `permissions` alone is unchanged.
        expect(mutationInput.before).not.toEqual(mutationInput.after);
    });
});

describe('getPresetRoles synthesized fallback overrides', () => {
    // A predefined role with no DB row is synthesized entirely from code
    // constants (ROLE_PERMISSIONS/ROLE_LEVELS). CustomRoleOutput.overrides is
    // typed as SubjectOverrides, not SubjectOverrides | undefined — an
    // `undefined` here would violate every caller's assumption that the field
    // is always a safe-to-spread object.
    it('returns overrides: {} (not undefined) for a synthesized predefined role', async () => {
        const mockPrisma = buildMockPrisma();
        mockPrisma.customRole.findMany.mockResolvedValue([]);
        vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as never);

        const roles = await getPresetRoles();

        expect(roles).toHaveLength(4);
        for (const role of roles) {
            expect(role.overrides).toEqual({});
            expect(role.overrides).not.toBeUndefined();
        }
    });
});
