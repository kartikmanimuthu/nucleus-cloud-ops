/**
 * ScheduleDynamoRepository
 *
 * DynamoDB implementation of IScheduleRepository.
 * Logic extracted from the original ScheduleService static class.
 *
 * DynamoDB single-table access pattern:
 *   PK = TENANT#<tenantId>#ACCOUNT#<accountId>
 *   SK = SCHEDULE#<scheduleId>
 *   GSI1: gsi1pk = TYPE#SCHEDULE (list all schedules)
 *   GSI2: gsi2pk = ACCOUNT#<accountId> (schedules per account)
 *   GSI3: gsi3pk = STATUS#active|inactive (filter by status)
 *
 * Note: getSchedules preserves the existing GSI1 query + client-side filter pattern
 * to maintain identical DynamoDB path behaviour.
 * Audit logging is NOT included — that belongs in the service layer.
 */
import {
    ScanCommand,
    PutCommand,
    DeleteCommand,
    UpdateCommand,
    GetCommand,
    QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { getDynamoDBDocumentClient, APP_TABLE_NAME, DEFAULT_TENANT_ID } from '@/lib/aws-config';
import type { UISchedule } from '@/lib/types';
import type { IScheduleRepository, ScheduleFilters, SchedulePage } from './interface';

const buildSchedulePK = (tenantId: string, accountId: string) =>
    `TENANT#${tenantId}#ACCOUNT#${accountId}`;
const buildScheduleSK = (scheduleId: string) => `SCHEDULE#${scheduleId}`;

export class ScheduleDynamoRepository implements IScheduleRepository {
    async getSchedules(filters: ScheduleFilters): Promise<SchedulePage> {
        try {
            const {
                tenantId,
                searchTerm,
                statusFilter,
                resourceFilter,
                accountId,
                page = 1,
                limit = 20,
            } = filters;

            console.log('[ScheduleDynamoRepository] Fetching schedules from DynamoDB', filters);

            const dynamoDBDocumentClient = await getDynamoDBDocumentClient();

            const params = {
                TableName: APP_TABLE_NAME,
                IndexName: 'GSI1',
                KeyConditionExpression: 'gsi1pk = :typeVal',
                ExpressionAttributeValues: {
                    ':typeVal': 'TYPE#SCHEDULE',
                },
            };

            const response = await dynamoDBDocumentClient.send(new QueryCommand(params));
            let schedules = (response.Items || []).map((item) =>
                this.transformToUISchedule(item as Record<string, unknown>)
            );

            // In-memory filtering (preserving original ScheduleService behaviour)
            if (statusFilter) {
                if (statusFilter === 'active') {
                    schedules = schedules.filter((s) => s.active === true);
                } else if (statusFilter === 'inactive') {
                    schedules = schedules.filter((s) => s.active === false);
                }
            }

            if (searchTerm) {
                const searchLower = searchTerm.toLowerCase();
                schedules = schedules.filter(
                    (schedule) =>
                        schedule.name.toLowerCase().includes(searchLower) ||
                        (schedule.description &&
                            schedule.description.toLowerCase().includes(searchLower)) ||
                        (schedule.createdBy &&
                            schedule.createdBy.toLowerCase().includes(searchLower))
                );
            }

            if (resourceFilter && resourceFilter !== 'all') {
                schedules = schedules.filter(
                    (schedule) =>
                        schedule.resourceTypes && schedule.resourceTypes.includes(resourceFilter)
                );
            }

            if (accountId) {
                schedules = schedules.filter(
                    (schedule) => schedule.accounts && schedule.accounts.includes(accountId)
                );
            }

            const total = schedules.length;

            if (page && limit) {
                const startIndex = (page - 1) * limit;
                const endIndex = startIndex + limit;
                schedules = schedules.slice(startIndex, endIndex);
            }

            return { schedules, total };
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[ScheduleDynamoRepository] Error fetching schedules:', error);
            throw new Error(`Failed to get schedules: ${msg}`);
        }
    }

    async getSchedule(
        idOrName: string,
        accountId?: string,
        tenantId: string = DEFAULT_TENANT_ID
    ): Promise<UISchedule | null> {
        try {
            const dynamoDBDocumentClient = await getDynamoDBDocumentClient();
            const isUUID = idOrName.startsWith('sched-');

            // Strategy 1: Direct GetItem if accountId is provided and it's a UUID
            if (accountId && isUUID) {
                const command = new GetCommand({
                    TableName: APP_TABLE_NAME,
                    Key: {
                        pk: buildSchedulePK(tenantId, accountId),
                        sk: buildScheduleSK(idOrName),
                    },
                });
                const response = await dynamoDBDocumentClient.send(command);
                if (response.Item)
                    return this.transformToUISchedule(response.Item as Record<string, unknown>);
            }

            // Strategy 2: GSI3 lookup if UUID but no accountId
            if (isUUID) {
                const checkStatus = async (status: string) => {
                    const command = new QueryCommand({
                        TableName: APP_TABLE_NAME,
                        IndexName: 'GSI3',
                        KeyConditionExpression: 'gsi3pk = :gsi3pk AND gsi3sk = :gsi3sk',
                        ExpressionAttributeValues: {
                            ':gsi3pk': `STATUS#${status}`,
                            ':gsi3sk': `TENANT#${tenantId}#SCHEDULE#${idOrName}`,
                        },
                    });
                    const response = await dynamoDBDocumentClient.send(command);
                    return response.Items?.[0];
                };

                const [activeItem, inactiveItem] = await Promise.all([
                    checkStatus('active'),
                    checkStatus('inactive'),
                ]);

                const item = activeItem || inactiveItem;
                if (item)
                    return this.transformToUISchedule(item as Record<string, unknown>);

                if (accountId) return null;
            }

            // Strategy 3: Lookup by Name via GSI1
            const command = new QueryCommand({
                TableName: APP_TABLE_NAME,
                IndexName: 'GSI1',
                KeyConditionExpression: 'gsi1pk = :pkVal AND gsi1sk = :skVal',
                ExpressionAttributeValues: {
                    ':pkVal': 'TYPE#SCHEDULE',
                    ':skVal': idOrName,
                },
            });

            const response = await dynamoDBDocumentClient.send(command);
            if (response.Items && response.Items.length > 0) {
                return this.transformToUISchedule(response.Items[0] as Record<string, unknown>);
            }

            return null;
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[ScheduleDynamoRepository] Error fetching schedule:', error);
            throw new Error(`Failed to get schedule: ${msg}`);
        }
    }

    async createSchedule(
        schedule: Omit<UISchedule, 'id'>,
        tenantId: string = DEFAULT_TENANT_ID
    ): Promise<UISchedule> {
        try {
            const dynamoDBDocumentClient = await getDynamoDBDocumentClient();
            const now = new Date().toISOString();
            const statusText = schedule.active ? 'active' : 'inactive';

            const accountId = schedule.accounts?.[0];
            if (!accountId) {
                throw new Error('accountId is required to create a schedule in multi-tenant design');
            }

            const scheduleId = `sched-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

            const dbSchedule = {
                pk: buildSchedulePK(tenantId, accountId),
                sk: buildScheduleSK(scheduleId),
                gsi1pk: 'TYPE#SCHEDULE',
                gsi1sk: schedule.name,
                gsi2pk: `ACCOUNT#${accountId}`,
                gsi2sk: `SCHEDULE#${scheduleId}`,
                gsi3pk: `STATUS#${statusText}`,
                gsi3sk: `TENANT#${tenantId}#SCHEDULE#${scheduleId}`,
                type: 'schedule',
                tenantId,
                accountId,
                scheduleId,
                name: schedule.name,
                days: schedule.days,
                starttime: schedule.starttime,
                endtime: schedule.endtime,
                timezone: schedule.timezone,
                active: schedule.active,
                resources: schedule.resources,
                description: schedule.description,
                createdAt: now,
                updatedAt: now,
                createdBy: schedule.createdBy || 'system',
                updatedBy: schedule.updatedBy || 'system',
            };

            const command = new PutCommand({
                TableName: APP_TABLE_NAME,
                Item: dbSchedule,
                ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
            });

            await dynamoDBDocumentClient.send(command);
            return this.transformToUISchedule(dbSchedule as Record<string, unknown>);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[ScheduleDynamoRepository] Error creating schedule:', error);
            throw new Error(`Failed to create schedule: ${msg}`);
        }
    }

    async updateSchedule(
        scheduleId: string,
        updates: Partial<UISchedule>,
        tenantId: string = DEFAULT_TENANT_ID,
        accountId?: string
    ): Promise<UISchedule> {
        try {
            const currentSchedule = await this.getSchedule(scheduleId, accountId, tenantId);
            if (!currentSchedule) {
                throw new Error('Schedule not found');
            }

            const effectiveAccountId = accountId || currentSchedule.accounts?.[0];
            if (!effectiveAccountId) {
                throw new Error('accountId is required to update a schedule');
            }

            const skValue = currentSchedule.id.startsWith('sched-')
                ? currentSchedule.id
                : currentSchedule.name;

            const updateExpressions: string[] = [];
            const expressionAttributeNames: Record<string, string> = {};
            const expressionAttributeValues: Record<string, unknown> = {};

            const excludedFields = [
                'name',
                'type',
                'pk',
                'sk',
                'gsi1pk',
                'gsi1sk',
                'gsi2pk',
                'gsi2sk',
                'gsi3pk',
                'gsi3sk',
                'tenantId',
                'accountId',
                'scheduleId',
                'id',
                'accounts',
                'resourceTypes',
            ];

            Object.entries(updates).forEach(([key, value]) => {
                if (value !== undefined && !excludedFields.includes(key)) {
                    updateExpressions.push(`#${key} = :${key}`);
                    expressionAttributeNames[`#${key}`] = key;
                    expressionAttributeValues[`:${key}`] = value;
                }
            });

            if (updates.active !== undefined) {
                const statusText = updates.active ? 'active' : 'inactive';
                updateExpressions.push('#gsi3pk = :gsi3pk');
                expressionAttributeNames['#gsi3pk'] = 'gsi3pk';
                expressionAttributeValues[':gsi3pk'] = `STATUS#${statusText}`;
            }

            updateExpressions.push('#updatedAt = :updatedAt');
            expressionAttributeNames['#updatedAt'] = 'updatedAt';
            expressionAttributeValues[':updatedAt'] = new Date().toISOString();

            const command = new UpdateCommand({
                TableName: APP_TABLE_NAME,
                Key: {
                    pk: buildSchedulePK(tenantId, effectiveAccountId),
                    sk: buildScheduleSK(skValue),
                },
                UpdateExpression: `SET ${updateExpressions.join(', ')}`,
                ExpressionAttributeNames: expressionAttributeNames,
                ExpressionAttributeValues: expressionAttributeValues,
                ReturnValues: 'ALL_NEW',
            });

            const dynamoDBDocumentClient = await getDynamoDBDocumentClient();
            const response = await dynamoDBDocumentClient.send(command);
            return this.transformToUISchedule(response.Attributes as Record<string, unknown>);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[ScheduleDynamoRepository] Error updating schedule:', error);
            throw new Error(`Failed to update schedule: ${msg}`);
        }
    }

    async deleteSchedule(
        scheduleId: string,
        tenantId: string = DEFAULT_TENANT_ID,
        accountId?: string
    ): Promise<void> {
        try {
            const dynamoDBDocumentClient = await getDynamoDBDocumentClient();

            const schedule = await this.getSchedule(scheduleId, accountId, tenantId);
            if (!schedule) return;

            const effectiveAccountId = accountId || schedule.accounts?.[0];
            if (!effectiveAccountId) {
                throw new Error('Could not determine accountId for schedule deletion');
            }

            const skValue = schedule.id.startsWith('sched-') ? schedule.id : schedule.name;

            const command = new DeleteCommand({
                TableName: APP_TABLE_NAME,
                Key: {
                    pk: buildSchedulePK(tenantId, effectiveAccountId),
                    sk: buildScheduleSK(skValue),
                },
            });

            await dynamoDBDocumentClient.send(command);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[ScheduleDynamoRepository] Error deleting schedule:', error);
            throw new Error(`Failed to delete schedule: ${msg}`);
        }
    }

    private transformToUISchedule(item: Record<string, unknown>): UISchedule {
        const id =
            (item.scheduleId as string) ||
            ((item.sk as string | undefined)?.replace('SCHEDULE#', '')) ||
            (item.name as string);

        return {
            id,
            name: item.name as string,
            starttime: item.starttime as string,
            endtime: item.endtime as string,
            timezone: item.timezone as string,
            active: item.active as boolean,
            days: (item.days as string[]) || [],
            accounts: (item.accountId as string)
                ? [item.accountId as string]
                : ((item.accounts as string[]) || []),
            resourceTypes:
                (item.resourceTypes as string[]) ||
                ((item.resources as Array<{ type: string }> | undefined)?.map((r) => r.type) || [
                    'EC2',
                    'RDS',
                    'ECS',
                ]),
            description: (item.description as string) || '',
            createdAt: item.createdAt as string | undefined,
            updatedAt: item.updatedAt as string | undefined,
            createdBy: item.createdBy as string | undefined,
            updatedBy: item.updatedBy as string | undefined,
            resources: item.resources as UISchedule['resources'],
            lastExecution: item.lastExecution as string | undefined,
            nextExecution: item.nextExecution as string | undefined,
            executionCount: (item.executionCount as number) || 0,
            successRate: (item.successRate as number) || 100,
            estimatedSavings: (item.estimatedSavings as number) || 0,
        };
    }
}
