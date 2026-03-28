/**
 * ScheduledTaskDynamoRepository
 *
 * DynamoDB implementation of IScheduledTaskRepository.
 * Delegates to Dynamoose ScheduledTaskModel — preserves exact DynamoDB patterns.
 * Uses raw DynamoDBClient PutItemCommand for conditional lock acquisition.
 */
import { v4 as uuidv4 } from 'uuid';
import { Cron } from 'croner';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { ScheduledTaskModel } from '@/lib/agent-ops/models/scheduled-task';
import { AGENT_OPS_TABLE_NAME } from '@/lib/agent-ops/dynamoose-config';
import type { ScheduledTask, AgentOpsStatus } from '@/lib/agent-ops/types';
import type {
    IScheduledTaskRepository,
    CreateScheduledTaskParams,
    UpdateScheduledTaskParams,
} from './interface';

const region = process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || 'ap-south-1';
const ddbClient = new DynamoDBClient({ region });

function computeNextRunAt(cronExpression: string, timezone: string): string | undefined {
    try {
        const job = new Cron(cronExpression, { timezone, paused: true });
        const next = job.nextRun();
        job.stop();
        return next?.toISOString();
    } catch {
        return undefined;
    }
}

export class ScheduledTaskDynamoRepository implements IScheduledTaskRepository {
    async createScheduledTask(params: CreateScheduledTaskParams): Promise<ScheduledTask> {
        const taskId = uuidv4();
        const now = new Date().toISOString();
        const nextRunAt = computeNextRunAt(params.cronExpression, params.timezone);

        const task: ScheduledTask = {
            PK: `TENANT#${params.tenantId}`,
            SK: `SCHED#${taskId}`,
            GSI1PK: 'TYPE#SCHEDULED_TASK',
            GSI1SK: `${params.tenantId}#${taskId}`,
            taskId,
            tenantId: params.tenantId,
            name: params.name,
            description: params.description,
            cronExpression: params.cronExpression,
            timezone: params.timezone,
            taskStatus: 'active',
            mode: params.mode,
            autoApprove: params.autoApprove,
            model: params.model,
            accountId: params.accountId,
            accountName: params.accountName,
            mcpServerIds: params.mcpServerIds,
            notification: params.notification,
            nextRunAt,
            runCount: 0,
            createdAt: now,
            updatedAt: now,
            createdBy: params.createdBy,
        };

        await ScheduledTaskModel.create(task);
        return task;
    }

    async getScheduledTask(tenantId: string, taskId: string): Promise<ScheduledTask | null> {
        try {
            const item = await ScheduledTaskModel.get({ PK: `TENANT#${tenantId}`, SK: `SCHED#${taskId}` });
            return (item as unknown as ScheduledTask) || null;
        } catch {
            return null;
        }
    }

    async listScheduledTasks(tenantId: string): Promise<ScheduledTask[]> {
        const result = await ScheduledTaskModel.query('PK')
            .eq(`TENANT#${tenantId}`)
            .where('SK')
            .beginsWith('SCHED#')
            .exec();
        const tasks = result.toJSON() as unknown as ScheduledTask[];
        return tasks.filter(t => t.taskStatus !== 'deleted');
    }

    async listAllActiveTasks(): Promise<ScheduledTask[]> {
        const result = await ScheduledTaskModel.query('GSI1PK')
            .eq('TYPE#SCHEDULED_TASK')
            .using('GSI1')
            .exec();
        const tasks = result.toJSON() as unknown as ScheduledTask[];
        return tasks.filter(t => t.taskStatus === 'active');
    }

    async updateScheduledTask(
        tenantId: string,
        taskId: string,
        updates: UpdateScheduledTaskParams
    ): Promise<ScheduledTask | null> {
        const now = new Date().toISOString();
        const updateData: Record<string, unknown> = { ...updates, updatedAt: now };

        if (updates.cronExpression || updates.timezone) {
            const task = await this.getScheduledTask(tenantId, taskId);
            if (task) {
                const cron = updates.cronExpression ?? task.cronExpression;
                const tz = updates.timezone ?? task.timezone;
                updateData.nextRunAt = computeNextRunAt(cron, tz);
            }
        }

        await ScheduledTaskModel.update(
            { PK: `TENANT#${tenantId}`, SK: `SCHED#${taskId}` },
            updateData
        );
        return this.getScheduledTask(tenantId, taskId);
    }

    async pauseScheduledTask(tenantId: string, taskId: string): Promise<void> {
        await ScheduledTaskModel.update(
            { PK: `TENANT#${tenantId}`, SK: `SCHED#${taskId}` },
            { taskStatus: 'paused', nextRunAt: undefined, updatedAt: new Date().toISOString() }
        );
    }

    async resumeScheduledTask(tenantId: string, taskId: string): Promise<ScheduledTask | null> {
        const task = await this.getScheduledTask(tenantId, taskId);
        if (!task) return null;
        const nextRunAt = computeNextRunAt(task.cronExpression, task.timezone);
        await ScheduledTaskModel.update(
            { PK: `TENANT#${tenantId}`, SK: `SCHED#${taskId}` },
            { taskStatus: 'active', nextRunAt, updatedAt: new Date().toISOString() }
        );
        return this.getScheduledTask(tenantId, taskId);
    }

    async deleteScheduledTask(tenantId: string, taskId: string): Promise<void> {
        const ttl = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
        await ScheduledTaskModel.update(
            { PK: `TENANT#${tenantId}`, SK: `SCHED#${taskId}` },
            { taskStatus: 'deleted', nextRunAt: undefined, ttl, updatedAt: new Date().toISOString() }
        );
    }

    async updateLastRun(
        tenantId: string,
        taskId: string,
        runId: string,
        status: AgentOpsStatus
    ): Promise<void> {
        const now = new Date().toISOString();
        const task = await this.getScheduledTask(tenantId, taskId);
        if (!task) return;
        const nextRunAt = computeNextRunAt(task.cronExpression, task.timezone);
        await ScheduledTaskModel.update(
            { PK: `TENANT#${tenantId}`, SK: `SCHED#${taskId}` },
            {
                lastRunId: runId,
                lastRunAt: now,
                lastRunStatus: status,
                nextRunAt,
                runCount: (task.runCount || 0) + 1,
                updatedAt: now,
            }
        );
    }

    async tryAcquireExecutionLock(taskId: string, scheduledAt: string): Promise<boolean> {
        const ttl = Math.floor(Date.now() / 1000) + 3600;
        try {
            await ddbClient.send(new PutItemCommand({
                TableName: AGENT_OPS_TABLE_NAME,
                Item: {
                    PK: { S: `SCHED_LOCK#${taskId}` },
                    SK: { S: `EXEC#${scheduledAt}` },
                    ttl: { N: String(ttl) },
                },
                ConditionExpression: 'attribute_not_exists(PK)',
            }));
            return true;
        } catch (err: any) {
            if (err.name === 'ConditionalCheckFailedException') return false;
            throw err;
        }
    }
}
