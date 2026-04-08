/**
 * Repository Factory
 *
 * All repositories use PostgreSQL via Prisma ORM.
 * DynamoDB implementations have been removed.
 *
 * Usage:
 *   import { getTenantConfigRepository } from '@/lib/db/repository-factory'
 *   const repo = getTenantConfigRepository()
 *   await repo.getConfig('theme', 'tenant-id')
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

export function getTenantConfigRepository(): ITenantConfigRepository {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { TenantConfigPostgresRepository } = require('./repositories/tenant-config/postgres');
    return new TenantConfigPostgresRepository();
}

export function getAccountRepository(): IAccountRepository {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AccountPostgresRepository } = require('./repositories/account/postgres');
    return new AccountPostgresRepository();
}

export function getRbacRepository(): IRbacRepository {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { RbacPostgresRepository } = require('./repositories/rbac/postgres');
    return new RbacPostgresRepository();
}

export function getScheduleRepository(): IScheduleRepository {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { SchedulePostgresRepository } = require('./repositories/schedule/postgres');
    return new SchedulePostgresRepository();
}

export function getScheduleExecutionRepository(): IScheduleExecutionRepository {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ScheduleExecutionPostgresRepository } = require('./repositories/schedule-execution/postgres');
    return new ScheduleExecutionPostgresRepository();
}

export function getAuditLogRepository(): IAuditLogRepository {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AuditLogPostgresRepository } = require('./repositories/audit-log/postgres');
    return new AuditLogPostgresRepository();
}

export function getKnowledgeBaseRepository(): IKnowledgeBaseRepository {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { KnowledgeBasePostgresRepository } = require('./repositories/knowledge-base/postgres');
    return new KnowledgeBasePostgresRepository();
}

export function getDataSourceRepository(): IDataSourceRepository {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DataSourcePostgresRepository } = require('./repositories/data-source/postgres');
    return new DataSourcePostgresRepository();
}

export function getInventoryRepository(): IInventoryRepository {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { InventoryPostgresRepository } = require('./repositories/inventory/postgres');
    return new InventoryPostgresRepository();
}

export function getAgentOpsRunRepository(): IAgentOpsRunRepository {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AgentOpsRunPostgresRepository } = require('./repositories/agent-ops-run/postgres');
    return new AgentOpsRunPostgresRepository();
}

export function getAgentOpsEventRepository(): IAgentOpsEventRepository {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AgentOpsEventPostgresRepository } = require('./repositories/agent-ops-event/postgres');
    return new AgentOpsEventPostgresRepository();
}

export function getScheduledTaskRepository(): IScheduledTaskRepository {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ScheduledTaskPostgresRepository } = require('./repositories/scheduled-task/postgres');
    return new ScheduledTaskPostgresRepository();
}

/**
 * Feature flag helper — kept for backward compat with existing callers.
 * Always returns true since all entities now use PostgreSQL.
 */
export function isUsingPostgres(_entityFlag: string): boolean {
    return true;
}
