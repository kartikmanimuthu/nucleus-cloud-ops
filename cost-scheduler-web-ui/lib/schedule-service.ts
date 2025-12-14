// DynamoDB service for schedule operations
import { ScanCommand, PutCommand, DeleteCommand, UpdateCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamoDBDocumentClient, APP_TABLE_NAME, handleDynamoDBError } from './aws-config';
import { Schedule, UISchedule } from './types';
import { AuditService } from './audit-service';

export class ScheduleService {
    /**
     * Fetch all schedules from DynamoDB with optional filters
     */
    static async getSchedules(filters?: {
        statusFilter?: string;
        resourceFilter?: string;
        searchTerm?: string;
    }): Promise<UISchedule[]> {
        try {
            console.log('ScheduleService - Attempting to fetch schedules from DynamoDB with filters:', filters);

            const dynamoDBDocumentClient = await getDynamoDBDocumentClient();

            // Use Query on GSI1 for efficient access
            const params = {
                TableName: APP_TABLE_NAME,
                IndexName: 'GSI1',
                KeyConditionExpression: 'gsi1pk = :typeVal',
                ExpressionAttributeValues: {
                    ':typeVal': 'TYPE#SCHEDULE'
                }
            };

            console.log('ScheduleService - Sending DynamoDB Query command to GSI1...');
            const response = await dynamoDBDocumentClient.send(new QueryCommand(params));
            console.log('ScheduleService - Successfully fetched schedules:', response.Items?.length || 0);

            let schedules = (response.Items || []).map(item => this.transformToUISchedule(item as any));

            // In-memory filtering (since GSI Query handles the bulk of retrieval)
            if (filters?.statusFilter) {
                if (filters.statusFilter === 'active') {
                    schedules = schedules.filter(s => s.active === true);
                } else if (filters.statusFilter === 'inactive') {
                    schedules = schedules.filter(s => s.active === false);
                }
            }

            if (filters?.searchTerm) {
                const searchLower = filters.searchTerm.toLowerCase();
                schedules = schedules.filter(schedule =>
                    schedule.name.toLowerCase().includes(searchLower) ||
                    (schedule.description && schedule.description.toLowerCase().includes(searchLower)) ||
                    (schedule.createdBy && schedule.createdBy.toLowerCase().includes(searchLower))
                );
            }

            if (filters?.resourceFilter && filters.resourceFilter !== 'all') {
                schedules = schedules.filter(schedule =>
                    schedule.resourceTypes && schedule.resourceTypes.includes(filters.resourceFilter!)
                );
            }

            return schedules;
        } catch (error: any) {
            console.error('ScheduleService - Error fetching schedules:', error);
            handleDynamoDBError(error, 'getSchedules');
            return [];
        }
    }

    /**
     * Fetch schedules with filtering support (Legacy helper)
     */
    static async getSchedulesWithFilters(active?: boolean, searchTerm?: string): Promise<UISchedule[]> {
        // Reuse general getSchedules logic for consistency
        const statusFilter = active === undefined ? undefined : (active ? 'active' : 'inactive');
        return this.getSchedules({ statusFilter, searchTerm });
    }

    /**
     * Get a specific schedule by name
     */
    static async getSchedule(name: string): Promise<UISchedule | null> {
        try {
            const dynamoDBDocumentClient = await getDynamoDBDocumentClient();
            const command = new GetCommand({
                TableName: APP_TABLE_NAME,
                Key: {
                    pk: `SCHEDULE#${name}`,
                    sk: 'METADATA',
                },
            });

            const response = await dynamoDBDocumentClient.send(command);
            return response.Item ? this.transformToUISchedule(response.Item as any) : null;
        } catch (error: any) {
            handleDynamoDBError(error, 'getSchedule');
            return null;
        }
    }

    /**
     * Create a new schedule
     */
    static async createSchedule(schedule: Omit<Schedule, 'id'>): Promise<Schedule> {
        try {
            const dynamoDBDocumentClient = await getDynamoDBDocumentClient();
            const now = new Date().toISOString();

            const dbSchedule = {
                pk: `SCHEDULE#${schedule.name}`,
                sk: 'METADATA',
                gsi1pk: 'TYPE#SCHEDULE',
                gsi1sk: schedule.name,

                ...schedule,
                createdAt: now,
                updatedAt: now,
            };

            const command = new PutCommand({
                TableName: APP_TABLE_NAME,
                Item: dbSchedule,
                ConditionExpression: 'attribute_not_exists(pk)',
            });

            await dynamoDBDocumentClient.send(command);

            // Log audit event
            await AuditService.logUserAction({
                action: 'Create Schedule',
                resourceType: 'schedule',
                resourceId: schedule.name,
                resourceName: schedule.name,
                user: 'system',
                userType: 'user',
                status: 'success',
                details: `Created schedule "${schedule.name}" with ${schedule.days.join(', ')} from ${schedule.starttime} to ${schedule.endtime}`,
                metadata: {
                    scheduleName: schedule.name,
                    active: schedule.active,
                },
            });

            return dbSchedule as any;
        } catch (error) {
            console.error('Error creating schedule:', error);
            await AuditService.logUserAction({
                action: 'Create Schedule',
                resourceType: 'schedule',
                resourceId: schedule.name,
                resourceName: schedule.name,
                user: 'system',
                userType: 'user',
                status: 'error',
                details: `Failed to create schedule "${schedule.name}": ${(error as any).message}`,
            });

            handleDynamoDBError(error, 'create schedule');
            throw error;
        }
    }

    /**
     * Update an existing schedule
     */
    static async updateSchedule(scheduleName: string, updates: Partial<Omit<Schedule, 'name'>>): Promise<UISchedule> {
        try {
            const currentSchedule = await this.getSchedule(scheduleName);
            if (!currentSchedule) {
                throw new Error('Schedule not found');
            }

            const updateExpressions: string[] = [];
            const expressionAttributeNames: Record<string, string> = {};
            const expressionAttributeValues: Record<string, any> = {};

            const excludedFields = ['name', 'type', 'pk', 'sk', 'gsi1pk', 'gsi1sk'];

            Object.entries(updates).forEach(([key, value]) => {
                if (value !== undefined && !excludedFields.includes(key)) {
                    updateExpressions.push(`#${key} = :${key}`);
                    expressionAttributeNames[`#${key}`] = key;
                    expressionAttributeValues[`:${key}`] = value;
                }
            });

            // Always update updatedAt
            updateExpressions.push('#updatedAt = :updatedAt');
            expressionAttributeNames['#updatedAt'] = 'updatedAt';
            expressionAttributeValues[':updatedAt'] = new Date().toISOString();

            const command = new UpdateCommand({
                TableName: APP_TABLE_NAME,
                Key: {
                    pk: `SCHEDULE#${scheduleName}`,
                    sk: 'METADATA',
                },
                UpdateExpression: `SET ${updateExpressions.join(', ')}`,
                ExpressionAttributeNames: expressionAttributeNames,
                ExpressionAttributeValues: expressionAttributeValues,
                ReturnValues: 'ALL_NEW',
            });

            const dynamoDBDocumentClient = await getDynamoDBDocumentClient();
            const response = await dynamoDBDocumentClient.send(command);
            const updatedSchedule = this.transformToUISchedule(response.Attributes as any);

            await AuditService.logUserAction({
                action: 'Update Schedule',
                resourceType: 'schedule',
                resourceId: scheduleName,
                resourceName: scheduleName,
                user: 'system',
                userType: 'user',
                status: 'success',
                details: `Updated schedule "${scheduleName}"`,
            });

            return updatedSchedule;
        } catch (error) {
            console.error('Error updating schedule:', error);
            handleDynamoDBError(error, 'update schedule');
            throw error;
        }
    }

    /**
     * Delete a schedule
     */
    static async deleteSchedule(name: string): Promise<void> {
        try {
            const dynamoDBDocumentClient = await getDynamoDBDocumentClient();
            const command = new DeleteCommand({
                TableName: APP_TABLE_NAME,
                Key: {
                    pk: `SCHEDULE#${name}`,
                    sk: 'METADATA',
                },
            });

            await dynamoDBDocumentClient.send(command);

            await AuditService.logUserAction({
                action: 'Delete Schedule',
                resourceType: 'schedule',
                resourceId: name,
                resourceName: name,
                user: 'system',
                userType: 'user',
                status: 'success',
                details: `Deleted schedule "${name}"`,
            });
        } catch (error: any) {
            handleDynamoDBError(error, 'deleteSchedule');
        }
    }

    /**
     * Toggle schedule active status
     */
    static async toggleScheduleStatus(name: string): Promise<UISchedule> {
        try {
            const currentSchedule = await this.getSchedule(name);
            if (!currentSchedule) {
                throw new Error('Schedule not found');
            }

            return await this.updateSchedule(name, { active: !currentSchedule.active });
        } catch (error: any) {
            throw error;
        }
    }

    /**
     * Transform DynamoDB item to UI schedule format
     */
    private static transformToUISchedule(item: any): UISchedule {
        // item might have PK/SK, strip them for UI if needed, or map fields
        return {
            id: item.name || item.pk?.replace('SCHEDULE#', ''),
            name: item.name,
            starttime: item.starttime,
            endtime: item.endtime,
            timezone: item.timezone,
            active: item.active,
            days: item.days,
            accounts: item.accountId ? [item.accountId] : (item.accounts || []),
            resourceTypes: item.resourceTypes || ['EC2', 'RDS', 'ECS'],
            description: item.description || '',
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            createdBy: item.createdBy,
            updatedBy: item.updatedBy,
            resources: item.resources, // Pass through selected resources
            lastExecution: item.lastExecution,
            nextExecution: item.nextExecution,
            executionCount: item.executionCount || 0,
            successRate: item.successRate || 100,
            estimatedSavings: item.estimatedSavings || 0,
        };
    }
}
