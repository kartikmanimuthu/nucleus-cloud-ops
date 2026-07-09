// pg-service.ts — PostgreSQL service for the scheduler Lambda
// Uses raw 'pg' Pool (NOT Prisma) to keep Lambda bundle under size limits.
// Max 3 connections (SCHED-06 requirement) with aggressive idle timeout.

import { Pool, type PoolClient } from 'pg';
import { logger } from '../utils/logger.js';
import type { Schedule, ScheduleExecutionMetadata } from '../types/index.js';
import { env } from '../../../env.js';

const DATABASE_URL = env.DATABASE_URL;

let pool: Pool | null = null;

function getPool(): Pool {
    if (!pool) {
        if (!DATABASE_URL) {
            throw new Error('DATABASE_URL environment variable is required for PostgreSQL mode');
        }
        pool = new Pool({
            connectionString: DATABASE_URL,
            max: 3,                    // SCHED-06: Lambda pool limit — keep connection count low
            idleTimeoutMillis: 10000,  // SCHED-06: release idle connections quickly (10s)
            connectionTimeoutMillis: 5000,
        });
    }
    return pool;
}

/**
 * Get all active schedules for a tenant.
 * Replaces DynamoDB GSI1 TYPE#SCHEDULE / GSI3 STATUS#active query.
 * Multi-tenant safety: WHERE tenant_id = $1 on every query.
 */
/**
 * Get all tenants with status = 'active'.
 * Used by scheduler to iterate tenants sequentially (D-07, D-09).
 */
export async function getActiveTenants(): Promise<Array<{ id: string; name: string }>> {
    const client: PoolClient = await getPool().connect();
    try {
        const result = await client.query(
            `SELECT id, name FROM tenants WHERE status = 'active' ORDER BY "createdAt" ASC`
        );
        logger.debug(`[pg-service] Fetched ${result.rows.length} active tenants`);
        return result.rows;
    } catch (error) {
        logger.error('[pg-service] Error fetching active tenants', error);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Get all active schedules for a tenant.
 * Replaces DynamoDB GSI1 TYPE#SCHEDULE / GSI3 STATUS#active query.
 * Multi-tenant safety: WHERE tenant_id = $1 on every query.
 */
export async function getSchedules(tenantId: string): Promise<Schedule[]> {
    const client: PoolClient = await getPool().connect();
    try {
        const result = await client.query(
            `SELECT "scheduleId",
                    "tenantId",
                    "accountId",
                    name,
                    description,
                    starttime,
                    endtime,
                    timezone,
                    days,
                    active,
                    resources,
                    "createdAt",
                    "updatedAt"
             FROM schedules
             WHERE "tenantId" = $1
               AND active = true
             ORDER BY "createdAt" DESC`,
            [tenantId]
        );

        logger.debug(`[pg-service] Fetched ${result.rows.length} active schedules for tenant ${tenantId}`);

        return result.rows.map((row) => ({
            ...row,
            type: 'schedule' as const,
            days: row.days || [],
            resources: row.resources || [],
        }));
    } catch (error) {
        logger.error('[pg-service] Error fetching schedules from PostgreSQL', error);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Log execution result to the schedule_executions table.
 * Multi-tenant safety: INSERT includes tenant_id column.
 */
export async function logExecution(execution: {
    tenantId: string;
    scheduleId: string;
    accountId: string;
    status: string;
    executionTime: string;
    /** Pre-generated executionId shared with the audit log; falls back to a generated one. */
    executionId?: string;
    resourcesStarted?: number;
    resourcesStopped?: number;
    resourcesFailed?: number;
    duration?: number;
    errorMessage?: string;
    scheduleMetadata?: ScheduleExecutionMetadata;
}): Promise<void> {
    const client: PoolClient = await getPool().connect();
    try {
        const id = `clex-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const executionId = execution.executionId ?? `exec-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        // 90-day TTL replacement — expiresAt used for WHERE expiresAt < NOW() cleanup jobs
        const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

        await client.query(
            `INSERT INTO schedule_executions
               (id, "tenantId", "executionId", "scheduleId", "accountId", status, "executionTime",
                "resourcesStarted", "resourcesStopped", "resourcesFailed", duration,
                "errorMessage", "scheduleMetadata", "expiresAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
             ON CONFLICT ("tenantId", "executionId") DO NOTHING`,
            [
                id,
                execution.tenantId,
                executionId,
                execution.scheduleId,
                execution.accountId,
                execution.status,
                execution.executionTime,
                execution.resourcesStarted ?? 0,
                execution.resourcesStopped ?? 0,
                execution.resourcesFailed ?? 0,
                execution.duration ?? null,
                execution.errorMessage ?? null,
                execution.scheduleMetadata ? JSON.stringify(execution.scheduleMetadata) : null,
                expiresAt.toISOString(),
            ]
        );

        logger.debug(
            `[pg-service] Logged execution ${executionId} for schedule ${execution.scheduleId}`
        );
    } catch (error) {
        logger.error('[pg-service] Error logging execution to PostgreSQL', error);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Get all active accounts for a tenant.
 * Replaces DynamoDB GSI3 TYPE#ACCOUNT / STATUS#active query.
 */
export async function getAccounts(tenantId: string): Promise<import('../types/index.js').Account[]> {
    const client: PoolClient = await getPool().connect();
    try {
        const result = await client.query(
            `SELECT "accountId",
                    name,
                    "roleArn",
                    "externalId",
                    regions,
                    active,
                    "tenantId"
             FROM accounts
             WHERE "tenantId" = $1
               AND active = true`,
            [tenantId]
        );
        logger.debug(`[pg-service] Fetched ${result.rows.length} active accounts for tenant ${tenantId}`);
        return result.rows;
    } catch (error) {
        logger.error('[pg-service] Error fetching accounts from PostgreSQL', error);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Write an audit log entry to PostgreSQL.
 * Replaces DynamoDB NucleusAuditTable write.
 */
export async function createAuditLog(entry: {
    tenantId: string;
    eventType: string;
    action: string;
    user: string;
    userType: string;
    resourceType: string;
    resourceId: string;
    status: string;
    severity: string;
    details: string;
    accountId?: string;
    region?: string;
    metadata?: Record<string, unknown>;
}): Promise<void> {
    const client: PoolClient = await getPool().connect();
    try {
        const id = `log-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const logId = `log-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const tenantId = entry.tenantId;
        // 30-day TTL for audit logs
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

        await client.query(
            `INSERT INTO audit_logs
               (id, "tenantId", "logId", timestamp, "eventType", action,
                "user", "userType", "resourceType", "resourceId",
                status, severity, details, metadata, "accountId", region, "expiresAt")
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
             ON CONFLICT DO NOTHING`,
            [
                id, tenantId, logId, new Date().toISOString(),
                entry.eventType, entry.action,
                entry.user, entry.userType,
                entry.resourceType, entry.resourceId,
                entry.status, entry.severity, entry.details,
                entry.metadata ? JSON.stringify(entry.metadata) : null,
                entry.accountId ?? null, entry.region ?? null, expiresAt.toISOString(),
            ]
        );
        logger.debug(`[pg-service] Audit log written: ${entry.eventType} / ${entry.action}`);
    } catch (error) {
        logger.error('[pg-service] Error writing audit log to PostgreSQL', error);
        // Non-fatal — don't throw
    } finally {
        client.release();
    }
}

/**
 * Get a single schedule by ID for a tenant.
 * Replaces DynamoDB GSI3 fetchScheduleById query used in partial scans.
 * Multi-tenant safety: WHERE tenant_id = $1 on every query.
 */
export async function getScheduleById(scheduleId: string, tenantId: string): Promise<Schedule | null> {
    const client: PoolClient = await getPool().connect();
    try {
        const result = await client.query(
            `SELECT "scheduleId",
                    "tenantId",
                    "accountId",
                    name,
                    description,
                    starttime,
                    endtime,
                    timezone,
                    days,
                    active,
                    resources,
                    "createdAt",
                    "updatedAt"
             FROM schedules
             WHERE "tenantId" = $1
               AND "scheduleId" = $2
             LIMIT 1`,
            [tenantId, scheduleId]
        );

        if (result.rows.length === 0) {
            logger.debug(`[pg-service] Schedule ${scheduleId} not found for tenant ${tenantId}`);
            return null;
        }

        const row = result.rows[0];
        return {
            ...row,
            type: 'schedule' as const,
            days: row.days || [],
            resources: row.resources || [],
        };
    } catch (error) {
        logger.error('[pg-service] Error fetching schedule by ID from PostgreSQL', error);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Resolve the tenantId that owns a schedule (used by the local runner when
 * --tenant-id is omitted). Returns null if the schedule does not exist.
 */
export async function getScheduleTenantId(scheduleId: string): Promise<string | null> {
    const client: PoolClient = await getPool().connect();
    try {
        const result = await client.query(
            `SELECT "tenantId" FROM schedules WHERE "scheduleId" = $1 LIMIT 1`,
            [scheduleId]
        );
        return result.rows[0]?.tenantId ?? null;
    } catch (error) {
        logger.error('[pg-service] Error resolving schedule tenant', error);
        return null;
    } finally {
        client.release();
    }
}

/**
 * Get execution history for a schedule from PostgreSQL.
 * Replaces DynamoDB pk=EXEC#tenantId#scheduleId query.
 */
export async function getExecutionHistory(
    scheduleId: string,
    tenantId: string,
    limit: number = 50
): Promise<import('../types/index.js').ExecutionRecord[]> {
    const client: PoolClient = await getPool().connect();
    try {
        const result = await client.query(
            `SELECT "executionId", "scheduleId", "tenantId", "accountId",
                    status, "executionTime" as "startTime", duration,
                    "resourcesStarted", "resourcesStopped", "resourcesFailed",
                    "errorMessage", "scheduleMetadata"
             FROM schedule_executions
             WHERE "tenantId" = $1
               AND "scheduleId" = $2
             ORDER BY "executionTime" DESC
             LIMIT $3`,
            [tenantId, scheduleId, limit]
        );
        return result.rows.map((row) => ({
            ...row,
            startTime: row.startTime?.toISOString?.() ?? row.startTime,
            schedule_metadata: row.scheduleMetadata ?? undefined,
            triggeredBy: 'system' as const,
            scheduleName: '',
            ttl: 0,
        }));
    } catch (error) {
        logger.error('[pg-service] Error fetching execution history from PostgreSQL', error);
        return [];
    } finally {
        client.release();
    }
}

/**
 * Close the connection pool — should be called at Lambda shutdown.
 */
export async function closePool(): Promise<void> {
    if (pool) {
        await pool.end();
        pool = null;
        logger.debug('[pg-service] Connection pool closed');
    }
}

/**
 * Get scheduler cron config for a tenant.
 * Reads from tenant_configs table (key: 'scheduler-cron').
 * Returns intervalMinutes (default 30 if not configured).
 */
export async function getTenantSchedulerConfig(tenantId: string): Promise<{ intervalMinutes: number }> {
    const client: PoolClient = await getPool().connect();
    try {
        const result = await client.query(
            `SELECT data FROM tenant_configs WHERE "tenantId" = $1 AND "configKey" = 'scheduler-cron' LIMIT 1`,
            [tenantId]
        );
        if (result.rows.length === 0) return { intervalMinutes: 30 };
        const data = result.rows[0].data as { intervalMinutes?: number };
        return { intervalMinutes: data.intervalMinutes ?? 30 };
    } catch (error) {
        logger.error('[pg-service] Error fetching tenant scheduler config', error);
        return { intervalMinutes: 30 }; // safe default
    } finally {
        client.release();
    }
}

export type JobType = 'scheduler-cron' | 'discovery-cron';

export interface SchedulerJobConfig {
    intervalMinutes: number;
    lastRunAt: string | null;
}

export interface DiscoveryJobConfig {
    period: 'daily' | 'weekly' | 'monthly';
    lastRunAt: string | null;
}

/** Fetch the job config for a tenant by job type, returning typed defaults if not configured. */
export async function getTenantJobConfig(
    tenantId: string,
    jobType: 'scheduler-cron'
): Promise<SchedulerJobConfig>;
export async function getTenantJobConfig(
    tenantId: string,
    jobType: 'discovery-cron'
): Promise<DiscoveryJobConfig>;
export async function getTenantJobConfig(
    tenantId: string,
    jobType: JobType
): Promise<SchedulerJobConfig | DiscoveryJobConfig> {
    const client: PoolClient = await getPool().connect();
    try {
        const result = await client.query(
            `SELECT data FROM tenant_configs WHERE "tenantId" = $1 AND "configKey" = $2 LIMIT 1`,
            [tenantId, jobType]
        );
        if (result.rows.length === 0) {
            return jobType === 'scheduler-cron'
                ? { intervalMinutes: 30, lastRunAt: null }
                : { period: 'daily', lastRunAt: null };
        }
        const data = result.rows[0].data;
        return jobType === 'scheduler-cron'
            ? { intervalMinutes: data.intervalMinutes ?? 30, lastRunAt: data.lastRunAt ?? null }
            : (() => {
                const rawPeriod = data.period;
                const validPeriods = ['daily', 'weekly', 'monthly'] as const;
                const period = validPeriods.includes(rawPeriod) ? rawPeriod : 'daily';
                return { period, lastRunAt: data.lastRunAt ?? null };
            })();
    } catch (error) {
        logger.error('[pg-service] Error fetching tenant job config', { tenantId, jobType, error });
        return jobType === 'scheduler-cron'
            ? { intervalMinutes: 30, lastRunAt: null }
            : { period: 'daily', lastRunAt: null };
    } finally {
        client.release();
    }
}

/**
 * Atomically claim the right to run a tenant's periodic job.
 *
 * Replaces the check-then-act gate (read lastRunAt → compare → later write) that
 * was only safe while a single stately-queue singleton serialized the fan-out.
 * The moment two fan-out executions overlap — cron-tick expiry/overlap, a rolling
 * deploy running old+new worker tasks, or scaling to >1 worker replica — the old
 * gate let BOTH pass and double-dispatch a scan that MUTATES customer AWS
 * resources. This makes the claim a single atomic UPDATE: at most one caller wins.
 *
 * Semantics: advances lastRunAt to `nowIso` and returns true IFF the stored
 * lastRunAt is null or at least `minIntervalMs` old. The INSERT handles the
 * first-ever run (no row yet); ON CONFLICT DO UPDATE ... WHERE handles the steady
 * state, and RETURNING lets us detect whether our write actually landed.
 *
 * Note this claims BEFORE dispatch (advances lastRunAt up front), so a dispatch
 * that then fails costs the tenant one interval of delay — acceptable because the
 * next tick retries and the per-tenant queue singleton already prevents dup work.
 * Callers may pass the failed dispatch back through releaseTenantJobClaim() to
 * retry sooner.
 */
export async function tryClaimTenantRun(
    tenantId: string,
    jobType: string,
    minIntervalMs: number,
    nowIso: string = new Date().toISOString(),
): Promise<boolean> {
    const cutoffIso = new Date(Date.now() - minIntervalMs).toISOString();
    const client: PoolClient = await getPool().connect();
    try {
        const result = await client.query(
            `INSERT INTO tenant_configs ("id", "tenantId", "configKey", data, "updatedAt", "updatedBy")
             VALUES (gen_random_uuid()::text, $1, $2, jsonb_build_object('lastRunAt', $3::text), now(), 'worker')
             ON CONFLICT ("tenantId", "configKey")
             DO UPDATE SET data = tenant_configs.data || jsonb_build_object('lastRunAt', $3::text),
                           "updatedAt" = now()
             WHERE tenant_configs.data->>'lastRunAt' IS NULL
                -- CASE (not OR) so the ::timestamptz cast is only evaluated when the
                -- stored value actually looks like an ISO timestamp. A corrupt value
                -- would otherwise throw on cast → caught → fail-closed → the tenant is
                -- silently wedged forever. Treat non-ISO as claimable so it self-heals.
                OR CASE
                     WHEN tenant_configs.data->>'lastRunAt' ~ '^\\d{4}-\\d{2}-\\d{2}T'
                       THEN (tenant_configs.data->>'lastRunAt')::timestamptz <= $4::timestamptz
                     ELSE true
                   END
             RETURNING id`,
            [tenantId, jobType, nowIso, cutoffIso]
        );
        const won = (result.rowCount ?? 0) === 1;
        logger.debug('[pg-service] tryClaimTenantRun', { tenantId, jobType, won });
        return won;
    } catch (error) {
        // Fail CLOSED: on a DB error we do NOT claim, so we never dispatch an
        // AWS-mutating scan we cannot prove we were entitled to run.
        logger.error('[pg-service] tryClaimTenantRun error — treating as not-claimed', { tenantId, jobType, error });
        return false;
    } finally {
        client.release();
    }
}

/**
 * Compensating action for tryClaimTenantRun: reset lastRunAt so a tenant whose
 * dispatch failed is retried on the next tick instead of waiting a full interval.
 * Best-effort — resets to a timestamp `minIntervalMs` in the past.
 */
export async function releaseTenantJobClaim(
    tenantId: string,
    jobType: string,
    minIntervalMs: number,
): Promise<void> {
    const pastIso = new Date(Date.now() - minIntervalMs - 1000).toISOString();
    const client: PoolClient = await getPool().connect();
    try {
        await client.query(
            `UPDATE tenant_configs
             SET data = data || jsonb_build_object('lastRunAt', $3::text), "updatedAt" = now()
             WHERE "tenantId" = $1 AND "configKey" = $2`,
            [tenantId, jobType, pastIso]
        );
    } catch (error) {
        logger.error('[pg-service] releaseTenantJobClaim error', { tenantId, jobType, error });
    } finally {
        client.release();
    }
}

/** Upsert the lastRunAt timestamp for a tenant job config row. */
export async function updateTenantJobLastRun(
    tenantId: string,
    jobType: JobType,
    lastRunAt: string
): Promise<void> {
    const client: PoolClient = await getPool().connect();
    try {
        await client.query(
            `INSERT INTO tenant_configs ("id", "tenantId", "configKey", data, "updatedAt", "updatedBy")
             VALUES (gen_random_uuid()::text, $1, $2, $3::jsonb, now(), 'worker')
             ON CONFLICT ("tenantId", "configKey")
             DO UPDATE SET data = tenant_configs.data || $3::jsonb, "updatedAt" = now()`,
            [tenantId, jobType, JSON.stringify({ lastRunAt })]
        );
        logger.debug('[pg-service] Updated lastRunAt for tenant job', { tenantId, jobType, lastRunAt });
    } catch (error) {
        logger.error('[pg-service] Error updating tenant job lastRunAt', { tenantId, jobType, error });
        // Non-fatal — next tick will re-run the tenant
    } finally {
        client.release();
    }
}
