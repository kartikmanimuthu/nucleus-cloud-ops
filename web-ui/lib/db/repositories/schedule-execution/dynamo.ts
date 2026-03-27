/**
 * ScheduleExecutionDynamoRepository
 *
 * DynamoDB implementation of IScheduleExecutionRepository.
 * Logic extracted from the original ScheduleExecutionService static class.
 *
 * DynamoDB single-table access pattern:
 *   PK = TENANT#<tenantId>#SCHEDULE#<scheduleId>
 *   SK = EXEC#<timestamp>#<executionId>
 *   GSI1: gsi1pk = TYPE#EXECUTION (list all executions)
 *   GSI3: gsi3pk = STATUS#<status> (filter by status)
 */
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamoDBDocumentClient, APP_TABLE_NAME, DEFAULT_TENANT_ID } from '@/lib/aws-config';
import type { ScheduleExecution, UIScheduleExecution } from '@/lib/schedule-execution-service';
import type { IScheduleExecutionRepository } from './interface';

const buildExecutionPK = (tenantId: string, scheduleId: string) =>
    `TENANT#${tenantId}#SCHEDULE#${scheduleId}`;
const buildExecutionSK = (timestamp: string, executionId: string) =>
    `EXEC#${timestamp}#${executionId}`;

export class ScheduleExecutionDynamoRepository implements IScheduleExecutionRepository {
    async logExecution(
        execution: Omit<ScheduleExecution, 'executionId'>
    ): Promise<ScheduleExecution> {
        try {
            const dynamoDBDocumentClient = await getDynamoDBDocumentClient();
            const now = execution.executionTime || new Date().toISOString();
            const executionId = `exec-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

            // TTL: 90 days from now (for automatic cleanup)
            const ttl = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;

            const dbItem = {
                pk: buildExecutionPK(execution.tenantId, execution.scheduleId),
                sk: buildExecutionSK(now, executionId),
                gsi1pk: 'TYPE#EXECUTION',
                gsi1sk: `${now}#${executionId}`,
                gsi3pk: `STATUS#${execution.status}`,
                gsi3sk: `TENANT#${execution.tenantId}#EXEC#${executionId}`,
                type: 'execution',
                ttl,
                executionId,
                tenantId: execution.tenantId,
                accountId: execution.accountId,
                scheduleId: execution.scheduleId,
                executionTime: now,
                status: execution.status,
                resourcesStarted: execution.resourcesStarted || 0,
                resourcesStopped: execution.resourcesStopped || 0,
                resourcesFailed: execution.resourcesFailed || 0,
                duration: execution.duration,
                errorMessage: execution.errorMessage,
                details: execution.details,
                schedule_metadata: execution.schedule_metadata,
            };

            const command = new PutCommand({
                TableName: APP_TABLE_NAME,
                Item: dbItem,
            });

            await dynamoDBDocumentClient.send(command);
            console.log(
                `[ScheduleExecutionDynamoRepository] Logged execution ${executionId} for schedule ${execution.scheduleId}`
            );

            return {
                executionId,
                ...execution,
                executionTime: now,
            };
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[ScheduleExecutionDynamoRepository] Error logging execution:', error);
            throw new Error(`Failed to log execution: ${msg}`);
        }
    }

    async getExecutionHistory(
        scheduleId: string,
        tenantId: string = DEFAULT_TENANT_ID,
        limit: number = 50
    ): Promise<UIScheduleExecution[]> {
        try {
            const dynamoDBDocumentClient = await getDynamoDBDocumentClient();

            const command = new QueryCommand({
                TableName: APP_TABLE_NAME,
                KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
                ExpressionAttributeValues: {
                    ':pk': buildExecutionPK(tenantId, scheduleId),
                    ':skPrefix': 'EXEC#',
                },
                ScanIndexForward: false,
                Limit: limit,
            });

            const response = await dynamoDBDocumentClient.send(command);
            return (response.Items || []).map((item) =>
                this.transformToUIExecution(item as Record<string, unknown>)
            );
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error(
                '[ScheduleExecutionDynamoRepository] Error fetching execution history:',
                error
            );
            throw new Error(`Failed to get execution history: ${msg}`);
        }
    }

    async getRecentExecutions(
        tenantId: string = DEFAULT_TENANT_ID,
        limit: number = 100
    ): Promise<UIScheduleExecution[]> {
        try {
            const dynamoDBDocumentClient = await getDynamoDBDocumentClient();

            const command = new QueryCommand({
                TableName: APP_TABLE_NAME,
                IndexName: 'GSI1',
                KeyConditionExpression: 'gsi1pk = :pkVal',
                ExpressionAttributeValues: {
                    ':pkVal': 'TYPE#EXECUTION',
                },
                ScanIndexForward: false,
                Limit: limit,
            });

            const response = await dynamoDBDocumentClient.send(command);
            return (response.Items || []).map((item) =>
                this.transformToUIExecution(item as Record<string, unknown>)
            );
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error(
                '[ScheduleExecutionDynamoRepository] Error fetching recent executions:',
                error
            );
            throw new Error(`Failed to get recent executions: ${msg}`);
        }
    }

    private transformToUIExecution(item: Record<string, unknown>): UIScheduleExecution {
        const time = (item.executionTime as string) || (item.startTime as string);
        return {
            id: item.executionId as string,
            executionId: item.executionId as string,
            tenantId: item.tenantId as string,
            accountId: item.accountId as string,
            scheduleId: item.scheduleId as string,
            executionTime: time,
            status: item.status as ScheduleExecution['status'],
            resourcesStarted: item.resourcesStarted as number | undefined,
            resourcesStopped: item.resourcesStopped as number | undefined,
            resourcesFailed: item.resourcesFailed as number | undefined,
            duration: item.duration as number | undefined,
            errorMessage: item.errorMessage as string | undefined,
            details: item.details as Record<string, unknown> | undefined,
            schedule_metadata: item.schedule_metadata,
            startTime: time,
        };
    }
}
