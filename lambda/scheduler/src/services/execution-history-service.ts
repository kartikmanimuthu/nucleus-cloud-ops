// Execution History Service
// Records schedule executions to the app table with 30-day TTL
// Includes schedule_metadata for per-resource execution details

import {
    PutCommand,
    QueryCommand,
    UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { getDynamoDBClient, APP_TABLE_NAME } from './dynamodb-service.js';
import { logger } from '../utils/logger.js';
import { calculateTTL } from '../utils/time-utils.js';
import { v4 as uuidv4 } from 'uuid';
import type {
    ExecutionRecord,
    ExecutionStatus,
    ScheduleExecutionMetadata,
} from '../types/index.js';

// TTL in days for execution history
const EXECUTION_TTL_DAYS = 30;

// DynamoDB key builders
const buildExecutionPK = (tenantId: string, scheduleId: string) =>
    `TENANT#${tenantId}#SCHEDULE#${scheduleId}`;

const buildExecutionSK = (timestamp: string, executionId: string) =>
    `EXEC#${timestamp}#${executionId}`;

export interface CreateExecutionParams {
    scheduleId: string;
    scheduleName: string;
    tenantId?: string;
    accountId?: string;
    triggeredBy: 'system' | 'web-ui';
}

export interface UpdateExecutionParams {
    status: ExecutionStatus;
    resourcesStarted?: number;
    resourcesStopped?: number;
    resourcesFailed?: number;
    errorMessage?: string;
    details?: Record<string, unknown>;
    schedule_metadata?: ScheduleExecutionMetadata;
}

/**
 * Create a new execution record when a schedule starts processing
 */
export async function createExecutionRecord(params: CreateExecutionParams): Promise<ExecutionRecord> {
    const client = getDynamoDBClient();
    const executionId = uuidv4();
    const startTime = new Date().toISOString();
    const tenantId = params.tenantId || 'default';
    const accountId = params.accountId || 'unknown';

    const record: ExecutionRecord = {
        executionId,
        scheduleId: params.scheduleId,
        scheduleName: params.scheduleName,
        tenantId,
        accountId,
        status: 'running',
        triggeredBy: params.triggeredBy,
        startTime,
        resourcesStarted: 0,
        resourcesStopped: 0,
        resourcesFailed: 0,
        ttl: calculateTTL(EXECUTION_TTL_DAYS),
    };

    const item = {
        pk: buildExecutionPK(tenantId, params.scheduleId),
        sk: buildExecutionSK(startTime, executionId),
        gsi1pk: 'TYPE#EXECUTION',
        gsi1sk: `${startTime}#${executionId}`,
        type: 'execution',
        ...record,
    };

    try {
        await client.send(new PutCommand({
            TableName: APP_TABLE_NAME,
            Item: item,
        }));
        logger.info(`Execution record created: ${executionId}`, {
            scheduleId: params.scheduleId,
            executionId
        });
        return record;
    } catch (error) {
        logger.error('Failed to create execution record', error);
        throw error;
    }
}

/**
 * Update an execution record when processing completes
 */
export async function updateExecutionRecord(
    record: ExecutionRecord,
    updates: UpdateExecutionParams
): Promise<void> {
    const client = getDynamoDBClient();
    const endTime = new Date().toISOString();
    const duration = new Date(endTime).getTime() - new Date(record.startTime).getTime();

    const updateExpressions: string[] = [
        'set #status = :status',
        'endTime = :endTime',
        '#duration = :duration',
    ];
    const expressionAttributeNames: Record<string, string> = {
        '#status': 'status',
        '#duration': 'duration',
    };
    const expressionAttributeValues: Record<string, unknown> = {
        ':status': updates.status,
        ':endTime': endTime,
        ':duration': duration,
    };

    if (updates.resourcesStarted !== undefined) {
        updateExpressions.push('resourcesStarted = :resourcesStarted');
        expressionAttributeValues[':resourcesStarted'] = updates.resourcesStarted;
    }
    if (updates.resourcesStopped !== undefined) {
        updateExpressions.push('resourcesStopped = :resourcesStopped');
        expressionAttributeValues[':resourcesStopped'] = updates.resourcesStopped;
    }
    if (updates.resourcesFailed !== undefined) {
        updateExpressions.push('resourcesFailed = :resourcesFailed');
        expressionAttributeValues[':resourcesFailed'] = updates.resourcesFailed;
    }
    if (updates.errorMessage) {
        updateExpressions.push('errorMessage = :errorMessage');
        expressionAttributeValues[':errorMessage'] = updates.errorMessage;
    }
    if (updates.details) {
        updateExpressions.push('details = :details');
        expressionAttributeValues[':details'] = updates.details;
    }
    if (updates.schedule_metadata) {
        updateExpressions.push('schedule_metadata = :schedule_metadata');
        expressionAttributeValues[':schedule_metadata'] = updates.schedule_metadata;
    }

    try {
        await client.send(new UpdateCommand({
            TableName: APP_TABLE_NAME,
            Key: {
                pk: buildExecutionPK(record.tenantId, record.scheduleId),
                sk: buildExecutionSK(record.startTime, record.executionId),
            },
            UpdateExpression: updateExpressions.join(', '),
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues,
        }));
        logger.info(`Execution record updated: ${record.executionId}`, {
            status: updates.status,
            duration
        });
    } catch (error) {
        logger.error('Failed to update execution record', error);
        throw error;
    }
}

/**
 * Get execution history for a specific schedule
 */
export async function getExecutionHistory(
    scheduleId: string,
    tenantId = 'default',
    limit = 50
): Promise<ExecutionRecord[]> {
    const client = getDynamoDBClient();

    try {
        const response = await client.send(new QueryCommand({
            TableName: APP_TABLE_NAME,
            KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
            ExpressionAttributeValues: {
                ':pk': buildExecutionPK(tenantId, scheduleId),
                ':skPrefix': 'EXEC#',
            },
            ScanIndexForward: false, // newest first
            Limit: limit,
        }));

        return (response.Items || []) as ExecutionRecord[];
    } catch (error) {
        logger.error('Failed to fetch execution history', error, { scheduleId });
        return [];
    }
}

/**
 * Get recent executions across all schedules
 */
export async function getRecentExecutions(limit = 100): Promise<ExecutionRecord[]> {
    const client = getDynamoDBClient();

    try {
        const response = await client.send(new QueryCommand({
            TableName: APP_TABLE_NAME,
            IndexName: 'GSI1',
            KeyConditionExpression: 'gsi1pk = :pkVal',
            ExpressionAttributeValues: {
                ':pkVal': 'TYPE#EXECUTION',
            },
            ScanIndexForward: false, // newest first
            Limit: limit,
        }));

        return (response.Items || []) as ExecutionRecord[];
    } catch (error) {
        logger.error('Failed to fetch recent executions', error);
        return [];
    }
}

/**
 * Get the last saved ECS service state from previous execution history
 * Used to restore ECS services to their previous desiredCount when starting
 * 
 * @param scheduleId - The schedule ID to search history for
 * @param serviceArn - The ECS service ARN to find state for
 * @param tenantId - Tenant ID (default: 'default')
 * @returns The last desiredCount, or null if not found
 */
export async function getLastECSServiceState(
    scheduleId: string,
    serviceArn: string,
    tenantId = 'default'
): Promise<{ desiredCount: number } | null> {
    try {
        // Get recent execution history for this schedule
        const executions = await getExecutionHistory(scheduleId, tenantId, 10);

        // Look through executions to find the last time this ECS service was stopped
        for (const execution of executions) {
            if (execution.schedule_metadata?.ecs) {
                const ecsResource = execution.schedule_metadata.ecs.find(
                    (e) => e.arn === serviceArn && e.action === 'stop' && e.status === 'success'
                );
                if (ecsResource && ecsResource.last_state.desiredCount > 0) {
                    logger.debug(`Found last ECS state for ${serviceArn}: desiredCount=${ecsResource.last_state.desiredCount}`);
                    return { desiredCount: ecsResource.last_state.desiredCount };
                }
            }
        }

        logger.debug(`No previous ECS state found for ${serviceArn}`);
        return null;
    } catch (error) {
        logger.error(`Failed to get last ECS service state for ${serviceArn}`, error);
        return null;
    }
}
