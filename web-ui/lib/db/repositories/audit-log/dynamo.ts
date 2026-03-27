/**
 * AuditLogDynamoRepository
 *
 * DynamoDB implementation of IAuditLogRepository.
 * Logic extracted from the original AuditService static class.
 *
 * DynamoDB audit table access pattern:
 *   PK = LOG#<logId>
 *   SK = timestamp
 *   GSI1: gsi1pk = TYPE#LOG (global time-based listing)
 *   GSI2: gsi2pk = USER#<user> (filter by user)
 *   GSI3: gsi3pk = EVENT#<eventType> (filter by event type)
 *
 * Note: createAuditLog is fire-and-forget — errors are swallowed.
 * Note: The audit table does NOT filter by tenantId (DynamoDB path preserves original behaviour).
 */
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamoDBDocumentClient, AUDIT_TABLE_NAME } from '@/lib/aws-config';
import type { AuditLog } from '@/lib/types';
import type { AuditLogFilters, AuditLogResponse } from '@/lib/audit-service';
import type { IAuditLogRepository } from './interface';

export class AuditLogDynamoRepository implements IAuditLogRepository {
    /**
     * Fire-and-forget: errors are swallowed to prevent disrupting the main flow.
     */
    async createAuditLog(
        auditData: Omit<AuditLog, 'id' | 'type' | 'timestamp'>
    ): Promise<void> {
        try {
            if (
                process.env.NODE_ENV === 'development' &&
                process.env.SKIP_AUDIT_LOGGING === 'true'
            ) {
                return;
            }

            const cleanedData = this.validateAndCleanAuditData(auditData);
            const auditId = this.generateAuditId();
            const timestamp = new Date().toISOString();

            // TTL: 30 days from now
            const expireAt = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

            const user = cleanedData.user || 'system';
            const eventType = cleanedData.eventType || 'unknown';

            const auditLogItem = {
                pk: `LOG#${auditId}`,
                sk: timestamp,
                gsi1pk: 'TYPE#LOG',
                gsi1sk: timestamp,
                gsi2pk: `USER#${user}`,
                gsi2sk: timestamp,
                gsi3pk: `EVENT#${eventType}`,
                gsi3sk: timestamp,
                expire_at: expireAt,
                id: auditId,
                timestamp,
                ...cleanedData,
            };

            const command = new PutCommand({
                TableName: AUDIT_TABLE_NAME,
                Item: auditLogItem,
            });

            await getDynamoDBDocumentClient().send(command);
            console.log('[AuditLogDynamoRepository] Created audit log:', auditId);
        } catch (error: unknown) {
            console.error('[AuditLogDynamoRepository] Error creating audit log:', error);
            // Fire-and-forget: swallow error
        }
    }

    async getAuditLogs(
        _tenantId: string,
        filters?: AuditLogFilters
    ): Promise<AuditLogResponse> {
        try {
            console.log('[AuditLogDynamoRepository] Fetching audit logs with filters:', filters);

            const limit = filters?.limit || 20;
            const startKey = filters?.nextPageToken
                ? JSON.parse(Buffer.from(filters.nextPageToken, 'base64').toString('utf-8'))
                : undefined;

            // Build FilterExpression for non-key attributes
            const filterExpressions: string[] = [];
            const expressionAttributeValues: Record<string, unknown> = {};
            const expressionAttributeNames: Record<string, string> = {};

            if (filters) {
                if (filters.status && filters.status !== 'all') {
                    filterExpressions.push('#status = :status');
                    expressionAttributeNames['#status'] = 'status';
                    expressionAttributeValues[':status'] = filters.status;
                }
                if (filters.severity && filters.severity !== 'all') {
                    filterExpressions.push('#severity = :severity');
                    expressionAttributeNames['#severity'] = 'severity';
                    expressionAttributeValues[':severity'] = filters.severity;
                }
                if (filters.userType && filters.userType !== 'all') {
                    filterExpressions.push('userType = :userType');
                    expressionAttributeValues[':userType'] = filters.userType;
                }
                if (filters.resourceType) {
                    filterExpressions.push('#resourceType = :resourceType');
                    expressionAttributeNames['#resourceType'] = 'resourceType';
                    expressionAttributeValues[':resourceType'] = filters.resourceType;
                }
                if (filters.correlationId) {
                    filterExpressions.push('correlationId = :correlationId');
                    expressionAttributeValues[':correlationId'] = filters.correlationId;
                }
                if (filters.executionId) {
                    filterExpressions.push('executionId = :executionId');
                    expressionAttributeValues[':executionId'] = filters.executionId;
                }
                if (filters.resourceId) {
                    filterExpressions.push('resourceId = :resourceId');
                    expressionAttributeValues[':resourceId'] = filters.resourceId;
                }
                if (filters.ipAddress) {
                    filterExpressions.push('ipAddress = :ipAddress');
                    expressionAttributeValues[':ipAddress'] = filters.ipAddress;
                }
                if (filters.source && filters.source !== 'all') {
                    filterExpressions.push('#source = :source');
                    expressionAttributeNames['#source'] = 'source';
                    expressionAttributeValues[':source'] = filters.source;
                }
            }

            const baseQueryConfig = {
                TableName: AUDIT_TABLE_NAME,
                ScanIndexForward: false,
                Limit: limit,
                ExclusiveStartKey: startKey,
                FilterExpression:
                    filterExpressions.length > 0 ? filterExpressions.join(' AND ') : undefined,
                ExpressionAttributeValues:
                    Object.keys(expressionAttributeValues).length > 0
                        ? expressionAttributeValues
                        : undefined,
                ExpressionAttributeNames:
                    Object.keys(expressionAttributeNames).length > 0
                        ? expressionAttributeNames
                        : undefined,
            };

            let command: QueryCommand;

            // Case 1: Filter by User (GSI2)
            if (filters?.user && filters.user !== 'all') {
                const hasRange = filters.startDate && filters.endDate;
                const hasStart = filters.startDate && !filters.endDate;
                command = new QueryCommand({
                    ...baseQueryConfig,
                    IndexName: 'GSI2',
                    KeyConditionExpression: hasRange
                        ? 'gsi2pk = :pkVal AND gsi2sk BETWEEN :startDate AND :endDate'
                        : hasStart
                        ? 'gsi2pk = :pkVal AND gsi2sk >= :startDate'
                        : 'gsi2pk = :pkVal AND gsi2sk <= :endDate',
                    ExpressionAttributeValues: {
                        ...baseQueryConfig.ExpressionAttributeValues,
                        ':pkVal': `USER#${filters.user}`,
                        ...(hasRange
                            ? { ':startDate': filters.startDate, ':endDate': filters.endDate }
                            : {}),
                        ...(hasStart ? { ':startDate': filters.startDate } : {}),
                        ...(!hasRange && !hasStart
                            ? { ':endDate': filters.endDate || new Date().toISOString() }
                            : {}),
                    },
                });
            }
            // Case 2: Filter by EventType (GSI3)
            else if (filters?.eventType && filters.eventType !== 'all') {
                const hasRange = filters.startDate && filters.endDate;
                const hasStart = filters.startDate && !filters.endDate;
                command = new QueryCommand({
                    ...baseQueryConfig,
                    IndexName: 'GSI3',
                    KeyConditionExpression: hasRange
                        ? 'gsi3pk = :pkVal AND gsi3sk BETWEEN :startDate AND :endDate'
                        : hasStart
                        ? 'gsi3pk = :pkVal AND gsi3sk >= :startDate'
                        : 'gsi3pk = :pkVal AND gsi3sk <= :endDate',
                    ExpressionAttributeValues: {
                        ...baseQueryConfig.ExpressionAttributeValues,
                        ':pkVal': `EVENT#${filters.eventType}`,
                        ...(hasRange
                            ? { ':startDate': filters.startDate, ':endDate': filters.endDate }
                            : {}),
                        ...(hasStart ? { ':startDate': filters.startDate } : {}),
                        ...(!hasRange && !hasStart
                            ? { ':endDate': filters.endDate || new Date().toISOString() }
                            : {}),
                    },
                });
            }
            // Case 3: Global Time Range (GSI1)
            else {
                const hasRange = filters?.startDate && filters?.endDate;
                const hasStart = filters?.startDate && !filters?.endDate;
                command = new QueryCommand({
                    ...baseQueryConfig,
                    IndexName: 'GSI1',
                    KeyConditionExpression: hasRange
                        ? 'gsi1pk = :pkVal AND gsi1sk BETWEEN :startDate AND :endDate'
                        : hasStart
                        ? 'gsi1pk = :pkVal AND gsi1sk >= :startDate'
                        : 'gsi1pk = :pkVal AND gsi1sk <= :endDate',
                    ExpressionAttributeValues: {
                        ...baseQueryConfig.ExpressionAttributeValues,
                        ':pkVal': 'TYPE#LOG',
                        ...(hasRange
                            ? { ':startDate': filters!.startDate, ':endDate': filters!.endDate }
                            : {}),
                        ...(hasStart ? { ':startDate': filters!.startDate } : {}),
                        ...(!hasRange && !hasStart
                            ? { ':endDate': filters?.endDate || new Date().toISOString() }
                            : {}),
                    },
                });
            }

            const schedulerResourceEventPattern =
                /^scheduler\.(ec2|ecs|rds)\.(start|stop|error)$/;

            const applyClientFilters = (items: Record<string, unknown>[]) => {
                let result = items.map(AuditLogDynamoRepository.transformToAuditLog);
                result = result.filter(
                    (l) => !schedulerResourceEventPattern.test(l.eventType || '')
                );
                if (filters?.searchTerm) {
                    const term = filters.searchTerm.toLowerCase();
                    result = result.filter(
                        (l) =>
                            (l.action?.toLowerCase() || '').includes(term) ||
                            (l.details?.toLowerCase() || '').includes(term) ||
                            (l.user?.toLowerCase() || '').includes(term)
                    );
                }
                return result;
            };

            let auditLogs: AuditLog[] = [];
            let lastEvaluatedKey: Record<string, unknown> | undefined = startKey;
            const MAX_ITERATIONS = 10;
            let iterations = 0;

            do {
                const iterCommand = this.buildQueryCommand(command, lastEvaluatedKey);
                const response = await getDynamoDBDocumentClient().send(iterCommand);
                const batch = applyClientFilters(
                    (response.Items || []) as Record<string, unknown>[]
                );
                auditLogs = auditLogs.concat(batch);
                lastEvaluatedKey = response.LastEvaluatedKey as
                    | Record<string, unknown>
                    | undefined;
                iterations++;
            } while (auditLogs.length < limit && lastEvaluatedKey && iterations < MAX_ITERATIONS);

            const nextPageToken = lastEvaluatedKey
                ? Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64')
                : undefined;

            return {
                logs: auditLogs.slice(0, limit),
                nextPageToken,
            };
        } catch (error: unknown) {
            console.error('[AuditLogDynamoRepository] Error fetching audit logs:', error);
            return { logs: [], nextPageToken: undefined };
        }
    }

    private buildQueryCommand(
        original: QueryCommand,
        newStartKey: Record<string, unknown> | undefined
    ): QueryCommand {
        const input = { ...original.input, ExclusiveStartKey: newStartKey };
        return new QueryCommand(input);
    }

    private static transformToAuditLog(item: Record<string, unknown>): AuditLog {
        return {
            id: (item.id as string) || (item.pk as string).replace('LOG#', ''),
            type: 'audit_log',
            timestamp: item.timestamp as string,
            eventType: item.eventType as string,
            action: item.action as string,
            user: item.user as string,
            userType: item.userType as AuditLog['userType'],
            resource: item.resource as string,
            resourceType: item.resourceType as string,
            resourceId: item.resourceId as string,
            status: item.status as AuditLog['status'],
            severity: item.severity as AuditLog['severity'],
            details: item.details as string,
            metadata: item.metadata as Record<string, unknown> | undefined,
            ipAddress: item.ipAddress as string | undefined,
            userAgent: item.userAgent as string | undefined,
            sessionId: item.sessionId as string | undefined,
            correlationId: item.correlationId as string | undefined,
            executionId: item.executionId as string | undefined,
            region: item.region as string | undefined,
            accountId: item.accountId as string | undefined,
            duration: item.duration as number | undefined,
            errorCode: item.errorCode as string | undefined,
            source: item.source as AuditLog['source'],
        };
    }

    private generateAuditId(): string {
        return `log-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    private validateAndCleanAuditData(
        data: Omit<AuditLog, 'id' | 'type' | 'timestamp'>
    ): Record<string, unknown> {
        return {
            ...data,
            action: data.action || 'Unknown Action',
            status: data.status || 'info',
            user: data.user || 'system',
        };
    }
}
