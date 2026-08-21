import { Prisma } from '@prisma/client';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const findManyRule = vi.fn();
const findManySubject = vi.fn();
const findManyAction = vi.fn();

vi.mock('@/lib/db/pg-config', () => ({
    getPrismaClient: () => ({
        rbacRoleRule: { findMany: findManyRule },
        rbacSubject: { findMany: findManySubject },
        rbacAction: { findMany: findManyAction },
    }),
}));

import { loadRoleSubjectOverrides } from './registry-admin';

beforeEach(() => {
    findManySubject.mockResolvedValue([
        { id: 's-provider', key: 'Provider' },
        { id: 's-skill', key: 'Skill' },
    ]);
    findManyAction.mockResolvedValue([
        { id: 'a-read', key: 'read' },
        { id: 'a-update', key: 'update' },
    ]);
});

describe('loadRoleSubjectOverrides', () => {
    it('returns an empty map for no roles', async () => {
        expect(await loadRoleSubjectOverrides([], 't1')).toEqual(new Map());
    });

    it('splits rules into grant and deny by subject key', async () => {
        findManyRule.mockResolvedValue([
            { roleId: 'r1', subjectId: 's-provider', actionId: 'a-read', inverted: false },
            { roleId: 'r1', subjectId: 's-skill', actionId: 'a-update', inverted: true },
        ]);

        const result = await loadRoleSubjectOverrides(['r1'], 't1');

        expect(result.get('r1')).toEqual({
            Provider: { grant: ['read'], deny: [] },
            Skill: { grant: [], deny: ['update'] },
        });
    });

    it('skips a rule pointing at a registry row it cannot see', async () => {
        findManyRule.mockResolvedValue([
            { roleId: 'r1', subjectId: 's-ghost', actionId: 'a-read', inverted: false },
        ]);

        expect(await loadRoleSubjectOverrides(['r1'], 't1')).toEqual(new Map());
    });

    it('scopes the query to the caller tenant (or global) rows, not every tenant', async () => {
        findManyRule.mockResolvedValue([]);

        await loadRoleSubjectOverrides(['r1', 'r2'], 't1');

        // This is the exact defect under fix: an omitted `...scope` returns every
        // tenant's rows for a shared preset roleId. Asserting the literal `where`
        // object is the only way a dropped scope, a dropped roleId filter, or an
        // `{ in: [tenantId, null] }` swap (rejected by Prisma at runtime for a
        // nullable String column) would ever turn this test red.
        expect(findManyRule).toHaveBeenCalledWith({
            where: {
                OR: [{ tenantId: 't1' }, { tenantId: null }],
                roleId: { in: ['r1', 'r2'] },
                subjectId: { not: null },
                conditions: { equals: Prisma.DbNull },
                fields: { equals: [] },
            },
        });
    });

    it('never leaks another tenant\'s override on a shared preset role (cross-tenant isolation)', async () => {
        // A preset role id is the SAME row for every tenant, but rbac_role_rules
        // carries its own tenantId per rule. Tenant A's deny on `Provider` must
        // never surface when tenant B reads the same preset role.
        const allRowsAcrossAllTenants = [
            { roleId: 'preset-admin', tenantId: 'tenant-a', subjectId: 's-provider', actionId: 'a-read', inverted: true },
            { roleId: 'preset-admin', tenantId: 'tenant-b', subjectId: 's-skill', actionId: 'a-update', inverted: false },
            { roleId: 'preset-admin', tenantId: null, subjectId: 's-provider', actionId: 'a-update', inverted: false },
        ];

        // A fake that actually FILTERS on the `where` it receives, mirroring the
        // pattern in role-rule-sync.test.ts's fakeTx — a fixed mockResolvedValue
        // can never distinguish a scoped query from an unscoped one.
        findManyRule.mockImplementation(
            async (args: { where: { OR?: Array<{ tenantId: string | null }>; roleId: { in: string[] } } }) => {
                const allowedTenantIds = new Set((args.where.OR ?? []).map((clause) => clause.tenantId));
                return allRowsAcrossAllTenants.filter(
                    (row) => args.where.roleId.in.includes(row.roleId) && allowedTenantIds.has(row.tenantId)
                );
            }
        );

        const result = await loadRoleSubjectOverrides(['preset-admin'], 'tenant-b');

        // Tenant B sees its own grant and the seeded global grant — never tenant
        // A's deny on Provider/read.
        expect(result.get('preset-admin')).toEqual({
            Skill: { grant: ['update'], deny: [] },
            Provider: { grant: ['update'], deny: [] },
        });
    });
});
