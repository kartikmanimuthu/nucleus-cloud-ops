/**
 * ScheduledTaskPostgresRepository
 *
 * PostgreSQL implementation of IScheduledTaskRepository using Prisma ORM.
 *
 * Key improvement: tryAcquireExecutionLock uses ON CONFLICT (taskId, scheduledAt) DO NOTHING
 * for atomic lock acquisition — prevents duplicate runs across ECS instances (AOPS-04).
 *
 * Multi-tenant safety: every query scoped by tenantId.
 */
import { v4 as uuidv4 } from 'uuid';
import { Cron } from 'croner';
import { getPrismaClient, getTenantClient } from '@/lib/db/pg-config';
import type { ScheduledTask, AgentOpsStatus } from '@/lib/agent-ops/types';
import type {
    IScheduledTaskRepository,
    CreateScheduledTaskParams,
    UpdateScheduledTaskParams,
    TaskListQuery,
    TaskListResult,
    TaskListStats,
} from './interface';

function computeNextRunAt(cronExpression: string, timezone: string): Date | null {
    try {
        const job = new Cron(cronExpression, { timezone, paused: true });
        const next = job.nextRun();
        job.stop();
        return next ?? null;
    } catch {
        return null;
    }
}

/**
 * Schedule-aware next-run computation. Interval tasks anchor on "now" — the
 * caller invokes this at create/resume/run-finalize time, so the next fire is
 * always intervalMinutes after the most recent lifecycle event. The worker
 * sweeper fires interval tasks when nextRunAt <= now and re-advances it.
 */
function computeNextRun(schedule: {
    scheduleType: string;
    cronExpression: string;
    timezone: string;
    intervalMinutes?: number | null;
}): Date | null {
    if (schedule.scheduleType === 'interval') {
        const minutes = schedule.intervalMinutes ?? 0;
        return minutes > 0 ? new Date(Date.now() + minutes * 60_000) : null;
    }
    return computeNextRunAt(schedule.cronExpression, schedule.timezone);
}

function toScheduledTask(r: {
    id: string;
    tenantId: string;
    taskId: string;
    name: string;
    description: string;
    scheduleType: string;
    cronExpression: string;
    intervalMinutes: number | null;
    timezone: string;
    taskStatus: string;
    mode: string;
    autoApprove: boolean;
    model: string | null;
    accountId: string | null;
    accountName: string | null;
    mcpServerIds: string[];
    knowledgeBaseIds: string[];
    notification: unknown;
    lastRunId: string | null;
    lastRunAt: Date | null;
    lastRunStatus: string | null;
    nextRunAt: Date | null;
    runCount: number;
    createdAt: Date;
    updatedAt: Date;
    createdBy: string;
}): ScheduledTask {
    return {
        PK: `TENANT#${r.tenantId}`,
        SK: `SCHED#${r.taskId}`,
        GSI1PK: 'TYPE#SCHEDULED_TASK',
        GSI1SK: `${r.tenantId}#${r.taskId}`,
        taskId: r.taskId,
        tenantId: r.tenantId,
        name: r.name,
        description: r.description,
        scheduleType: (r.scheduleType as ScheduledTask['scheduleType']) || 'cron',
        cronExpression: r.cronExpression,
        intervalMinutes: r.intervalMinutes ?? undefined,
        timezone: r.timezone,
        taskStatus: r.taskStatus as ScheduledTask['taskStatus'],
        mode: r.mode as ScheduledTask['mode'],
        autoApprove: r.autoApprove,
        model: r.model ?? undefined,
        accountId: r.accountId ?? undefined,
        accountName: r.accountName ?? undefined,
        mcpServerIds: r.mcpServerIds,
        knowledgeBaseIds: r.knowledgeBaseIds,
        notification: r.notification as ScheduledTask['notification'],
        lastRunId: r.lastRunId ?? undefined,
        lastRunAt: r.lastRunAt?.toISOString(),
        lastRunStatus: r.lastRunStatus as AgentOpsStatus | undefined,
        nextRunAt: r.nextRunAt?.toISOString(),
        runCount: r.runCount,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        createdBy: r.createdBy,
    };
}

export class ScheduledTaskPostgresRepository implements IScheduledTaskRepository {
    async createScheduledTask(params: CreateScheduledTaskParams): Promise<ScheduledTask> {
        const taskId = uuidv4();
        const scheduleType = params.scheduleType ?? 'cron';
        const nextRunAt = computeNextRun({
            scheduleType,
            cronExpression: params.cronExpression,
            timezone: params.timezone,
            intervalMinutes: params.intervalMinutes,
        });

        const record = await getTenantClient(params.tenantId).scheduledTask.create({
            data: {
                tenantId: params.tenantId,
                taskId,
                name: params.name,
                description: params.description,
                scheduleType,
                cronExpression: params.cronExpression,
                intervalMinutes: params.intervalMinutes ?? null,
                timezone: params.timezone,
                taskStatus: 'active',
                mode: params.mode,
                autoApprove: params.autoApprove,
                model: params.model ?? null,
                accountId: params.accountId ?? null,
                accountName: params.accountName ?? null,
                mcpServerIds: params.mcpServerIds ?? [],
                knowledgeBaseIds: params.knowledgeBaseIds ?? [],
                notification: (params.notification as object) ?? {},
                nextRunAt: nextRunAt ?? null,
                runCount: 0,
                createdBy: params.createdBy,
            },
        });

        return toScheduledTask(record);
    }

    async getScheduledTask(tenantId: string, taskId: string): Promise<ScheduledTask | null> {
        const record = await getTenantClient(tenantId).scheduledTask.findFirst({
            where: { tenantId, taskId },
        });
        return record ? toScheduledTask(record) : null;
    }

    async listScheduledTasks(query: TaskListQuery): Promise<TaskListResult> {
        const page = query.page ?? 1;
        const limit = query.limit || 25;
        const skip = (page - 1) * limit;
        const where: Record<string, unknown> = { tenantId: query.tenantId, taskStatus: { not: 'deleted' } };
        const orderBy = this.buildOrderBy(query.sortBy, query.sortDir);

        const [records, total] = await Promise.all([
            getTenantClient(query.tenantId).scheduledTask.findMany({
                where,
                orderBy,
                skip,
                take: limit,
            }),
            getTenantClient(query.tenantId).scheduledTask.count({ where }),
        ]);

        const tasks = records.map(toScheduledTask);
        const stats = await this.computeStats(query.tenantId);
        return { tasks, total, stats };
    }

    private buildOrderBy(
        sortBy?: TaskListQuery['sortBy'],
        sortDir?: TaskListQuery['sortDir']
    ): Record<string, 'asc' | 'desc'> {
        if (!sortBy) return { createdAt: 'desc' };
        const dir = sortDir ?? 'asc';
        return { [sortBy]: dir };
    }

    private async computeStats(tenantId: string): Promise<TaskListStats> {
        const db = getTenantClient(tenantId);
        const baseWhere = { tenantId, taskStatus: { not: 'deleted' } };
        const [active, paused, aggregate] = await Promise.all([
            db.scheduledTask.count({ where: { ...baseWhere, taskStatus: 'active' } }),
            db.scheduledTask.count({ where: { ...baseWhere, taskStatus: 'paused' } }),
            db.scheduledTask.aggregate({ where: baseWhere, _sum: { runCount: true } }),
        ]);
        return {
            active,
            paused,
            totalRuns: aggregate._sum.runCount ?? 0,
        };
    }

    // Cross-tenant: scheduler engine scans all active tasks
    async listAllActiveTasks(): Promise<ScheduledTask[]> {
        const records = await getPrismaClient().scheduledTask.findMany({
            where: { taskStatus: 'active' },
            orderBy: { createdAt: 'desc' },
        });
        return records.map(toScheduledTask);
    }

    async updateScheduledTask(
        tenantId: string,
        taskId: string,
        updates: UpdateScheduledTaskParams
    ): Promise<ScheduledTask | null> {
        const updateData: Record<string, unknown> = { ...updates };

        const scheduleChanged =
            updates.cronExpression !== undefined ||
            updates.timezone !== undefined ||
            updates.scheduleType !== undefined ||
            updates.intervalMinutes !== undefined;
        if (scheduleChanged) {
            const task = await this.getScheduledTask(tenantId, taskId);
            if (task) {
                updateData.nextRunAt = computeNextRun({
                    scheduleType: updates.scheduleType ?? task.scheduleType,
                    cronExpression: updates.cronExpression ?? task.cronExpression,
                    timezone: updates.timezone ?? task.timezone,
                    intervalMinutes: updates.intervalMinutes !== undefined
                        ? updates.intervalMinutes
                        : task.intervalMinutes,
                });
            }
        }

        if (updates.notification) {
            updateData.notification = updates.notification as object;
        }

        await getTenantClient(tenantId).scheduledTask.updateMany({
            where: { tenantId, taskId },
            data: updateData,
        });
        return this.getScheduledTask(tenantId, taskId);
    }

    async pauseScheduledTask(tenantId: string, taskId: string): Promise<void> {
        await getTenantClient(tenantId).scheduledTask.updateMany({
            where: { tenantId, taskId },
            data: { taskStatus: 'paused', nextRunAt: null },
        });
    }

    async resumeScheduledTask(tenantId: string, taskId: string): Promise<ScheduledTask | null> {
        const task = await this.getScheduledTask(tenantId, taskId);
        if (!task) return null;
        const nextRunAt = computeNextRun(task);
        await getTenantClient(tenantId).scheduledTask.updateMany({
            where: { tenantId, taskId },
            data: { taskStatus: 'active', nextRunAt: nextRunAt ?? null },
        });
        return this.getScheduledTask(tenantId, taskId);
    }

    async deleteScheduledTask(tenantId: string, taskId: string): Promise<void> {
        await getTenantClient(tenantId).scheduledTask.updateMany({
            where: { tenantId, taskId },
            data: { taskStatus: 'deleted', nextRunAt: null },
        });
    }

    async updateLastRun(
        tenantId: string,
        taskId: string,
        runId: string,
        status: AgentOpsStatus,
        opts?: { incrementRunCount?: boolean }
    ): Promise<void> {
        const task = await this.getScheduledTask(tenantId, taskId);
        if (!task) return;
        // Interval tasks re-anchor on run completion: next fire = run end + interval.
        const nextRunAt = computeNextRun(task);
        const incrementRunCount = opts?.incrementRunCount ?? true;
        await getTenantClient(tenantId).scheduledTask.updateMany({
            where: { tenantId, taskId },
            data: {
                lastRunId: runId,
                lastRunAt: new Date(),
                lastRunStatus: status,
                nextRunAt: nextRunAt ?? null,
                ...(incrementRunCount ? { runCount: { increment: 1 } } : {}),
            },
        });
    }

    // Platform-level: locks are not tenant-scoped
    async tryAcquireExecutionLock(taskId: string, scheduledAt: string): Promise<boolean> {
        const expiresAt = new Date(Date.now() + 3600 * 1000);
        try {
            // $executeRaw returns the number of rows affected by the INSERT.
            // ON CONFLICT DO NOTHING means exactly one racer gets `1`, the rest get `0` —
            // this is the atomic acquisition signal, not a follow-up read (which can't
            // distinguish "I just inserted it" from "someone else did, moments ago").
            const inserted = await getPrismaClient().$executeRaw`
                INSERT INTO "scheduled_task_locks" ("id", "taskId", "scheduledAt", "acquiredAt", "expiresAt")
                VALUES (gen_random_uuid(), ${taskId}, ${scheduledAt}, NOW(), ${expiresAt})
                ON CONFLICT ("taskId", "scheduledAt") DO NOTHING
            `;

            return inserted === 1;
        } catch {
            return false;
        }
    }
}
