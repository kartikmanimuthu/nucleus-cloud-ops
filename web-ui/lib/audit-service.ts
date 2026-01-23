// DynamoDB service for audit log operations
import { ScanCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamoDBDocumentClient, AUDIT_TABLE_NAME, handleDynamoDBError } from './aws-config';
import { AuditLog } from './types';

export interface AuditLogFilters {
    startDate?: string;
    endDate?: string;
    eventType?: string;
    status?: string;
    severity?: string;
    userType?: string;
    resourceType?: string;
    user?: string;
    correlationId?: string;
    executionId?: string;
    resourceId?: string;
    ipAddress?: string;
    source?: string;
    searchTerm?: string;
    limit?: number;
    nextPageToken?: string;
}

export interface AuditLogResponse {
    logs: AuditLog[];
    nextPageToken?: string;
}

export interface AuditLogStats {
    totalLogs: number;
    successCount: number;
    errorCount: number;
    warningCount: number;
    systemEvents: number;
    userEvents: number;
    criticalEvents: number;
    byEventType: Record<string, number>;
    byStatus: Record<string, number>;
    bySeverity: Record<string, number>;
    byResourceType: Record<string, number>;
}

export class AuditService {
    /**
     * Create a new audit log entry
     */
    static async createAuditLog(auditData: Omit<AuditLog, 'id' | 'type' | 'timestamp'>): Promise<void> {
        try {
            if (process.env.NODE_ENV === 'development' && process.env.SKIP_AUDIT_LOGGING === 'true') {
                return;
            }

            // Check if auditData is a string
            if (typeof auditData === 'string') {
                try {
                    auditData = JSON.parse(auditData);
                } catch (parseError) {
                    console.error('AuditService - Failed to parse audit data string:', parseError);
                    return;
                }
            }

            if (!auditData || typeof auditData !== 'object' || Object.keys(auditData).length === 0) {
                return;
            }

            const cleanedAuditData = this.validateAndCleanAuditData(auditData);
            const auditId = this.generateAuditId();
            const timestamp = new Date().toISOString();

            // TTL: 90 days from now
            const expireAt = Math.floor(Date.now() / 1000) + (90 * 24 * 60 * 60);

            // Determine GSI keys
            const user = cleanedAuditData.user || 'system';
            // Ensure eventType is cleaner for GSI
            const eventType = cleanedAuditData.eventType || 'unknown';

            const auditLogItem = {
                pk: `LOG#${auditId}`,
                sk: timestamp,
                gsi1pk: 'TYPE#LOG',
                gsi1sk: timestamp,
                gsi2pk: `USER#${user}`, // GSI2: Filter by User
                gsi2sk: timestamp,
                gsi3pk: `EVENT#${eventType}`, // GSI3: Filter by Event Type
                gsi3sk: timestamp,
                expire_at: expireAt,

                // Attributes
                id: auditId,
                timestamp: timestamp,
                ...cleanedAuditData
            };

            const command = new PutCommand({
                TableName: AUDIT_TABLE_NAME,
                Item: auditLogItem
            });

            await getDynamoDBDocumentClient().send(command);
            console.log('AuditService - Successfully created audit log:', auditId);

        } catch (error: unknown) {
            console.error('AuditService - Error creating audit log:', error);
        }
    }

    /**
     * Fetch audit logs with optional filters and pagination
     */
    static async getAuditLogs(filters?: AuditLogFilters): Promise<AuditLogResponse> {
        try {
            console.log('AuditService - Fetching audit logs with filters:', filters);

            let command;
            const limit = filters?.limit || 20;
            const startKey = filters?.nextPageToken ? JSON.parse(Buffer.from(filters.nextPageToken, 'base64').toString('utf-8')) : undefined;

            // Build FilterExpression for non-key attributes
            const filterExpressions: string[] = [];
            const expressionAttributeValues: Record<string, any> = {};
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
                ScanIndexForward: false, // Descending (Newest first)
                Limit: limit,
                ExclusiveStartKey: startKey,
                FilterExpression: filterExpressions.length > 0 ? filterExpressions.join(' AND ') : undefined,
                ExpressionAttributeValues: Object.keys(expressionAttributeValues).length > 0 ? expressionAttributeValues : undefined,
                ExpressionAttributeNames: Object.keys(expressionAttributeNames).length > 0 ? expressionAttributeNames : undefined
            };

            // Strategy: Use specialized GSIs if specific filters are present, otherwise GSI1 (Global Time-based)

            // Case 1: Filter by User (GSI2)
            // USER#<user> -> timestamp
            if (filters?.user && filters.user !== 'all') {
                command = new QueryCommand({
                    ...baseQueryConfig,
                    IndexName: 'GSI2',
                    KeyConditionExpression: filters.startDate && filters.endDate
                        ? 'gsi2pk = :pkVal AND gsi2sk BETWEEN :startDate AND :endDate'
                        : 'gsi2pk = :pkVal AND gsi2sk <= :endDate',
                    ExpressionAttributeValues: {
                        ...baseQueryConfig.ExpressionAttributeValues,
                        ':pkVal': `USER#${filters.user}`,
                        ':endDate': filters.endDate || new Date().toISOString(),
                        ...(filters.startDate && filters.endDate ? { ':startDate': filters.startDate } : {})
                    }
                });
            }
            // Case 2: Filter by EventType (GSI3)
            // EVENT#<eventType> -> timestamp
            else if (filters?.eventType && filters.eventType !== 'all') {
                command = new QueryCommand({
                    ...baseQueryConfig,
                    IndexName: 'GSI3',
                    KeyConditionExpression: filters.startDate && filters.endDate
                        ? 'gsi3pk = :pkVal AND gsi3sk BETWEEN :startDate AND :endDate'
                        : 'gsi3pk = :pkVal AND gsi3sk <= :endDate',
                    ExpressionAttributeValues: {
                        ...baseQueryConfig.ExpressionAttributeValues,
                        ':pkVal': `EVENT#${filters.eventType}`,
                        ':endDate': filters.endDate || new Date().toISOString(),
                        ...(filters.startDate && filters.endDate ? { ':startDate': filters.startDate } : {})
                    }
                });
            }
            // Case 3: Global Time Range (GSI1)
            // TYPE#LOG -> timestamp
            else {
                command = new QueryCommand({
                    ...baseQueryConfig,
                    IndexName: 'GSI1',
                    KeyConditionExpression: filters?.startDate && filters?.endDate
                        ? 'gsi1pk = :pkVal AND gsi1sk BETWEEN :startDate AND :endDate'
                        : 'gsi1pk = :pkVal AND gsi1sk <= :endDate',
                    ExpressionAttributeValues: {
                        ...baseQueryConfig.ExpressionAttributeValues,
                        ':pkVal': 'TYPE#LOG',
                        ':endDate': filters?.endDate || new Date().toISOString(),
                        ...(filters?.startDate && filters?.endDate ? { ':startDate': filters.startDate } : {})
                    }
                });
            }

            const response = await getDynamoDBDocumentClient().send(command);
            let auditLogs = (response.Items || []).map(this.transformToAuditLog);

            // Client-side filtering check (Search Term is hard to do with DynamoDB FilterExpression due to case sensitivity)
            // Filter out scheduler individual resource events (ec2/ecs/rds start/stop/error)
            const schedulerResourceEventPattern = /^scheduler\.(ec2|ecs|rds)\.(start|stop|error)$/;
            auditLogs = auditLogs.filter(l => !schedulerResourceEventPattern.test(l.eventType || ''));

            if (filters?.searchTerm) {
                const term = filters.searchTerm.toLowerCase();
                auditLogs = auditLogs.filter(l =>
                    (l.action?.toLowerCase() || '').includes(term) ||
                    (l.details?.toLowerCase() || '').includes(term) ||
                    (l.user?.toLowerCase() || '').includes(term)
                );
            }

            const nextPageToken = response.LastEvaluatedKey
                ? Buffer.from(JSON.stringify(response.LastEvaluatedKey)).toString('base64')
                : undefined;

            return {
                logs: auditLogs,
                nextPageToken
            };

        } catch (error: unknown) {
            console.error('AuditService - Error fetching audit logs:', error);
            return { logs: [], nextPageToken: undefined };
        }
    }

    /**
     * Get audit logs by correlation ID
     */
    static async getAuditLogsByCorrelation(correlationId: string): Promise<AuditLog[]> {
        try {
            const command = new ScanCommand({
                TableName: AUDIT_TABLE_NAME,
                FilterExpression: 'correlationId = :correlationId',
                ExpressionAttributeValues: {
                    ':correlationId': correlationId,
                },
            });

            const response = await getDynamoDBDocumentClient().send(command);
            const auditLogs = (response.Items || []).map(this.transformToAuditLog);
            auditLogs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

            return auditLogs;
        } catch (error: unknown) {
            console.error('AuditService - Error fetching correlated audit logs:', error);
            return [];
        }
    }

    /**
     * Get audit log stats
     * Note: This operation is expensive (Scan/Large Query) so we might want to limit scope or cache it.
     * For now, we'll implement a query limited to recent logs if no date range, or specific range.
     */
    static async getAuditLogStats(filters?: AuditLogFilters): Promise<AuditLogStats> {
        try {
            // Re-use Logic but maybe force a larger limit for stats or separate aggregated table (not in scope)
            // We'll fetch up to 1000 logs for "Recent Stats"
            const { logs } = await this.getAuditLogs({ ...filters, limit: 1000, nextPageToken: undefined });

            return {
                totalLogs: logs.length,
                successCount: logs.filter(log => log.status === 'success').length,
                errorCount: logs.filter(log => log.status === 'error').length,
                warningCount: logs.filter(log => log.status === 'warning').length,
                systemEvents: logs.filter(log => log.userType === 'system').length,
                userEvents: logs.filter(log => log.userType === 'user' || log.userType === 'admin').length,
                criticalEvents: logs.filter(log => log.severity === 'critical').length,
                byEventType: this.groupBy(logs, 'eventType'),
                byStatus: this.groupBy(logs, 'status'),
                bySeverity: this.groupBy(logs, 'severity'),
                byResourceType: this.groupBy(logs, 'resourceType'),
            };

        } catch (error: unknown) {
            console.error('AuditService - Error fetching audit log stats:', error);
            return {
                totalLogs: 0,
                successCount: 0,
                errorCount: 0,
                warningCount: 0,
                systemEvents: 0,
                userEvents: 0,
                criticalEvents: 0,
                byEventType: {},
                byStatus: {},
                bySeverity: {},
                byResourceType: {},
            };
        }
    }

    private static transformToAuditLog(item: any): AuditLog {
        return {
            id: item.id || item.pk.replace('LOG#', ''),
            // name removed as it is not in AuditLog interface
            type: 'audit_log',
            timestamp: item.timestamp,
            eventType: item.eventType,
            action: item.action,
            user: item.user,
            userType: item.userType,
            resource: item.resource,
            resourceType: item.resourceType,
            resourceId: item.resourceId,
            status: item.status,
            severity: item.severity,
            details: item.details,
            metadata: item.metadata,
            ipAddress: item.ipAddress,
            userAgent: item.userAgent,
            sessionId: item.sessionId,
            correlationId: item.correlationId,
            source: item.source,
            region: item.region,
            accountId: item.accountId,
            duration: item.duration,
            errorCode: item.errorCode
        };
    }

    // Helper methods
    private static generateAuditId(): string {
        return `audit-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private static groupBy(array: any[], key: string): Record<string, number> {
        return array.reduce((result, item) => {
            const value = item[key] || 'unknown';
            result[value] = (result[value] || 0) + 1;
            return result;
        }, {});
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private static validateAndCleanAuditData(data: any): Record<string, any> {
        // Reuse existing validation logic but simplified
        if (!data || typeof data !== 'object') throw new Error('Invalid audit data');

        return {
            ...data,
            // Ensure defaults
            action: data.action || 'Unknown Action',
            status: data.status || 'info',
            user: data.user || 'system',
            timestamp: data.timestamp || new Date().toISOString()
        };
    }

    /**
     * Make audit logging silently fail rather than disrupt the app
     */
    static async logUserAction(data: {
        action: string;
        resourceType: string;
        resourceId: string;
        resourceName: string;
        user: string;
        userType: 'user' | 'admin';
        status: 'success' | 'error' | 'warning';
        details: string;
        metadata?: Record<string, any>;
        ipAddress?: string;
        userAgent?: string;
        sessionId?: string;
    }): Promise<void> {
        try {
            await this.createAuditLog({
                eventType: `${data.resourceType}.${data.action.toLowerCase().replace(/\s+/g, '_')}`,
                ...data,
                resource: data.resourceName || data.resourceId,
                severity: data.status === 'error' ? 'high' : (data.status === 'warning' ? 'medium' : 'info'),
                source: 'web-ui'
            });
        } catch (error) {
            console.error('Failed to create user action audit log:', error);
        }
    }

    static async logResourceAction(data: {
        action: string;
        resourceType: string;
        resourceId: string;
        resourceName: string;
        status: 'success' | 'error' | 'warning';
        details: string;
        user?: string;
        userType?: 'system' | 'user' | 'admin';
        metadata?: Record<string, any>;
        correlationId?: string;
        accountId?: string;
        region?: string;
        source?: 'web-ui' | 'lambda' | 'system' | 'api';
    }): Promise<void> {
        try {
            await this.createAuditLog({
                eventType: `${data.resourceType}.${data.action.toLowerCase().replace(/\s+/g, '_')}`,
                ...data, // Spread rest
                resource: data.resourceName || data.resourceId,
                severity: data.status === 'error' ? 'high' : (data.status === 'warning' ? 'medium' : 'info'),
                user: data.user || 'system',
                userType: data.userType || 'system',
                source: data.source || 'system',
            });
        } catch (error) {
            console.error('Failed to create resource action audit log:', error);
        }
    }
}
