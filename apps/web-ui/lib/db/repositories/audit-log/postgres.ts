/**
 * AuditLogPostgresRepository
 *
 * PostgreSQL implementation of IAuditLogRepository using Prisma ORM.
 * Reads/writes the `audit_logs` table (defined in libs/prisma/schema.prisma).
 *
 * Key differences vs DynamoDB path:
 * - expiresAt (DateTime) replaces DynamoDB TTL — set to now + 30 days on insert (audit retention)
 * - tenantId scoping on every query (DynamoDB audit table has no tenant filter)
 * - Server-side filtering for eventType, status, severity, user
 * - createAuditLog is fire-and-forget (errors swallowed)
 *
 * Multi-tenant safety: every query is scoped by tenantId — no cross-tenant data access.
 */
import { andWhere, getTenantClient } from '@/lib/db/pg-config';
import type { AuditLog } from '@/lib/types';
import type { AuditLogFilters, AuditLogResponse } from '@/lib/audit-service';
import type { IAuditLogRepository } from './interface';
import { env } from '@/env';

export class AuditLogPostgresRepository implements IAuditLogRepository {
    /**
     * Fire-and-forget: errors are swallowed to prevent disrupting the main flow.
     */
    async createAuditLog(
        auditData: Omit<AuditLog, 'id' | 'type' | 'timestamp'>
    ): Promise<void> {
        try {
            if (
                env.NODE_ENV === 'development' &&
                env.SKIP_AUDIT_LOGGING === 'true'
            ) {
                return;
            }

            const logId = `log-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            const retentionDays = (auditData as Record<string, unknown>).retentionDays as number | undefined ?? 90;
            const expiresAt = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000);

            const tenantId = (auditData as Record<string, unknown>).tenantId as string | undefined;
            if (!tenantId) {
                console.error('[AuditLogPostgresRepository] createAuditLog called without tenantId — skipping');
                return;
            }

            await getTenantClient(tenantId).auditLog.create({
                data: {
                    tenantId,
                    logId,
                    eventType: auditData.eventType,
                    action: auditData.action || 'Unknown Action',
                    user: auditData.user || 'system',
                    userType: auditData.userType || 'system',
                    resource: auditData.resource,
                    resourceType: auditData.resourceType,
                    resourceId: auditData.resourceId,
                    status: auditData.status || 'info',
                    severity: auditData.severity || 'info',
                    details: auditData.details,
                    metadata: (auditData.metadata as object) || undefined,
                    ipAddress: auditData.ipAddress,
                    userAgent: auditData.userAgent,
                    sessionId: auditData.sessionId,
                    correlationId: auditData.correlationId,
                    executionId: auditData.executionId,
                    region: auditData.region,
                    accountId: auditData.accountId,
                    duration: auditData.duration,
                    errorCode: auditData.errorCode,
                    source: auditData.source || 'system',
                    expiresAt,
                    // Compliance fields
                    changeSet: (auditData.changeSet as object) || undefined,
                    requestId: auditData.requestId,
                    apiRoute: auditData.apiRoute,
                    httpMethod: auditData.httpMethod,
                    dataClassification: auditData.dataClassification,
                    retentionDays,
                },
            });

            console.log('[AuditLogPostgresRepository] Created audit log:', logId);
        } catch (error: unknown) {
            console.error('[AuditLogPostgresRepository] Error creating audit log:', error);
            // Fire-and-forget: swallow error
        }
    }

    async getAuditLogs(
        tenantId: string,
        filters?: AuditLogFilters
    ): Promise<AuditLogResponse> {
        try {
            console.log('[AuditLogPostgresRepository] Fetching audit logs', { tenantId, filters });

            const limit = filters?.limit || 20;

            const where: Record<string, unknown> = { tenantId };

            // Server-side filtering
            if (filters?.status && filters.status !== 'all') {
                where.status = filters.status;
            }
            if (filters?.severity && filters.severity !== 'all') {
                where.severity = filters.severity;
            }
            if (filters?.eventType && filters.eventType !== 'all') {
                where.eventType = filters.eventType;
            }
            if (filters?.user && filters.user !== 'all') {
                where.user = filters.user;
            }
            if (filters?.userType && filters.userType !== 'all') {
                where.userType = filters.userType;
            }
            if (filters?.resourceType && filters.resourceType !== 'all') {
                where.resourceType = filters.resourceType;
            }
            if (filters?.resourceId) {
                where.resourceId = filters.resourceId;
            }
            if (filters?.correlationId) {
                where.correlationId = filters.correlationId;
            }
            if (filters?.executionId) {
                where.executionId = filters.executionId;
            }
            if (filters?.ipAddress) {
                where.ipAddress = filters.ipAddress;
            }
            if (filters?.source && filters.source !== 'all') {
                where.source = filters.source;
            }

            // Date range filtering
            if (filters?.startDate || filters?.endDate) {
                const timestampFilter: Record<string, Date> = {};
                if (filters.startDate) timestampFilter.gte = new Date(filters.startDate);
                if (filters.endDate) timestampFilter.lte = new Date(filters.endDate);
                where.timestamp = timestampFilter;
            }

            // Text search
            if (filters?.searchTerm?.trim()) {
                const term = filters.searchTerm.trim();
                where.OR = [
                    { action: { contains: term, mode: 'insensitive' } },
                    { details: { contains: term, mode: 'insensitive' } },
                    { user: { contains: term, mode: 'insensitive' } },
                ];
            }

            // Cursor-based pagination using nextPageToken (format: "timestamp|id")
            if (filters?.nextPageToken) {
                const [cursorTimestamp, cursorId] = filters.nextPageToken.split('|');
                if (cursorTimestamp && cursorId) {
                    where.OR = where.OR || undefined;
                    // For desc ordering: get rows older than cursor
                    const cursorCondition = {
                        OR: [
                            { timestamp: { lt: new Date(cursorTimestamp) } },
                            {
                                timestamp: new Date(cursorTimestamp),
                                id: { lt: cursorId },
                            },
                        ],
                    };
                    // Merge cursor with existing where (handle existing OR for search)
                    if (where.OR) {
                        const searchOr = where.OR;
                        delete where.OR;
                        where.AND = [
                            { OR: searchOr },
                            cursorCondition,
                        ];
                    } else {
                        where.AND = [cursorCondition];
                    }
                }
            }

            // Gate 3: intersect the caller's readable rows. andWhere() nests
            // under AND so it composes safely with the cursor-pagination AND
            // built above, rather than displacing it.
            const scoped = andWhere(where, filters?.rowFilter);

            // Fetch limit+1 to determine if there's a next page
            const rows = await getTenantClient(tenantId).auditLog.findMany({
                where: scoped,
                orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
                take: limit + 1,
            });

            const hasMore = rows.length > limit;
            const pageRows = hasMore ? rows.slice(0, limit) : rows;

            let nextPageToken: string | undefined;
            if (hasMore && pageRows.length > 0) {
                const lastRow = pageRows[pageRows.length - 1];
                nextPageToken = `${lastRow.timestamp.toISOString()}|${lastRow.id}`;
            }

            return {
                logs: pageRows.map((r) => this.transformToAuditLog(r)),
                nextPageToken,
            };
        } catch (error: unknown) {
            console.error('[AuditLogPostgresRepository] Error fetching audit logs:', error);
            return { logs: [] };
        }
    }

    /**
     * Get distinct filter values for dynamic filter dropdowns.
     */
    async getDistinctFilterValues(tenantId: string): Promise<{
        sources: string[];
        users: string[];
        resourceTypes: string[];
        eventTypes: string[];
        severities: string[];
        statuses: string[];
        userTypes: string[];
    }> {
        try {
            const client = getTenantClient(tenantId);

            const [sources, users, resourceTypes, eventTypes, severities, statuses, userTypes] = await Promise.all([
                client.auditLog.findMany({ where: { tenantId }, distinct: ['source'], select: { source: true } }),
                client.auditLog.findMany({ where: { tenantId }, distinct: ['user'], select: { user: true } }),
                client.auditLog.findMany({ where: { tenantId, resourceType: { not: null } }, distinct: ['resourceType'], select: { resourceType: true } }),
                client.auditLog.findMany({ where: { tenantId }, distinct: ['eventType'], select: { eventType: true } }),
                client.auditLog.findMany({ where: { tenantId }, distinct: ['severity'], select: { severity: true } }),
                client.auditLog.findMany({ where: { tenantId }, distinct: ['status'], select: { status: true } }),
                client.auditLog.findMany({ where: { tenantId }, distinct: ['userType'], select: { userType: true } }),
            ]);

            return {
                sources: sources.map(r => r.source).sort(),
                users: users.map(r => r.user).sort(),
                resourceTypes: resourceTypes.map(r => r.resourceType!).filter(Boolean).sort(),
                eventTypes: eventTypes.map(r => r.eventType).sort(),
                severities: severities.map(r => r.severity).sort(),
                statuses: statuses.map(r => r.status).sort(),
                userTypes: userTypes.map(r => r.userType).sort(),
            };
        } catch (error) {
            console.error('[AuditLogPostgresRepository] Error fetching distinct filter values:', error);
            return { sources: [], users: [], resourceTypes: [], eventTypes: [], severities: [], statuses: [], userTypes: [] };
        }
    }

    private transformToAuditLog(record: {
        id: string;
        tenantId: string;
        logId: string;
        timestamp: Date;
        eventType: string;
        action: string;
        user: string;
        userType: string;
        resource: string | null;
        resourceType: string | null;
        resourceId: string | null;
        status: string;
        severity: string;
        details: string | null;
        metadata: unknown;
        ipAddress: string | null;
        userAgent: string | null;
        sessionId: string | null;
        correlationId: string | null;
        executionId: string | null;
        region: string | null;
        accountId: string | null;
        duration: number | null;
        errorCode: string | null;
        source: string;
        expiresAt: Date;
        changeSet: unknown;
        requestId: string | null;
        apiRoute: string | null;
        httpMethod: string | null;
        dataClassification: string | null;
        retentionDays: number;
    }): AuditLog {
        return {
            id: record.logId,
            type: 'audit_log',
            timestamp: record.timestamp.toISOString(),
            eventType: record.eventType,
            action: record.action,
            user: record.user,
            userType: record.userType as AuditLog['userType'],
            resource: record.resource ?? '',
            resourceType: record.resourceType ?? '',
            resourceId: record.resourceId ?? '',
            status: record.status as AuditLog['status'],
            severity: record.severity as AuditLog['severity'],
            details: record.details ?? '',
            metadata: (record.metadata as Record<string, unknown>) ?? undefined,
            ipAddress: record.ipAddress ?? undefined,
            userAgent: record.userAgent ?? undefined,
            sessionId: record.sessionId ?? undefined,
            correlationId: record.correlationId ?? undefined,
            executionId: record.executionId ?? undefined,
            region: record.region ?? undefined,
            accountId: record.accountId ?? undefined,
            duration: record.duration ?? undefined,
            errorCode: record.errorCode ?? undefined,
            source: record.source as AuditLog['source'],
            changeSet: (record.changeSet as AuditLog['changeSet']) ?? undefined,
            requestId: record.requestId ?? undefined,
            apiRoute: record.apiRoute ?? undefined,
            httpMethod: record.httpMethod ?? undefined,
            dataClassification: record.dataClassification ?? undefined,
            retentionDays: record.retentionDays,
        };
    }
}
