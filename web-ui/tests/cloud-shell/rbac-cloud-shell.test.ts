import { describe, it, expect } from 'vitest';
import { ROLE_PERMISSIONS, hasPermission } from '@/lib/rbac/permissions';
import { SUBJECT_TO_MODULE } from '@/lib/rbac/types';

describe('CloudShell RBAC', () => {
    describe('ROLE_PERMISSIONS includes CloudShell', () => {
        it('Owner has full CRUD on CloudShell', () => {
            expect(ROLE_PERMISSIONS.Owner.CloudShell).toContain('create');
            expect(ROLE_PERMISSIONS.Owner.CloudShell).toContain('read');
            expect(ROLE_PERMISSIONS.Owner.CloudShell).toContain('update');
            expect(ROLE_PERMISSIONS.Owner.CloudShell).toContain('delete');
        });

        it('Admin has full CRUD on CloudShell', () => {
            expect(ROLE_PERMISSIONS.Admin.CloudShell).toContain('create');
            expect(ROLE_PERMISSIONS.Admin.CloudShell).toContain('read');
            expect(ROLE_PERMISSIONS.Admin.CloudShell).toContain('update');
            expect(ROLE_PERMISSIONS.Admin.CloudShell).toContain('delete');
        });

        it('Member has CRU on CloudShell but NOT delete', () => {
            expect(ROLE_PERMISSIONS.Member.CloudShell).toContain('create');
            expect(ROLE_PERMISSIONS.Member.CloudShell).toContain('read');
            expect(ROLE_PERMISSIONS.Member.CloudShell).toContain('update');
            expect(ROLE_PERMISSIONS.Member.CloudShell).not.toContain('delete');
        });

        it('Viewer has read only on CloudShell', () => {
            expect(ROLE_PERMISSIONS.Viewer.CloudShell).toContain('read');
            expect(ROLE_PERMISSIONS.Viewer.CloudShell).not.toContain('create');
            expect(ROLE_PERMISSIONS.Viewer.CloudShell).not.toContain('update');
            expect(ROLE_PERMISSIONS.Viewer.CloudShell).not.toContain('delete');
        });
    });

    describe('hasPermission for CloudShell', () => {
        it('Owner can create CloudShell sessions', () => {
            expect(hasPermission('Owner', 'create', 'CloudShell')).toBe(true);
        });

        it('Admin can delete CloudShell sessions', () => {
            expect(hasPermission('Admin', 'delete', 'CloudShell')).toBe(true);
        });

        it('Member cannot delete CloudShell sessions', () => {
            expect(hasPermission('Member', 'delete', 'CloudShell')).toBe(false);
        });

        it('Viewer cannot create CloudShell sessions', () => {
            expect(hasPermission('Viewer', 'create', 'CloudShell')).toBe(false);
        });
    });

    describe('SUBJECT_TO_MODULE mapping', () => {
        it('ShellSession maps to CloudShell module', () => {
            expect(SUBJECT_TO_MODULE['ShellSession']).toBe('CloudShell');
        });
    });
});
