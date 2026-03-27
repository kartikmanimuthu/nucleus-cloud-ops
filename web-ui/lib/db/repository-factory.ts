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
 * Type: ITenantConfigRepository is imported from the repository interface file.
 */

import type { ITenantConfigRepository } from './repositories/tenant-config/interface';
import type { IAccountRepository } from './repositories/account/interface';
import type { IRbacRepository } from './repositories/rbac/interface';
import type { IScheduleRepository } from './repositories/schedule/interface';
import type { IScheduleExecutionRepository } from './repositories/schedule-execution/interface';
import type { IAuditLogRepository } from './repositories/audit-log/interface';

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
 * Returns the active IAccountRepository implementation.
 * Controlled by USE_PG_ACCOUNTS environment variable.
 *
 * Implementation files:
 *   - DynamoDB: web-ui/lib/db/repositories/account/dynamo.ts
 *   - PostgreSQL: web-ui/lib/db/repositories/account/postgres.ts
 */
export function getAccountRepository(): IAccountRepository {
    const usePg = process.env.USE_PG_ACCOUNTS === 'true';

    if (usePg) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { AccountPostgresRepository } = require('./repositories/account/postgres');
        return new AccountPostgresRepository();
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AccountDynamoRepository } = require('./repositories/account/dynamo');
    return new AccountDynamoRepository();
}

/**
 * Returns the active IRbacRepository implementation.
 * Controlled by USE_PG_RBAC environment variable.
 *
 * Implementation files:
 *   - DynamoDB: web-ui/lib/db/repositories/rbac/dynamo.ts
 *   - PostgreSQL: web-ui/lib/db/repositories/rbac/postgres.ts
 */
export function getRbacRepository(): IRbacRepository {
    const usePg = process.env.USE_PG_RBAC === 'true';

    if (usePg) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { RbacPostgresRepository } = require('./repositories/rbac/postgres');
        return new RbacPostgresRepository();
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { RbacDynamoRepository } = require('./repositories/rbac/dynamo');
    return new RbacDynamoRepository();
}

/**
 * Returns the active IScheduleRepository implementation.
 * Controlled by USE_PG_SCHEDULES environment variable.
 *
 * Implementation files:
 *   - DynamoDB: web-ui/lib/db/repositories/schedule/dynamo.ts
 *   - PostgreSQL: web-ui/lib/db/repositories/schedule/postgres.ts
 */
export function getScheduleRepository(): IScheduleRepository {
    const usePg = process.env.USE_PG_SCHEDULES === 'true';

    if (usePg) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { SchedulePostgresRepository } = require('./repositories/schedule/postgres');
        return new SchedulePostgresRepository();
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ScheduleDynamoRepository } = require('./repositories/schedule/dynamo');
    return new ScheduleDynamoRepository();
}

/**
 * Returns the active IScheduleExecutionRepository implementation.
 * Controlled by USE_PG_SCHEDULES environment variable.
 *
 * Implementation files:
 *   - DynamoDB: web-ui/lib/db/repositories/schedule-execution/dynamo.ts
 *   - PostgreSQL: web-ui/lib/db/repositories/schedule-execution/postgres.ts
 */
export function getScheduleExecutionRepository(): IScheduleExecutionRepository {
    const usePg = process.env.USE_PG_SCHEDULES === 'true';

    if (usePg) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { ScheduleExecutionPostgresRepository } = require('./repositories/schedule-execution/postgres');
        return new ScheduleExecutionPostgresRepository();
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ScheduleExecutionDynamoRepository } = require('./repositories/schedule-execution/dynamo');
    return new ScheduleExecutionDynamoRepository();
}

/**
 * Returns the active IAuditLogRepository implementation.
 * Controlled by USE_PG_AUDIT_LOGS environment variable.
 *
 * Implementation files:
 *   - DynamoDB: web-ui/lib/db/repositories/audit-log/dynamo.ts
 *   - PostgreSQL: web-ui/lib/db/repositories/audit-log/postgres.ts
 */
export function getAuditLogRepository(): IAuditLogRepository {
    const usePg = process.env.USE_PG_AUDIT_LOGS === 'true';

    if (usePg) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { AuditLogPostgresRepository } = require('./repositories/audit-log/postgres');
        return new AuditLogPostgresRepository();
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AuditLogDynamoRepository } = require('./repositories/audit-log/dynamo');
    return new AuditLogDynamoRepository();
}

/**
 * Feature flag helper — exported for testing and logging.
 * Returns true if the entity is configured to use PostgreSQL.
 */
export function isUsingPostgres(entityFlag: string): boolean {
    return process.env[entityFlag] === 'true';
}
