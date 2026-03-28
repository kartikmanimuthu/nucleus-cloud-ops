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
import type { IKnowledgeBaseRepository } from './repositories/knowledge-base/interface';
import type { IDataSourceRepository } from './repositories/data-source/interface';
import type { IInventoryRepository } from './repositories/inventory/interface';
import type { IAgentOpsRunRepository } from './repositories/agent-ops-run/interface';
import type { IAgentOpsEventRepository } from './repositories/agent-ops-event/interface';
import type { IScheduledTaskRepository } from './repositories/scheduled-task/interface';

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
 * Returns the active IKnowledgeBaseRepository implementation.
 * Controlled by USE_PG_KB environment variable.
 *
 * Implementation files:
 *   - DynamoDB: web-ui/lib/db/repositories/knowledge-base/dynamo.ts
 *   - PostgreSQL: web-ui/lib/db/repositories/knowledge-base/postgres.ts
 */
export function getKnowledgeBaseRepository(): IKnowledgeBaseRepository {
    const usePg = process.env.USE_PG_KB === 'true';

    if (usePg) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { KnowledgeBasePostgresRepository } = require('./repositories/knowledge-base/postgres');
        return new KnowledgeBasePostgresRepository();
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { KnowledgeBaseDynamoRepository } = require('./repositories/knowledge-base/dynamo');
    return new KnowledgeBaseDynamoRepository();
}

/**
 * Returns the active IDataSourceRepository implementation.
 * Controlled by USE_PG_KB environment variable (same flag as KB — they're a unit).
 *
 * Implementation files:
 *   - DynamoDB: web-ui/lib/db/repositories/data-source/dynamo.ts
 *   - PostgreSQL: web-ui/lib/db/repositories/data-source/postgres.ts
 */
export function getDataSourceRepository(): IDataSourceRepository {
    const usePg = process.env.USE_PG_KB === 'true';

    if (usePg) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { DataSourcePostgresRepository } = require('./repositories/data-source/postgres');
        return new DataSourcePostgresRepository();
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DataSourceDynamoRepository } = require('./repositories/data-source/dynamo');
    return new DataSourceDynamoRepository();
}

/**
 * Returns the active IInventoryRepository implementation.
 * Controlled by USE_PG_INVENTORY environment variable.
 *
 * Implementation files:
 *   - DynamoDB: web-ui/lib/db/repositories/inventory/dynamo.ts
 *   - PostgreSQL: web-ui/lib/db/repositories/inventory/postgres.ts
 */
export function getInventoryRepository(): IInventoryRepository {
    const usePg = process.env.USE_PG_INVENTORY === 'true';

    if (usePg) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { InventoryPostgresRepository } = require('./repositories/inventory/postgres');
        return new InventoryPostgresRepository();
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { InventoryDynamoRepository } = require('./repositories/inventory/dynamo');
    return new InventoryDynamoRepository();
}

/**
 * Returns the active IAgentOpsRunRepository implementation.
 * Controlled by USE_PG_AGENT_OPS environment variable.
 *
 * Implementation files:
 *   - DynamoDB: web-ui/lib/db/repositories/agent-ops-run/dynamo.ts
 *   - PostgreSQL: web-ui/lib/db/repositories/agent-ops-run/postgres.ts
 */
export function getAgentOpsRunRepository(): IAgentOpsRunRepository {
    const usePg = process.env.USE_PG_AGENT_OPS === 'true';

    if (usePg) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { AgentOpsRunPostgresRepository } = require('./repositories/agent-ops-run/postgres');
        return new AgentOpsRunPostgresRepository();
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AgentOpsRunDynamoRepository } = require('./repositories/agent-ops-run/dynamo');
    return new AgentOpsRunDynamoRepository();
}

/**
 * Returns the active IAgentOpsEventRepository implementation.
 * Controlled by USE_PG_AGENT_OPS environment variable.
 *
 * Implementation files:
 *   - DynamoDB: web-ui/lib/db/repositories/agent-ops-event/dynamo.ts
 *   - PostgreSQL: web-ui/lib/db/repositories/agent-ops-event/postgres.ts
 */
export function getAgentOpsEventRepository(): IAgentOpsEventRepository {
    const usePg = process.env.USE_PG_AGENT_OPS === 'true';

    if (usePg) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { AgentOpsEventPostgresRepository } = require('./repositories/agent-ops-event/postgres');
        return new AgentOpsEventPostgresRepository();
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AgentOpsEventDynamoRepository } = require('./repositories/agent-ops-event/dynamo');
    return new AgentOpsEventDynamoRepository();
}

/**
 * Returns the active IScheduledTaskRepository implementation.
 * Controlled by USE_PG_AGENT_OPS environment variable.
 *
 * Implementation files:
 *   - DynamoDB: web-ui/lib/db/repositories/scheduled-task/dynamo.ts
 *   - PostgreSQL: web-ui/lib/db/repositories/scheduled-task/postgres.ts
 */
export function getScheduledTaskRepository(): IScheduledTaskRepository {
    const usePg = process.env.USE_PG_AGENT_OPS === 'true';

    if (usePg) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { ScheduledTaskPostgresRepository } = require('./repositories/scheduled-task/postgres');
        return new ScheduledTaskPostgresRepository();
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ScheduledTaskDynamoRepository } = require('./repositories/scheduled-task/dynamo');
    return new ScheduledTaskDynamoRepository();
}

/**
 * Feature flag helper — exported for testing and logging.
 * Returns true if the entity is configured to use PostgreSQL.
 */
export function isUsingPostgres(entityFlag: string): boolean {
    return process.env[entityFlag] === 'true';
}
