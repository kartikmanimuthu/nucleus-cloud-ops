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

// Global singleton — Next.js hot reloads can create multiple instances in dev
// Use global object to prevent "Too many connections" in development
declare global {
    // eslint-disable-next-line no-var
    var __prismaClient: PrismaClient | undefined;
}

let prismaClient: PrismaClient | undefined;

export function getPrismaClient(): PrismaClient {
    // In production, create once per process (ECS container, max 10 connections)
    if (process.env.NODE_ENV === 'production') {
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
 * VerificationToken, InventoryVectorKey, InventorySyncStatus, ScheduledTaskLock)
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
    'ChatMessage',
    'CustomRole',
    'UserTenantRole',
    'TenantConfig',
    'Invitation',
    'ProviderModel',
    'ShellSession',
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
                    if (!TENANT_SCOPED_MODELS.has(model ?? '')) {
                        return query(args);
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

                    // Updates: inject tenantId into WHERE
                    if (['update', 'updateMany'].includes(operation)) {
                        args = { ...args, where: { ...args.where, tenantId } };
                    }

                    // Deletes: inject tenantId into WHERE
                    if (['delete', 'deleteMany'].includes(operation)) {
                        args = { ...args, where: { ...args.where, tenantId } };
                    }

                    return query(args);
                },
            },
        },
    });
}
