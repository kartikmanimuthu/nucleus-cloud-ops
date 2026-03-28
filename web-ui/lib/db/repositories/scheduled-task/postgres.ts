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
import { getPrismaClient } from '@/lib/db/pg-config';
import type { ScheduledTask, AgentOpsStatus } from '@/lib/agent-ops/types';
import type {
    IScheduledTaskRepository,
    CreateScheduledTaskParams,
    UpdateScheduledTaskParams,
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

function toScheduledTask(r: {
    id: string;
    tenantId: string;
    taskId: string;
    name: string;
    description: string;
    cronExpression: string;
    timezone: string;
    taskStatus: string;
    mode: string;
    autoApprove: boolean;
    model: string | null;
    accountId: string | null;
    accountName: string | null;
    mcpServerIds: string[];
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
        cronExpression: r.cronExpression,
        timezone: r.timezone,
        taskStatus: r.taskStatus as ScheduledTask['taskStatus'],
        mode: r.mode as ScheduledTask['mode'],
        autoApprove: r.autoApprove,
        model: r.model ?? undefined,
        accountId: r.accountId ?? undefined,
        accountName: r.accountName ?? undefined,
        mcpServerIds: r.mcpServerIds,
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
        const nextRunAt = computeNextRunAt(params.cronExpression, params.timezone);

        const record = await getPrismaClient().scheduledTask.create({
            data: {
                tenantId: params.tenantId,
                taskId,
                name: params.name,
                description: params.description,
                cronExpression: params.cronExpression,
                timezone: params.timezone,
                taskStatus: 'active',
                mode: params.mode,
                autoApprove: params.autoApprove,
                model: params.model ?? null,
                accountId: params.accountId ?? null,
                accountName: params.accountName ?? null,
                mcpServerIds: params.mcpServerIds ?? [],
                notification: (params.notification as object) ?? {},
                nextRunAt: nextRunAt ?? null,
                runCount: 0,
                createdBy: params.createdBy,
            },
        });

        return toScheduledTask(record);
    }

    async getScheduledTask(tenantId: string, taskId: string): Promise<ScheduledTask | null> {
        const record = await getPrismaClient().scheduledTask.findFirst({
            where: { tenantId, taskId },
        });
        return record ? toScheduledTask(record) : null;
    }

    async listScheduledTasks(tenantId: string): Promise<ScheduledTask[]> {
        const records = await getPrismaClient().scheduledTask.findMany({
            where: { tenantId, taskStatus: { not: 'deleted' } },
            orderBy: { createdAt: 'desc' },
        });
        return records.map(toScheduledTask);
    }

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

        if (updates.cronExpression || updates.timezone) {
            const task = await this.getScheduledTask(tenantId, taskId);
            if (task) {
                const cron = updates.cronExpression ?? task.cronExpression;
                const tz = updates.timezone ?? task.timezone;
                updateData.nextRunAt = computeNextRunAt(cron, tz);
            }
        }

        if (updates.notification) {
            updateData.notification = updates.notification as object;
        }

        await getPrismaClient().scheduledTask.updateMany({
            where: { tenantId, taskId },
            data: updateData,
        });
        return this.getScheduledTask(tenantId, taskId);
    }

    async pauseScheduledTask(tenantId: string, taskId: string): Promise<void> {
        await getPrismaClient().scheduledTask.updateMany({
            where: { tenantId, taskId },
            data: { taskStatus: 'paused', nextRunAt: null },
        });
    }

    async resumeScheduledTask(tenantId: string, taskId: string): Promise<ScheduledTask | null> {
        const task = await this.getScheduledTask(tenantId, taskId);
        if (!task) return null;
        const nextRunAt = computeNextRunAt(task.cronExpression, task.timezone);
        await getPrismaClient().scheduledTask.updateMany({
            where: { tenantId, taskId },
            data: { taskStatus: 'active', nextRunAt: nextRunAt ?? null },
        });
        return this.getScheduledTask(tenantId, taskId);
    }

    async deleteScheduledTask(tenantId: string, taskId: string): Promise<void> {
        await getPrismaClient().scheduledTask.updateMany({
            where: { tenantId, taskId },
            data: { taskStatus: 'deleted', nextRunAt: null },
        });
    }

    async updateLastRun(
        tenantId: string,
        taskId: string,
        runId: string,
        status: AgentOpsStatus
    ): Promise<void> {
        const task = await this.getScheduledTask(tenantId, taskId);
        if (!task) return;
        const nextRunAt = computeNextRunAt(task.cronExpression, task.timezone);
        await getPrismaClient().scheduledTask.updateMany({
            where: { tenantId, taskId },
            data: {
                lastRunId: runId,
                lastRunAt: new Date(),
                lastRunStatus: status,
                nextRunAt: nextRunAt ?? null,
                runCount: { increment: 1 },
            },
        });
    }

    // AOPS-04: ON CONFLICT (taskId, scheduledAt) DO NOTHING for atomic lock acquisition
    async tryAcquireExecutionLock(taskId: string, scheduledAt: string): Promise<boolean> {
        const expiresAt = new Date(Date.now() + 3600 * 1000);
        try {
            await getPrismaClient().$executeRaw`
                INSERT INTO "scheduled_task_locks" ("id", "taskId", "scheduledAt", "acquiredAt", "expiresAt")
                VALUES (gen_random_uuid(), ${taskId}, ${scheduledAt}, NOW(), ${expiresAt})
                ON CONFLICT ("taskId", "scheduledAt") DO NOTHING
            `;

            // Check if the lock row exists and was acquired recently (within 2 seconds)
            const lock = await getPrismaClient().scheduledTaskLock.findUnique({
                where: { taskId_scheduledAt: { taskId, scheduledAt } },
            });

            return lock !== null && (Date.now() - lock.acquiredAt.getTime()) < 2000;
        } catch {
            return false;
        }
    }
}
