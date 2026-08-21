/**
 * Registry WRITES — the single write path for every RBAC mutation.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ WHY THIS FILE EXISTS AT ALL                                              │
 * │                                                                          │
 * │ Three things must happen together on every registry change, or the       │
 * │ feature misbehaves in ways that are painful to diagnose:                 │
 * │                                                                          │
 * │   1. the change itself                                                   │
 * │   2. a version bump  — without it the change is invisible. Compiled      │
 * │      abilities are cached under `${global}.${tenant}`, so a mutation     │
 * │      that does not bump the version is a permission edit that NEVER      │
 * │      TAKES EFFECT. It presents to the user as "the product is broken"    │
 * │      and costs a day to debug, because the row in the database is        │
 * │      visibly correct.                                                    │
 * │   3. a ledger append — "who could do what on date X" must stay           │
 * │      answerable by replay.                                              │
 * │                                                                          │
 * │ Scattering those across route handlers guarantees one gets forgotten.    │
 * │ So they are not callable separately: runRbacMutation() does all three in │
 * │ one transaction, and every mutating RBAC route goes through it.          │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ WHY getPrismaClient() AND NOT getTenantClient()                          │
 * │                                                                          │
 * │ The 10 registry / grant / route / ledger tables are deliberately NOT in  │
 * │ TENANT_SCOPED_MODELS (see the comment in lib/db/pg-config.ts). They hold │
 * │ global rows with `tenantId IS NULL`, and the tenant extension injects a  │
 * │ NON-NULL tenantId into `data` on create — which would make a global row  │
 * │ impossible to author, by anyone, including a SuperAdmin.                 │
 * │                                                                          │
 * │ The cost of that choice lands here: there is NO automatic net under this │
 * │ file. Every query below scopes explicitly, and a missed scope is a       │
 * │ cross-tenant write, not a caught mistake. `assertTenantScoped()` is the  │
 * │ guard; registry-isolation.test.ts is the second.                         │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

import type { Prisma } from '@prisma/client';

import { AuditService } from '@/lib/audit-service';
import { getPrismaClient } from '@/lib/db/pg-config';

import { assertNoLockout } from './lockout';

/** Entities the ledger tracks. Matches the documented set on RbacRuleChangeLog. */
export type RbacEntityType =
    | 'module'
    | 'action'
    | 'subject'
    | 'role'
    | 'rule'
    | 'route'
    | 'userAttribute';

export type RbacOperation = 'create' | 'update' | 'delete';

export interface RbacActor {
    userId: string;
    email: string;
    /**
     * The tenant whose permissions are changing.
     *
     * `null` means a GLOBAL row (the system registry). A global change bumps the
     * global version, which invalidates every tenant's cache key at once —
     * correct, because a global row participates in every tenant's compilation.
     */
    tenantId: string | null;
}

export interface RbacMutationInput {
    actor: RbacActor;
    entityType: RbacEntityType;
    entityId: string;
    operation: RbacOperation;
    /** Snapshot before the change. Omit for `create`. */
    before?: unknown;
    /** Snapshot after the change. Omit for `delete`. */
    after?: unknown;
    /** Operator-supplied justification, surfaced in the ledger and the audit row. */
    reason?: string;
    /**
     * Overrides the derived `rbac.<entityType>.<operation>` event name for
     * mutations that deserve their own name — `rbac.subject.remapped` being the
     * one that matters, since a remap is a permission-preserving migration and
     * not an ordinary update.
     */
    eventType?: string;
}

export type RbacTransaction = Prisma.TransactionClient;

/** Thrown when a write would touch rows outside the actor's tenant. */
export class TenantScopeError extends Error {
    constructor(detail: string) {
        super(`RBAC write refused — ${detail}`);
        this.name = 'TenantScopeError';
    }
}

/**
 * Guard for the missing safety net.
 *
 * A tenant administrator may only write rows belonging to their own tenant. Only
 * a SuperAdmin path may pass `tenantId: null` to author a global system row, and
 * callers are responsible for having established that.
 */
export function assertTenantScoped(actorTenantId: string | null, rowTenantId: string | null): void {
    if (actorTenantId === null) return; // global authoring — caller has checked SuperAdmin
    if (rowTenantId !== actorTenantId) {
        throw new TenantScopeError(
            `actor tenant ${actorTenantId} may not write a row owned by ${rowTenantId ?? 'the global registry'}`
        );
    }
}

/**
 * Bumps the RBAC version so compiled abilities stop being served.
 *
 * Nothing is cleared: cache entries are keyed by version, so a bump simply makes
 * every existing key unreachable and they fall out of the LRU. Propagation is
 * bounded by the 5s version-probe TTL.
 *
 * Exported for the rare caller that already owns a transaction, but prefer
 * runRbacMutation() — calling this alone means the ledger append is missing.
 */
export async function withRbacVersionBump(tx: RbacTransaction, tenantId: string | null): Promise<void> {
    if (tenantId === null) {
        await tx.rbacGlobalVersion.update({
            where: { id: 1 },
            data: { version: { increment: 1 } },
        });
        return;
    }

    // Deliberately `update`, not `updateMany`: a bump that silently matched zero
    // rows is exactly the failure this file exists to prevent, so it must throw.
    await tx.tenant.update({
        where: { id: tenantId },
        data: { rbacVersion: { increment: 1 } },
    });
}

async function appendLedger(tx: RbacTransaction, input: RbacMutationInput): Promise<void> {
    await tx.rbacRuleChangeLog.create({
        data: {
            tenantId: input.actor.tenantId,
            entityType: input.entityType,
            entityId: input.entityId,
            operation: input.operation,
            before: (input.before ?? null) as Prisma.InputJsonValue,
            after: (input.after ?? null) as Prisma.InputJsonValue,
            actorId: input.actor.userId,
            actorEmail: input.actor.email,
            reason: input.reason ?? null,
        },
    });
}

function eventNameFor(input: RbacMutationInput): string {
    return input.eventType ?? `rbac.${input.entityType}.${input.operation}`;
}

/**
 * Audit trail, written AFTER the transaction commits so a rolled-back change is
 * never reported as having happened. Never throws — failing to audit must not
 * turn a successful mutation into a 500 for the operator.
 */
async function auditMutation(input: RbacMutationInput): Promise<void> {
    try {
        await AuditService.logUserAction({
            action: eventNameFor(input),
            resourceType: `Rbac${input.entityType.charAt(0).toUpperCase()}${input.entityType.slice(1)}`,
            resourceId: input.entityId,
            resourceName: input.entityId,
            user: input.actor.email || input.actor.userId,
            userType: 'admin',
            status: 'success',
            details:
                `${input.operation} on RBAC ${input.entityType} ${input.entityId}` +
                (input.reason ? ` — ${input.reason}` : ''),
            tenantId: input.actor.tenantId ?? undefined,
            eventType: 'authorization',
            // Permission changes are high severity by definition: they alter who
            // can do what. docs/audit-logging-requirements.md sets the expectation.
            severity: 'high',
            changeSet: {
                before: (input.before ?? undefined) as Record<string, unknown> | undefined,
                after: (input.after ?? undefined) as Record<string, unknown> | undefined,
            },
        });
    } catch (error) {
        console.error('[rbac] failed to write audit row for', eventNameFor(input), error);
    }
}

/**
 * THE write path. Runs `work` inside a transaction, appends the ledger and bumps
 * the version atomically with it, then audits after commit.
 *
 * @example
 * await runRbacMutation(
 *   { actor, entityType: 'rule', entityId: ruleId, operation: 'update', before, after, reason },
 *   async (tx) => {
 *     assertTenantScoped(actor.tenantId, existing.tenantId);
 *     return tx.rbacRoleRule.update({ where: { id: ruleId }, data });
 *   }
 * );
 *
 * Callers writing conditions must validate them first with
 * `validateCondition()` from `@nucleus/rbac` — this function does not inspect
 * the payload, and an invalid condition is re-validated at compile time and
 * dropped, which is a permission that mysteriously does not work.
 */
export async function runRbacMutation<T>(
    input: RbacMutationInput,
    work: (tx: RbacTransaction) => Promise<T>
): Promise<T> {
    const prisma = getPrismaClient();

    const result = await prisma.$transaction(
        async (tx) => {
            const value = await work(tx);

            // D-13, AFTER the write so it sees the world the write created. A
            // violation throws, which rolls the transaction back — the invariant is
            // enforced, not merely reported. Global authoring (tenantId null) is
            // SuperAdmin-only and cannot lock a tenant out of its own settings.
            if (input.actor.tenantId !== null) {
                await assertNoLockout(tx, input.actor.tenantId);
            }

            await appendLedger(tx, input);
            await withRbacVersionBump(tx, input.actor.tenantId);
            return value;
        },
        // `work` fans out into a per-action/per-subject sequence of round trips
        // (applyModuleActions/applyModuleSubjects), so this is not a fast
        // single-statement transaction — Prisma's 5s interactive-transaction
        // default gets blown past on any edit touching more than a couple of
        // keys, especially against a non-local database. Prisma then silently
        // detaches the transaction, and the next query on `tx` (assertNoLockout,
        // which always runs right after `work`) fails with P2028 "Transaction
        // not found" instead of the mutation's own error.
        { timeout: 20_000 }
    );

    await auditMutation(input);
    return result;
}

/**
 * Reads the current version pair without the 5s memoisation in ability-cache.
 * For admin screens that need to show the true current value immediately after a
 * write, where the cached probe would be misleading.
 */
export async function readRbacVersionUncached(tenantId: string): Promise<string> {
    const prisma = getPrismaClient();
    const [global, tenant] = await Promise.all([
        prisma.rbacGlobalVersion.findUnique({ where: { id: 1 }, select: { version: true } }),
        prisma.tenant.findUnique({ where: { id: tenantId }, select: { rbacVersion: true } }),
    ]);
    return `${global?.version ?? 0}.${tenant?.rbacVersion ?? 0}`;
}
