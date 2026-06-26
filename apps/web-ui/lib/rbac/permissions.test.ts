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
    it('Owner has all 4 CRUD actions on all 5 modules (20 true checks)', () => {
        const modules = ['Accounts', 'Schedules', 'AIOps', 'Inventory', 'Settings'] as const;
        const actions = ['create', 'read', 'update', 'delete'] as const;
        for (const mod of modules) {
            for (const action of actions) {
                expect(ROLE_PERMISSIONS.Owner[mod]).toContain(action);
            }
        }
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

    it('Viewer has R only on all 5 modules', () => {
        const modules = ['Accounts', 'Schedules', 'AIOps', 'Inventory', 'Settings'] as const;
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
    it('returns 4 for Owner-level permissions (all 20 actions)', () => {
        const ownerPerms: PermissionSet = {
            Accounts: ['create', 'read', 'update', 'delete'],
            Schedules: ['create', 'read', 'update', 'delete'],
            AIOps: ['create', 'read', 'update', 'delete'],
            Inventory: ['create', 'read', 'update', 'delete'],
            Settings: ['create', 'read', 'update', 'delete'],
        };
        expect(getAutoLevel(ownerPerms)).toBe(4);
    });

    it('returns 1 for Viewer-level permissions (read only, 5 actions)', () => {
        const viewerPerms: PermissionSet = {
            Accounts: ['read'],
            Schedules: ['read'],
            AIOps: ['read'],
            Inventory: ['read'],
            Settings: ['read'],
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
        };
        expect(hasCustomPermission(customPerms, 'delete', 'Accounts')).toBe(false);
    });
});
