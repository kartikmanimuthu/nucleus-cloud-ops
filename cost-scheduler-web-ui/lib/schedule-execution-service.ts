// DynamoDB service for schedule execution operations
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamoDBDocumentClient, APP_TABLE_NAME, handleDynamoDBError, DEFAULT_TENANT_ID } from './aws-config';

// Helper to build PK/SK for executions
const buildExecutionPK = (tenantId: string, scheduleId: string) => `TENANT#${tenantId}#SCHEDULE#${scheduleId}`;
const buildExecutionSK = (timestamp: string, executionId: string) => `EXEC#${timestamp}#${executionId}`;

export interface ScheduleExecution {
    executionId: string;
    tenantId: string;
    accountId: string;
    scheduleId: string;
    executionTime: string;
    status: 'pending' | 'running' | 'success' | 'failed' | 'partial';
    resourcesStarted?: number;
    resourcesStopped?: number;
    resourcesFailed?: number;
    duration?: number; // in seconds
    errorMessage?: string;
    details?: Record<string, any>;
    schedule_metadata?: any; // Add schedule_metadata for UI to display resource details
}

export interface UIScheduleExecution extends ScheduleExecution {
    id: string;
    startTime?: string; // For compatibility with backend naming
}

export class ScheduleExecutionService {
    /**
     * Log a schedule execution result
     * PK: TENANT#<tenantId>#SCHEDULE#<scheduleId>
     * SK: EXEC#<timestamp>#<executionId>
     */
    static async logExecution(execution: Omit<ScheduleExecution, 'executionId'>): Promise<ScheduleExecution> {
        try {
            const dynamoDBDocumentClient = await getDynamoDBDocumentClient();
            const now = execution.executionTime || new Date().toISOString();
            const executionId = `exec-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

            // TTL: 90 days from now (for automatic cleanup)
            const ttl = Math.floor(Date.now() / 1000) + (90 * 24 * 60 * 60);

            const dbItem = {
                // Primary Keys (hierarchical design)
                pk: buildExecutionPK(execution.tenantId, execution.scheduleId),
                sk: buildExecutionSK(now, executionId),

                // GSI1: TYPE#EXECUTION -> timestamp#executionId (list all executions)
                gsi1pk: 'TYPE#EXECUTION',
                gsi1sk: `${now}#${executionId}`,

                // GSI3: STATUS#<status> -> TENANT#...#EXEC#...
                gsi3pk: `STATUS#${execution.status}`,
                gsi3sk: `TENANT#${execution.tenantId}#EXEC#${executionId}`,

                // Entity type
                type: 'execution',

                // TTL for auto-cleanup
                ttl: ttl,

                // IDs
                executionId,
                tenantId: execution.tenantId,
                accountId: execution.accountId,
                scheduleId: execution.scheduleId,

                // Attributes
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
            console.log(`ScheduleExecutionService - Logged execution ${executionId} for schedule ${execution.scheduleId}`);

            return {
                executionId,
                ...execution,
                executionTime: now,
            };
        } catch (error: any) {
            console.error('ScheduleExecutionService - Error logging execution:', error);
            handleDynamoDBError(error, 'log execution');
            throw error;
        }
    }

    /**
     * Get executions for a specific schedule
     * Uses PK + SK begins_with
     */
    static async getExecutionsForSchedule(
        scheduleId: string,
        accountId: string, // Kept for interface compatibility but not used in PK anymore
        options?: {
            limit?: number;
            startDate?: string;
            endDate?: string;
        },
        tenantId: string = DEFAULT_TENANT_ID,

    ): Promise<UIScheduleExecution[]> {
        try {
            const dynamoDBDocumentClient = await getDynamoDBDocumentClient();

            let keyConditionExpression = 'pk = :pk AND begins_with(sk, :skPrefix)';
            const expressionAttributeValues: Record<string, any> = {
                ':pk': buildExecutionPK(tenantId, scheduleId),
                ':skPrefix': 'EXEC#',
            };

            // Add date range if provided
            if (options?.startDate && options?.endDate) {
                keyConditionExpression = 'pk = :pk AND sk BETWEEN :skStart AND :skEnd';
                expressionAttributeValues[':skPrefix'] = undefined; // Remove if not needed with BETWEEN
                expressionAttributeValues[':skStart'] = `EXEC#${options.startDate}`;
                expressionAttributeValues[':skEnd'] = `EXEC#${options.endDate}#~`;

                // If using BETWEEN, we don't need the begins_with part for the prefix unless we combine them (which is tricky in single SK)
                // Since our SK is EXEC#timestamp#executionId, BETWEEN works directly on this string.
                // We just need to make sure we don't include :skPrefix in the KeyConditionExpression logic if we swap to BETWEEN
            }

            // Refine key condition for date range
            if (options?.startDate && options?.endDate) {
                keyConditionExpression = 'pk = :pk AND sk BETWEEN :skStart AND :skEnd';
                delete expressionAttributeValues[':skPrefix'];
            }

            const command = new QueryCommand({
                TableName: APP_TABLE_NAME,
                KeyConditionExpression: keyConditionExpression,
                ExpressionAttributeValues: expressionAttributeValues,
                ScanIndexForward: false, // newest first
                Limit: options?.limit || 50,
            });

            const response = await dynamoDBDocumentClient.send(command);

            return (response.Items || []).map(item => this.transformToUIExecution(item));
        } catch (error: any) {
            console.error('ScheduleExecutionService - Error fetching executions:', error);
            handleDynamoDBError(error, 'get executions');
            return [];
        }
    }

    /**
     * Get a single execution by ID
     * Uses PK + SK prefix query and filters by executionId
     */
    static async getExecutionById(
        scheduleId: string,
        executionId: string,
        tenantId: string = DEFAULT_TENANT_ID,
    ): Promise<UIScheduleExecution | null> {
        try {
            const dynamoDBDocumentClient = await getDynamoDBDocumentClient();

            // Note: FilterExpression is applied AFTER Limit in DynamoDB, so we need 
            // to query more items and filter in application code, or not use Limit
            const command = new QueryCommand({
                TableName: APP_TABLE_NAME,
                KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
                FilterExpression: 'executionId = :execId',
                ExpressionAttributeValues: {
                    ':pk': buildExecutionPK(tenantId, scheduleId),
                    ':skPrefix': 'EXEC#',
                    ':execId': executionId,
                },
                // Don't use Limit with FilterExpression - it's applied before filtering
            });

            const response = await dynamoDBDocumentClient.send(command);

            if (response.Items && response.Items.length > 0) {
                return this.transformToUIExecution(response.Items[0]);
            }

            return null;
        } catch (error: any) {
            console.error('ScheduleExecutionService - Error fetching execution by ID:', error);
            handleDynamoDBError(error, 'get execution by ID');
            return null;
        }
    }

    /**
     * Get all recent executions (across all schedules)
     * Uses GSI1: TYPE#EXECUTION
     */
    static async getRecentExecutions(options?: {
        limit?: number;
        status?: string;
    }): Promise<UIScheduleExecution[]> {
        try {
            const dynamoDBDocumentClient = await getDynamoDBDocumentClient();

            const command = new QueryCommand({
                TableName: APP_TABLE_NAME,
                IndexName: 'GSI1',
                KeyConditionExpression: 'gsi1pk = :pkVal',
                ExpressionAttributeValues: {
                    ':pkVal': 'TYPE#EXECUTION',
                },
                ScanIndexForward: false, // newest first
                Limit: options?.limit || 100,
            });

            const response = await dynamoDBDocumentClient.send(command);
            let executions = (response.Items || []).map(item => this.transformToUIExecution(item));

            // In-memory filtering by status if provided
            if (options?.status) {
                executions = executions.filter(e => e.status === options.status);
            }

            return executions;
        } catch (error: any) {
            console.error('ScheduleExecutionService - Error fetching recent executions:', error);
            handleDynamoDBError(error, 'get recent executions');
            return [];
        }
    }

    /**
     * Transform DynamoDB item to UI execution format
     */
    private static transformToUIExecution(item: any): UIScheduleExecution {
        const time = item.executionTime || item.startTime;
        return {
            id: item.executionId,
            executionId: item.executionId,
            tenantId: item.tenantId,
            accountId: item.accountId,
            scheduleId: item.scheduleId,
            executionTime: time,
            status: item.status,
            resourcesStarted: item.resourcesStarted,
            resourcesStopped: item.resourcesStopped,
            resourcesFailed: item.resourcesFailed,
            duration: item.duration,
            errorMessage: item.errorMessage,
            details: item.details,
            schedule_metadata: item.schedule_metadata,
            startTime: time,
        };
    }
}
