/**
 * The write path must be all-or-nothing.
 *
 * The failure this guards against is the quiet one: a mutation that commits the
 * row but not the version bump. The database then looks correct while the
 * running app keeps serving the old compiled ability until something else
 * happens to move the version — a permission change that never takes effect.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
    const tx = {
        rbacRuleChangeLog: { create: vi.fn() },
        rbacGlobalVersion: { update: vi.fn() },
        tenant: { update: vi.fn() },
        // The lockout invariant (D-13) runs inside every tenant-scoped
        // mutation, so the stub must satisfy it. Defaults describe a healthy
        // tenant — one unconditional admin grant, held by one member — which is
        // the precondition these tests are about anyway. lockout.test.ts owns
        // the violation cases.
        // findMany, not findFirst: assertNoLockout resolves tenant-vs-global
        // precedence in JS, because Postgres sorts DESC with NULLS FIRST.
        rbacModule: {
            update: vi.fn(),
            findMany: vi.fn().mockResolvedValue([{ id: 'm-settings', tenantId: null }]),
        },
        rbacAction: { findMany: vi.fn().mockResolvedValue([{ id: 'a-update', tenantId: null }]) },
        // Empty, not a stubbed 'Settings' subject row: assertNoLockout treats a
        // missing subject as "no subject-level override exists" and skips
        // straight to the module-level answer above — the same healthy-tenant
        // default these tests already model, just at the subject layer too.
        // A real Prisma.TransactionClient always has this table; only an
        // incomplete stub was ever missing it (lib/rbac/lockout.ts:127).
        rbacSubject: { findMany: vi.fn().mockResolvedValue([]) },
        rbacRoleRule: { findMany: vi.fn().mockResolvedValue([{ roleId: 'role-owner' }]) },
        // assertNoLockout resolves surviving role ids to NAMES, because
        // user_tenant_roles records membership by name and its roleId is null.
        customRole: { findMany: vi.fn().mockResolvedValue([{ name: 'Owner' }]) },
        userTenantRole: { count: vi.fn().mockResolvedValue(1) },
    };
    return {
        tx,
        prisma: {
            $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
            rbacGlobalVersion: { findUnique: vi.fn() },
            tenant: { findUnique: vi.fn() },
        },
        logUserAction: vi.fn(),
    };
});

vi.mock('@/lib/db/pg-config', () => ({ getPrismaClient: () => h.prisma }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: h.logUserAction } }));

import {
    assertTenantScoped,
    readRbacVersionUncached,
    runRbacMutation,
    TenantScopeError,
    withRbacVersionBump,
    type RbacMutationInput,
} from './registry-service';

const actor = { userId: 'u1', email: 'admin@example.com', tenantId: 't1' };

function input(patch: Partial<RbacMutationInput> = {}): RbacMutationInput {
    return {
        actor,
        entityType: 'rule',
        entityId: 'rule-1',
        operation: 'update',
        before: { actions: ['read'] },
        after: { actions: ['read', 'update'] },
        ...patch,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    h.logUserAction.mockResolvedValue(undefined);
    h.prisma.$transaction.mockImplementation(async (fn: (t: typeof h.tx) => Promise<unknown>) => fn(h.tx));
});

describe('runRbacMutation — atomicity', () => {
    it('performs the work, the ledger append and the version bump in ONE transaction', async () => {
        await runRbacMutation(input(), async (tx) => {
            await tx.rbacModule.update({ where: { id: 'm1' }, data: {} });
            return 'ok';
        });

        expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(h.tx.rbacModule.update).toHaveBeenCalledTimes(1);
        expect(h.tx.rbacRuleChangeLog.create).toHaveBeenCalledTimes(1);
        expect(h.tx.tenant.update).toHaveBeenCalledTimes(1);
    });

    it('returns the value the work produced', async () => {
        const result = await runRbacMutation(input(), async () => ({ id: 'rule-1' }));
        expect(result).toEqual({ id: 'rule-1' });
    });

    it('writes neither ledger nor bump when the work throws', async () => {
        await expect(
            runRbacMutation(input(), async () => {
                throw new Error('constraint violation');
            })
        ).rejects.toThrow('constraint violation');

        expect(h.tx.rbacRuleChangeLog.create).not.toHaveBeenCalled();
        expect(h.tx.tenant.update).not.toHaveBeenCalled();
    });

    it('does not audit a mutation that rolled back', async () => {
        h.prisma.$transaction.mockRejectedValueOnce(new Error('serialization failure'));

        await expect(runRbacMutation(input(), async () => 'unused')).rejects.toThrow('serialization failure');
        expect(h.logUserAction).not.toHaveBeenCalled();
    });
});

describe('withRbacVersionBump — which counter moves', () => {
    it('bumps the tenant version for a tenant-owned row', async () => {
        await withRbacVersionBump(h.tx as never, 't1');

        expect(h.tx.tenant.update).toHaveBeenCalledWith({
            where: { id: 't1' },
            data: { rbacVersion: { increment: 1 } },
        });
        expect(h.tx.rbacGlobalVersion.update).not.toHaveBeenCalled();
    });

    it('bumps the GLOBAL version for a global row, invalidating every tenant at once', async () => {
        await withRbacVersionBump(h.tx as never, null);

        expect(h.tx.rbacGlobalVersion.update).toHaveBeenCalledWith({
            where: { id: 1 },
            data: { version: { increment: 1 } },
        });
        expect(h.tx.tenant.update).not.toHaveBeenCalled();
    });

    it('propagates a bump that matched no rows instead of swallowing it', async () => {
        // `update` throws on a missing row where `updateMany` would silently
        // match zero. A silent no-op here is the exact bug this file prevents.
        h.tx.tenant.update.mockRejectedValueOnce(new Error('Record to update not found'));

        await expect(withRbacVersionBump(h.tx as never, 'ghost-tenant')).rejects.toThrow(
            'Record to update not found'
        );
    });
});

describe('runRbacMutation — ledger and audit content', () => {
    it('records actor, operation and both snapshots in the ledger', async () => {
        await runRbacMutation(input({ reason: 'granting Ops execute' }), async () => null);

        expect(h.tx.rbacRuleChangeLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                tenantId: 't1',
                entityType: 'rule',
                entityId: 'rule-1',
                operation: 'update',
                before: { actions: ['read'] },
                after: { actions: ['read', 'update'] },
                actorId: 'u1',
                actorEmail: 'admin@example.com',
                reason: 'granting Ops execute',
            }),
        });
    });

    it('audits at high severity with a before/after change set', async () => {
        await runRbacMutation(input(), async () => null);

        expect(h.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'rbac.rule.update',
                severity: 'high',
                eventType: 'authorization',
                userType: 'admin',
                tenantId: 't1',
                changeSet: { before: { actions: ['read'] }, after: { actions: ['read', 'update'] } },
            })
        );
    });

    it('derives the event name from entity and operation', async () => {
        await runRbacMutation(input({ entityType: 'module', operation: 'create', before: undefined }), async () => null);
        expect(h.logUserAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'rbac.module.create' }));
    });

    it('honours an explicit event name for mutations that deserve one', async () => {
        // A remap is a permission-preserving migration, not an ordinary update,
        // and needs to be findable as such in the audit trail.
        await runRbacMutation(input({ entityType: 'subject', eventType: 'rbac.subject.remapped' }), async () => null);
        expect(h.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'rbac.subject.remapped' })
        );
    });

    it('does not fail the mutation when the audit write fails', async () => {
        h.logUserAction.mockRejectedValueOnce(new Error('audit table unavailable'));

        // The permission change already committed; turning that into a 500 would
        // be worse than a missing audit row, which is logged instead.
        await expect(runRbacMutation(input(), async () => 'committed')).resolves.toBe('committed');
    });
});

describe('assertTenantScoped', () => {
    it('allows a tenant to write its own rows', () => {
        expect(() => assertTenantScoped('t1', 't1')).not.toThrow();
    });

    it('refuses a write to another tenant', () => {
        expect(() => assertTenantScoped('t1', 't2')).toThrow(TenantScopeError);
    });

    it('refuses a tenant actor writing a global row', () => {
        expect(() => assertTenantScoped('t1', null)).toThrow(/global registry/);
    });

    it('allows global authoring when the caller has established SuperAdmin', () => {
        expect(() => assertTenantScoped(null, null)).not.toThrow();
        expect(() => assertTenantScoped(null, 't1')).not.toThrow();
    });
});

describe('readRbacVersionUncached', () => {
    it('reads both halves of the version pair', async () => {
        h.prisma.rbacGlobalVersion.findUnique.mockResolvedValue({ version: 7 });
        h.prisma.tenant.findUnique.mockResolvedValue({ rbacVersion: 3 });

        await expect(readRbacVersionUncached('t1')).resolves.toBe('7.3');
    });

    it('falls back to zeros rather than throwing on missing rows', async () => {
        h.prisma.rbacGlobalVersion.findUnique.mockResolvedValue(null);
        h.prisma.tenant.findUnique.mockResolvedValue(null);

        await expect(readRbacVersionUncached('nope')).resolves.toBe('0.0');
    });
});
