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
        cronExpression: r.cronExpression,
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
        const nextRunAt = computeNextRunAt(params.cronExpression, params.timezone);

        const record = await getTenantClient(params.tenantId).scheduledTask.create({
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

    async listScheduledTasks(tenantId: string): Promise<ScheduledTask[]> {
        const records = await getTenantClient(tenantId).scheduledTask.findMany({
            where: { tenantId, taskStatus: { not: 'deleted' } },
            orderBy: { createdAt: 'desc' },
        });
        return records.map(toScheduledTask);
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
        const nextRunAt = computeNextRunAt(task.cronExpression, task.timezone);
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
        const nextRunAt = computeNextRunAt(task.cronExpression, task.timezone);
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
