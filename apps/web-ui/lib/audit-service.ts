// Audit service — delegates to the repository layer via feature flags
// Use USE_PG_AUDIT_LOGS=true to switch to PostgreSQL backend
import { AuditLog } from './types';
import { getAuditLogRepository } from '@/lib/db/repository-factory';
import type { NextRequest } from 'next/server';

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

/** Retention days by event category per requirements */
const RETENTION_DAYS: Record<string, number> = {
    'auth': 365,
    'rbac': 365,
    'tenant': 180,
    'account': 90,
    'schedule': 90,
    'agent': 90,
    'integration': 90,
    'inventory': 30,
    'kb': 30,
    'chat': 30,
    'trigger': 30,
};

/** Derive retention days from event type domain */
function getRetentionDays(eventType: string): number {
    const domain = eventType.split('.')[0];
    return RETENTION_DAYS[domain] ?? 90;
}

export class AuditService {
    /**
     * Create a new audit log entry.
     * Fire-and-forget: delegates to the active repository (DynamoDB or PostgreSQL).
     */
    static async createAuditLog(auditData: Omit<AuditLog, 'id' | 'type' | 'timestamp'>): Promise<void> {
        try {
            if (process.env.NODE_ENV === 'development' && process.env.SKIP_AUDIT_LOGGING === 'true') {
                return;
            }

            // Check if auditData is a string (legacy safety guard)
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
            const repo = getAuditLogRepository();
            await repo.createAuditLog(cleanedAuditData as Omit<AuditLog, 'id' | 'type' | 'timestamp'>);
        } catch (error: unknown) {
            console.error('AuditService - Error creating audit log:', error);
        }
    }

    /**
     * Fetch audit logs with optional filters and pagination.
     * Delegates to the active repository.
     */
    static async getAuditLogs(
        filters?: AuditLogFilters,
        tenantId?: string
    ): Promise<AuditLogResponse> {
        try {
            console.log('AuditService - Fetching audit logs with filters:', filters);
            if (!tenantId) throw new Error('getAuditLogs: tenantId is required');
            const effectiveTenantId = tenantId;
            const repo = getAuditLogRepository();
            return await repo.getAuditLogs(effectiveTenantId, filters);
        } catch (error: unknown) {
            console.error('AuditService - Error fetching audit logs:', error);
            return { logs: [], nextPageToken: undefined };
        }
    }

    /**
     * Get audit logs by correlation ID.
     */
    static async getAuditLogsByCorrelation(correlationId: string, tenantId?: string): Promise<AuditLog[]> {
        try {
            const result = await this.getAuditLogs({ correlationId, limit: 100 }, tenantId);
            return result.logs;
        } catch (error: unknown) {
            console.error('AuditService - Error fetching correlated audit logs:', error);
            return [];
        }
    }

    /**
     * Get audit log stats — derived from recent logs.
     */
    static async getAuditLogStats(filters?: AuditLogFilters, tenantId?: string): Promise<AuditLogStats> {
        try {
            const { logs } = await this.getAuditLogs({ ...filters, limit: 500, nextPageToken: undefined }, tenantId);

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

    // Helper methods
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
        if (!data || typeof data !== 'object') throw new Error('Invalid audit data');

        // Compute retentionDays from event type if not explicitly set
        const retentionDays = data.retentionDays ?? getRetentionDays(data.eventType || '');

        return {
            ...data,
            // Ensure defaults
            action: data.action || 'Unknown Action',
            status: data.status || 'info',
            user: data.user || 'system',
            timestamp: data.timestamp || new Date().toISOString(),
            retentionDays,
        };
    }

    /**
     * Extract IP address and user agent from a NextRequest for audit context.
     */
    static getRequestContext(request: NextRequest): { ipAddress: string; userAgent: string; requestId: string } {
        const ipAddress =
            request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
            request.headers.get('x-real-ip') ||
            'unknown';
        const userAgent = request.headers.get('user-agent') || 'unknown';
        const requestId = request.headers.get('x-request-id') || `req-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
        return { ipAddress, userAgent, requestId };
    }

    /**
     * Log a user-initiated platform action.
     * Generates standardized domain.entity.action event type.
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
        tenantId?: string;
        // New compliance fields
        eventType?: string;
        severity?: 'low' | 'medium' | 'high' | 'critical' | 'info';
        changeSet?: { before?: Record<string, any>; after?: Record<string, any> };
        requestId?: string;
        apiRoute?: string;
        httpMethod?: string;
        dataClassification?: string;
    }): Promise<void> {
        try {
            const tenantId = data.tenantId || data.metadata?.tenantId;
            const eventType = data.eventType || `${data.resourceType}.${data.action.toLowerCase().replace(/\s+/g, '_')}`;
            await this.createAuditLog({
                eventType,
                ...data,
                ...(tenantId ? { tenantId } : {}),
                resource: data.resourceName || data.resourceId,
                severity: data.severity ?? (data.status === 'error' ? 'high' : (data.status === 'warning' ? 'medium' : 'info')),
                source: 'platform',
            });
        } catch (error) {
            console.error('Failed to create user action audit log:', error);
        }
    }

    /**
     * Log a resource-level action (schedule execution, sync, etc.).
     */
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
        source?: 'platform' | 'system' | 'agent' | 'external';
        tenantId?: string;
        // New compliance fields
        eventType?: string;
        severity?: 'low' | 'medium' | 'high' | 'critical' | 'info';
        changeSet?: { before?: Record<string, any>; after?: Record<string, any> };
        requestId?: string;
        apiRoute?: string;
        httpMethod?: string;
        dataClassification?: string;
    }): Promise<void> {
        try {
            const tenantId = data.tenantId || data.metadata?.tenantId;
            const eventType = data.eventType || `${data.resourceType}.${data.action.toLowerCase().replace(/\s+/g, '_')}`;
            await this.createAuditLog({
                eventType,
                ...data,
                ...(tenantId ? { tenantId } : {}),
                resource: data.resourceName || data.resourceId,
                severity: data.severity ?? (data.status === 'error' ? 'high' : (data.status === 'warning' ? 'medium' : 'info')),
                user: data.user || 'system',
                userType: data.userType || 'system',
                source: data.source || 'system',
            });
        } catch (error) {
            console.error('Failed to create resource action audit log:', error);
        }
    }

    /**
     * Log a system event (background jobs, workers, cron tasks).
     * Sets userType='system', source='system'.
     */
    static async logSystemEvent(data: {
        eventType: string;
        action: string;
        status: 'success' | 'error' | 'warning';
        details: string;
        resourceType?: string;
        resourceId?: string;
        metadata?: Record<string, any>;
        correlationId?: string;
        executionId?: string;
        accountId?: string;
        region?: string;
        duration?: number;
        errorCode?: string;
        tenantId?: string;
        severity?: 'low' | 'medium' | 'high' | 'critical' | 'info';
    }): Promise<void> {
        try {
            const tenantId = data.tenantId || data.metadata?.tenantId;
            await this.createAuditLog({
                ...data,
                ...(tenantId ? { tenantId } : {}),
                resource: data.resourceId || '',
                severity: data.severity ?? (data.status === 'error' ? 'high' : (data.status === 'warning' ? 'medium' : 'info')),
                user: 'system',
                userType: 'system',
                source: 'system',
            });
        } catch (error) {
            console.error('Failed to create system event audit log:', error);
        }
    }

    /**
     * Log an agent event (AI agent tool executions).
     * Sets source='agent', requires correlationId (threadId).
     */
    static async logAgentEvent(data: {
        eventType: string;
        action: string;
        userId: string;
        status: 'success' | 'error' | 'warning';
        details: string;
        resourceType?: string;
        resourceId?: string;
        metadata?: Record<string, any>;
        correlationId: string;
        executionId?: string;
        accountId?: string;
        region?: string;
        tenantId?: string;
        severity?: 'low' | 'medium' | 'high' | 'critical' | 'info';
    }): Promise<void> {
        try {
            const tenantId = data.tenantId || data.metadata?.tenantId;
            await this.createAuditLog({
                ...data,
                ...(tenantId ? { tenantId } : {}),
                resource: data.resourceId || '',
                severity: data.severity ?? (data.status === 'error' ? 'high' : 'medium'),
                user: data.userId,
                userType: 'user',
                source: 'agent',
            });
        } catch (error) {
            console.error('Failed to create agent event audit log:', error);
        }
    }
}
