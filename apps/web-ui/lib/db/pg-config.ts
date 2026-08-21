/**
 * PostgreSQL client singleton via Prisma ORM.
 *
 * Connection pool sizes (per architecture decision):
 *   - ECS (web-ui): connection_limit=10 — long-lived process
 *   - Lambda functions: set connection_limit=3 in DATABASE_URL query param
 *     (Lambda functions configure this in their own environment variables)
 *
 * Usage: import { getPrismaClient, getTenantClient } from '@/lib/db/pg-config'
 */

import { PrismaClient } from '@prisma/client';
import { env } from '@/env';

// Global singleton — Next.js hot reloads can create multiple instances in dev
// Use global object to prevent "Too many connections" in development
declare global {
    // eslint-disable-next-line no-var
    var __prismaClient: PrismaClient | undefined;
}

let prismaClient: PrismaClient | undefined;

export function getPrismaClient(): PrismaClient {
    // In production, create once per process (ECS container, max 10 connections)
    if (env.NODE_ENV === 'production') {
        if (!prismaClient) {
            prismaClient = new PrismaClient({
                log: ['error'],
            });
        }
        return prismaClient;
    }

    // In development, reuse global to survive Next.js hot reloads
    if (!globalThis.__prismaClient) {
        globalThis.__prismaClient = new PrismaClient({
            log: ['query', 'error', 'warn'],
        });
    }
    return globalThis.__prismaClient;
}

/**
 * Disconnect the Prisma client — call in Lambda handler cleanup or test teardown.
 */
export async function disconnectPrisma(): Promise<void> {
    const client = prismaClient ?? globalThis.__prismaClient;
    if (client) {
        await client.$disconnect();
    }
}

/**
 * Models that carry a tenantId column and must be scoped per-tenant.
 * Exported so tests can verify coverage.
 *
 * NOTE: Models without tenantId (e.g. AuthUser, AuthAccount, AuthSession,
 * VerificationToken, InventorySyncStatus, ScheduledTaskLock)
 * are intentionally excluded — they are either platform-level or keyed differently.
 */
export const TENANT_SCOPED_MODELS = new Set([
    'Account',
    'Schedule',
    'ScheduleExecution',
    'TargetedResource',
    'AuditLog',
    'KnowledgeBase',
    'DataSource',
    'InventoryResource',
    'AgentOpsRun',
    'AgentOpsEvent',
    'ScheduledTask',
    'AgentMemory',
    'Certificate',
    'CertificateVersion',
    'CertificateDeployment',
    'CertificateExecution',
    'ChatMessage',
    'AgentSubagentRun',
    'CustomRole',
    'UserTenantRole',
    'TenantConfig',
    'Invitation',
    'ProviderModel',
    'RightSizingRecommendation',
    'RightSizingRun',
    'Skill',
    // Fargate Spot Guard. NOTE: SpotGuardAction is deliberately absent — it is the
    // global, cross-tenant exactly-once mutation claim. The same AWS account can be
    // registered by more than one tenant (accounts is unique on [tenantId, accountId]),
    // so an inbound ECS event may resolve to N tenants; the claim must span them all
    // to stop N concurrent ecs:UpdateService calls on one service. See the model's
    // comment in schema.prisma.
    'SpotGuardService',
    'SpotGuardEvent',
    'SpotGuardTaskSession',
    'SpotGuardAlertDedup',
    // Scaling Audit (SA-001). ScalingEvent is written exclusively via raw pg from the
    // worker (manually tenant-scoped there, per the $executeRaw gotcha below) — this
    // registration governs the web-ui repository's READS via getTenantClient().
    'ScalingEvent',
    'ScalingAuditCoverage',
    'ScalingAuditRun',
    'ScalingAuditWatermark',
    'ScalingPolicySnapshot',
    'ScalingAuditDailySeal',
    // Capacity Planning (SA-004). Same raw-pg-writer/Prisma-reader split as
    // ScalingEvent above — the worker writes via raw pg, this registration
    // governs the web-ui repository's reads via getTenantClient().
    'CapacityUtilizationSample',
    'CapacityPlanningRun',
    // ── Dynamic ABAC ─────────────────────────────────────────────────────────
    //
    // Exactly ONE rbac table belongs in this Set. This is not an oversight, and
    // the omissions are load-bearing — read before adding to it.
    //
    // This extension injects a NON-NULL tenantId into `where` on every read and
    // into `data` on create/createMany/upsert (see getTenantClient below). For a
    // table whose tenantId is nullable BY DESIGN, that is actively harmful in
    // both directions:
    //   · reads  — `WHERE tenant_id = $1` excludes NULLs, so every global system
    //              row disappears. The compiler then finds no subjects or actions
    //              and every authorization check fails closed: the app denies
    //              everything, for everyone.
    //   · writes — a non-null tenantId is forced in, so a global row can never be
    //              authored at all, not even by a SuperAdmin.
    //
    // So the 10 nullable-tenantId registry / grant / route / ledger tables
    // (RbacModule, RbacAction, RbacSubject, RbacSubjectModule, RbacModuleAction,
    // RbacRoleRule, RbacSubjectAttribute, RbacPrincipalAttribute,
    // RbacRoutePermission, RbacRuleChangeLog) are deliberately ABSENT. They are
    // scoped explicitly instead, and lib/rbac/registry.ts + registry-service.ts
    // are their only permitted accessors — enforced by
    // lib/rbac/registry-isolation.test.ts, which fails CI on a second bypass.
    //
    // Consequence worth stating plainly: with those tables unregistered there is
    // no automatic net under them. A missing scope in either of those two files
    // is a cross-tenant leak, not a caught mistake. That is why the isolation
    // test exists and why it must stay strict.
    //
    // RbacGlobalVersion is absent for a different reason: it has no tenantId
    // column at all (single row, id=1). Registering it would make every version
    // probe throw `Unknown argument tenantId`, killing the entire ability
    // cache/freshness mechanism.
    //
    // Names here are PascalCase to match Prisma's model names — a camelCase entry
    // would silently never match, which for the one table below would leave a
    // multi-tenant table completely unscoped.
    //
    // RbacUserAttribute has a NOT NULL tenantId, so it is fully scoped here with
    // no exception and no manual handling.
    'RbacUserAttribute',
]);

/**
 * Returns a Prisma client extended with a query middleware that automatically
 * injects `tenantId` into every read, write, and delete operation on
 * tenant-scoped models (see TENANT_SCOPED_MODELS).
 *
 * Per D-01: wraps the singleton from getPrismaClient() via $extends.
 * Per D-02: raw SQL ($executeRaw, $queryRawUnsafe) is NOT intercepted — callers
 *           must manually scope those queries.
 * Per D-03: created per-request, not cached.
 *
 * @throws if tenantId is falsy — prevents accidental cross-tenant queries.
 */
export function getTenantClient(tenantId: string) {
    if (!tenantId) throw new Error('getTenantClient: tenantId is required');
    const base = getPrismaClient();
    return base.$extends({
        query: {
            $allModels: {
                async $allOperations({ model, operation, args, query }: {
                    model: string | undefined;
                    operation: string;
                    args: Record<string, any>;
                    query: (args: Record<string, any>) => Promise<unknown>;
                }) {
                    return query(applyTenantScope(model, operation, args, tenantId));
                },
            },
        },
    });
}

/**
 * The tenant extension's argument rewrite, extracted as a pure function.
 *
 * Extracted so it can be exercised directly in tests: this is the code that
 * decides whether `WHERE tenant_id = $1` reaches the database, and the thing most
 * worth asserting about it — that a caller-supplied `where` (an RBAC row filter,
 * say) cannot displace the tenant predicate — needs the real rewrite, not a
 * hand-copied imitation of it that could drift.
 *
 * The tenantId spread comes LAST everywhere it appears, so no caller-supplied
 * `where.tenantId` can override it.
 */
export function applyTenantScope(
    model: string | undefined,
    operation: string,
    args: Record<string, any>,
    tenantId: string
): Record<string, any> {
    if (!TENANT_SCOPED_MODELS.has(model ?? '')) {
        return args;
    }

    // Reads: inject tenantId into WHERE
    if (['findMany', 'findFirst', 'findUnique', 'findUniqueOrThrow', 'count', 'aggregate', 'groupBy'].includes(operation)) {
        args = { ...args, where: { ...args.where, tenantId } };
    }

    // Creates: inject tenantId into data
    if (operation === 'create') {
        args = { ...args, data: { ...args.data, tenantId } };
    }
    if (operation === 'createMany') {
        if (Array.isArray(args.data)) {
            args = { ...args, data: args.data.map((d: Record<string, unknown>) => ({ ...d, tenantId })) };
        } else {
            args = { ...args, data: { ...args.data, tenantId } };
        }
    }

    // Upserts: scope WHERE + inject into create
    if (operation === 'upsert') {
        args = {
            ...args,
            where: { ...args.where, tenantId },
            create: { ...args.create, tenantId },
        };
    }

    // Updates: inject tenantId into WHERE. Also strip tenantId from
    // `data` so a request body can NEVER re-home a row to another
    // tenant (a client-supplied data.tenantId would otherwise pass
    // straight to SET, orphaning the row and breaking tenant scoping).
    if (['update', 'updateMany'].includes(operation)) {
        args = { ...args, where: { ...args.where, tenantId } };
        if (args.data && typeof args.data === 'object' && 'tenantId' in (args.data as Record<string, unknown>)) {
            const { tenantId: _dropTenantId, ...restData } = args.data as Record<string, unknown>;
            args = { ...args, data: restData };
        }
    }

    // Deletes: inject tenantId into WHERE
    if (['delete', 'deleteMany'].includes(operation)) {
        args = { ...args, where: { ...args.where, tenantId } };
    }

    return args;
}

/**
 * A Prisma `where` fragment produced by the RBAC row filter (Gate 3).
 * See lib/rbac/prisma-filter.ts for how one is built.
 */
export type PrismaRowFilter = Record<string, unknown>;

/**
 * Intersects a row filter into an existing `where`, under `AND`.
 *
 * ── WHY IT MUST BE `AND`, AND WHY IT LIVES HERE ─────────────────────────────
 * The obvious spelling, `{ ...where, ...filter }`, is a security bug. Both the
 * repositories' filters and the CASL output use `OR` at the top level (search
 * terms on one side, multiple matching rules on the other), so a merge would
 * have the row filter OVERWRITE the repository's `OR` — or, worse, the reverse:
 * a repository search clause silently deleting the authorization filter and
 * returning every row in the tenant.
 *
 * Nesting under `AND` is closed under composition: the result can only ever be
 * narrower than `base`, whatever either side contains. The tenant predicate is
 * then spread in at the TOP level by applyTenantScope() above, so it is a
 * sibling of `AND` and a peer conjunct — the row filter cannot displace it even
 * if it carries a `tenantId` key of its own.
 *
 * It lives next to getTenantClient() because that invariant is the same one this
 * file already owns.
 */
export function andWhere(
    base: Record<string, unknown>,
    filter?: PrismaRowFilter | null
): Record<string, unknown> {
    if (!filter || Object.keys(filter).length === 0) return base;

    const existing = base.AND;
    const conjuncts = Array.isArray(existing)
        ? [...existing, filter]
        : existing !== undefined
          ? [existing, filter]
          : [filter];

    return { ...base, AND: conjuncts };
}
