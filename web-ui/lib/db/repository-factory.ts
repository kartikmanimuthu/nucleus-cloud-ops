/**
 * Repository Factory
 *
 * Reads USE_PG_<ENTITY> feature flags from environment variables and returns
 * the appropriate repository implementation (DynamoDB or PostgreSQL).
 *
 * Feature flag pattern:
 *   USE_PG_TENANT_CONFIG=true  → PostgreSQL repo (Prisma)
 *   USE_PG_TENANT_CONFIG=false → DynamoDB repo (existing behavior)
 *
 * Usage:
 *   import { getTenantConfigRepository } from '@/lib/db/repository-factory'
 *   const repo = getTenantConfigRepository()
 *   await repo.getConfig('theme', 'tenant-id')
 *
 * NOTE: ITenantConfigRepository is a placeholder `any` here.
 * Plan 03 replaces this line with:
 *   import { ITenantConfigRepository } from './repositories/tenant-config/interface'
 */

// Plan 03 replaces this placeholder with the real import from:
// './repositories/tenant-config/interface'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ITenantConfigRepository = any;

/**
 * Returns the active ITenantConfigRepository implementation.
 * Controlled by USE_PG_TENANT_CONFIG environment variable.
 *
 * Implementation files (created in Plan 03):
 *   - DynamoDB: web-ui/lib/db/repositories/tenant-config/dynamo.ts
 *   - PostgreSQL: web-ui/lib/db/repositories/tenant-config/postgres.ts
 */
export function getTenantConfigRepository(): ITenantConfigRepository {
    const usePg = process.env.USE_PG_TENANT_CONFIG === 'true';

    if (usePg) {
        // Dynamic require defers loading until needed — avoids Prisma import errors
        // when DATABASE_URL is not set (e.g., DynamoDB-only deployments)
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { TenantConfigPostgresRepository } = require('./repositories/tenant-config/postgres');
        return new TenantConfigPostgresRepository();
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { TenantConfigDynamoRepository } = require('./repositories/tenant-config/dynamo');
    return new TenantConfigDynamoRepository();
}

/**
 * Feature flag helper — exported for testing and logging.
 * Returns true if the entity is configured to use PostgreSQL.
 */
export function isUsingPostgres(entityFlag: string): boolean {
    return process.env[entityFlag] === 'true';
}
