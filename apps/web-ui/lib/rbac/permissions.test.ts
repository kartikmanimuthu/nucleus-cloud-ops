import { describe, it, expect } from 'vitest';
import {
    ROLE_PERMISSIONS,
    ROLE_LEVELS,
    hasPermission,
    hasCustomPermission,
    canAssignRole,
    getAutoLevel,
} from './permissions';
import type { PermissionSet } from './types';

describe('ROLE_PERMISSIONS', () => {
    it('Owner has all 4 CRUD actions on 5 core modules and read on Dashboard', () => {
        const modules = ['Accounts', 'Schedules', 'AIOps', 'Inventory', 'Settings'] as const;
        const actions = ['create', 'read', 'update', 'delete'] as const;
        for (const mod of modules) {
            for (const action of actions) {
                expect(ROLE_PERMISSIONS.Owner[mod]).toContain(action);
            }
        }
        expect(ROLE_PERMISSIONS.Owner.Dashboard).toContain('read');
    });

    it('Admin has full CRUD on Accounts, Schedules, AIOps, Inventory', () => {
        const modules = ['Accounts', 'Schedules', 'AIOps', 'Inventory'] as const;
        const actions = ['create', 'read', 'update', 'delete'] as const;
        for (const mod of modules) {
            for (const action of actions) {
                expect(ROLE_PERMISSIONS.Admin[mod]).toContain(action);
            }
        }
    });

    it('Admin has CRU on Settings but NOT delete', () => {
        expect(ROLE_PERMISSIONS.Admin.Settings).toContain('create');
        expect(ROLE_PERMISSIONS.Admin.Settings).toContain('read');
        expect(ROLE_PERMISSIONS.Admin.Settings).toContain('update');
        expect(ROLE_PERMISSIONS.Admin.Settings).not.toContain('delete');
    });

    it('Member has CRU on Accounts, Schedules, AIOps, Inventory', () => {
        const modules = ['Accounts', 'Schedules', 'AIOps', 'Inventory'] as const;
        for (const mod of modules) {
            expect(ROLE_PERMISSIONS.Member[mod]).toContain('create');
            expect(ROLE_PERMISSIONS.Member[mod]).toContain('read');
            expect(ROLE_PERMISSIONS.Member[mod]).toContain('update');
            expect(ROLE_PERMISSIONS.Member[mod]).not.toContain('delete');
        }
    });

    it('Member has R only on Settings', () => {
        expect(ROLE_PERMISSIONS.Member.Settings).toContain('read');
        expect(ROLE_PERMISSIONS.Member.Settings).not.toContain('create');
        expect(ROLE_PERMISSIONS.Member.Settings).not.toContain('update');
        expect(ROLE_PERMISSIONS.Member.Settings).not.toContain('delete');
    });

    it('Viewer has R only on all 6 modules', () => {
        const modules = ['Accounts', 'Schedules', 'AIOps', 'Inventory', 'Settings', 'Dashboard'] as const;
        for (const mod of modules) {
            expect(ROLE_PERMISSIONS.Viewer[mod]).toContain('read');
            expect(ROLE_PERMISSIONS.Viewer[mod]).not.toContain('create');
            expect(ROLE_PERMISSIONS.Viewer[mod]).not.toContain('update');
            expect(ROLE_PERMISSIONS.Viewer[mod]).not.toContain('delete');
        }
    });
});

describe('hasPermission', () => {
    it('Owner can delete Settings', () => {
        expect(hasPermission('Owner', 'delete', 'Settings')).toBe(true);
    });

    it('Admin cannot delete Settings', () => {
        expect(hasPermission('Admin', 'delete', 'Settings')).toBe(false);
    });

    it('Viewer cannot create Accounts', () => {
        expect(hasPermission('Viewer', 'create', 'Accounts')).toBe(false);
    });

    it('Member can read Settings', () => {
        expect(hasPermission('Member', 'read', 'Settings')).toBe(true);
    });
});

describe('ROLE_LEVELS', () => {
    it('Owner level is 4', () => {
        expect(ROLE_LEVELS.Owner).toBe(4);
    });

    it('Admin level is 3', () => {
        expect(ROLE_LEVELS.Admin).toBe(3);
    });

    it('Member level is 2', () => {
        expect(ROLE_LEVELS.Member).toBe(2);
    });

    it('Viewer level is 1', () => {
        expect(ROLE_LEVELS.Viewer).toBe(1);
    });
});

describe('canAssignRole', () => {
    it('Owner can assign Admin', () => {
        expect(canAssignRole('Owner', 'Admin')).toBe(true);
    });

    it('Admin cannot assign Owner', () => {
        expect(canAssignRole('Admin', 'Owner')).toBe(false);
    });

    it('Admin can assign Admin (same level)', () => {
        expect(canAssignRole('Admin', 'Admin')).toBe(true);
    });

    it('Member cannot assign Viewer (below min assign level)', () => {
        expect(canAssignRole('Member', 'Viewer')).toBe(false);
    });

    it('Viewer cannot assign Viewer', () => {
        expect(canAssignRole('Viewer', 'Viewer')).toBe(false);
    });

    it('Owner can assign Viewer', () => {
        expect(canAssignRole('Owner', 'Viewer')).toBe(true);
    });

    it('Admin can assign Member', () => {
        expect(canAssignRole('Admin', 'Member')).toBe(true);
    });
});

describe('getAutoLevel', () => {
    it('returns 4 for Owner-level permissions (full CRUD + Dashboard read)', () => {
        const ownerPerms: PermissionSet = {
            Accounts: ['create', 'read', 'update', 'delete'],
            Schedules: ['create', 'read', 'update', 'delete'],
            AIOps: ['create', 'read', 'update', 'delete'],
            Inventory: ['create', 'read', 'update', 'delete'],
            Settings: ['create', 'read', 'update', 'delete'],
            Dashboard: ['read'],
            IAM: ['create', 'read', 'update', 'delete'],
        };
        expect(getAutoLevel(ownerPerms)).toBe(4);
    });

    it('returns 1 for Viewer-level permissions (read only, 6 actions)', () => {
        const viewerPerms: PermissionSet = {
            Accounts: ['read'],
            Schedules: ['read'],
            AIOps: ['read'],
            Inventory: ['read'],
            Settings: ['read'],
            Dashboard: ['read'],
        };
        expect(getAutoLevel(viewerPerms)).toBe(1);
    });
});

describe('hasCustomPermission', () => {
    it('returns true when action is in custom permission set', () => {
        const customPerms: PermissionSet = {
            Accounts: ['read', 'create'],
            Schedules: ['read'],
            AIOps: [],
            Inventory: [],
            Settings: [],
            Dashboard: ['read'],
        };
        expect(hasCustomPermission(customPerms, 'create', 'Accounts')).toBe(true);
    });

    it('returns false when action is not in custom permission set', () => {
        const customPerms: PermissionSet = {
            Accounts: ['read'],
            Schedules: ['read'],
            AIOps: [],
            Inventory: [],
            Settings: [],
            Dashboard: ['read'],
        };
        expect(hasCustomPermission(customPerms, 'delete', 'Accounts')).toBe(false);
    });
});

describe('getAutoLevel with a dynamic registry', () => {
    it('accepts permission sets with keys outside the legacy module union', () => {
        const perms: PermissionSet = {
            CostControl: ['read', 'update'],
            Accounts: ['read'],
        };
        expect(getAutoLevel(perms)).toBe(1);
    });

    it('scales the Owner threshold with the registry, not the static matrix', () => {
        // 21 ticks would clear the static Owner threshold (21 actions in
        // ROLE_PERMISSIONS.Owner) and hand out level 4 — the level that may
        // assign roles. With the real cell count passed in, it must not.
        const perms: PermissionSet = {
            Accounts: ['create', 'read', 'update', 'delete'],
            Schedules: ['create', 'read', 'update', 'delete'],
            AIOps: ['create', 'read', 'update', 'delete'],
            Inventory: ['create', 'read', 'update', 'delete'],
            CostControl: ['create', 'read', 'update', 'delete'],
            Dashboard: ['read'],
        };
        expect(getAutoLevel(perms, 21)).toBe(4);
        expect(getAutoLevel(perms, 40)).toBe(3);
    });

    it('does not fail open to level 4 when ownerActionCount is 0 (broken/inconsistent registry read)', () => {
        // A `grantableCellCount: 0` from `loadAdminRegistry` must never be treated
        // as "everyone qualifies for Owner." A single-action role should fall
        // through to the static-ceiling logic and land at the lowest level, not 4.
        const oneActionPermissionSet: PermissionSet = {
            Accounts: ['read'],
        };
        expect(getAutoLevel(oneActionPermissionSet, 0)).toBe(1);
    });
});
