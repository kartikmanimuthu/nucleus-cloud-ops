// pg-service.ts — PostgreSQL service for the scheduler Lambda
// Uses raw 'pg' Pool (NOT Prisma) to keep Lambda bundle under size limits.
// Max 3 connections (SCHED-06 requirement) with aggressive idle timeout.

import { Pool, type PoolClient } from 'pg';
import { logger } from '../utils/logger.js';
import type { Schedule, ScheduleExecutionMetadata } from '../types/index.js';

const DATABASE_URL = process.env.DATABASE_URL;
const DEFAULT_TENANT_ID = process.env.DEFAULT_TENANT_ID || 'org-default';

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
export async function getSchedules(tenantId: string = DEFAULT_TENANT_ID): Promise<Schedule[]> {
    const client: PoolClient = await getPool().connect();
    try {
        const result = await client.query(
            `SELECT schedule_id as "scheduleId",
                    tenant_id    as "tenantId",
                    account_id   as "accountId",
                    name,
                    description,
                    starttime,
                    endtime,
                    timezone,
                    days,
                    active,
                    resources,
                    created_at   as "createdAt",
                    updated_at   as "updatedAt"
             FROM schedules
             WHERE tenant_id = $1
               AND active = true
             ORDER BY created_at DESC`,
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
    resourcesStarted?: number;
    resourcesStopped?: number;
    resourcesFailed?: number;
    duration?: number;
    errorMessage?: string;
    scheduleMetadata?: ScheduleExecutionMetadata;
}): Promise<void> {
    const client: PoolClient = await getPool().connect();
    try {
        const executionId = `exec-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        // 90-day TTL replacement — expiresAt used for WHERE expiresAt < NOW() cleanup jobs
        const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

        await client.query(
            `INSERT INTO schedule_executions
               (tenant_id, execution_id, schedule_id, account_id, status, execution_time,
                resources_started, resources_stopped, resources_failed, duration,
                error_message, schedule_metadata, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
             ON CONFLICT (tenant_id, execution_id) DO NOTHING`,
            [
                execution.tenantId,
                executionId,
                execution.scheduleId,
                execution.accountId,
                execution.status,
                new Date(execution.executionTime),
                execution.resourcesStarted ?? 0,
                execution.resourcesStopped ?? 0,
                execution.resourcesFailed ?? 0,
                execution.duration ?? null,
                execution.errorMessage ?? null,
                execution.scheduleMetadata ? JSON.stringify(execution.scheduleMetadata) : null,
                expiresAt,
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
 * Close the connection pool — should be called at Lambda shutdown.
 */
export async function closePool(): Promise<void> {
    if (pool) {
        await pool.end();
        pool = null;
        logger.debug('[pg-service] Connection pool closed');
    }
}
