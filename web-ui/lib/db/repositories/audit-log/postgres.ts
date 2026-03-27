/**
 * AuditLogPostgresRepository
 *
 * PostgreSQL implementation of IAuditLogRepository using Prisma ORM.
 * Reads/writes the `audit_logs` table (defined in prisma/schema.prisma).
 *
 * Key differences vs DynamoDB path:
 * - expiresAt (DateTime) replaces DynamoDB TTL — set to now + 30 days on insert (audit retention)
 * - tenantId scoping on every query (DynamoDB audit table has no tenant filter)
 * - Server-side filtering for eventType, status, severity, user
 * - createAuditLog is fire-and-forget (errors swallowed)
 *
 * Multi-tenant safety: every query is scoped by tenantId — no cross-tenant data access.
 */
import { getPrismaClient } from '@/lib/db/pg-config';
import type { AuditLog } from '@/lib/types';
import type { AuditLogFilters, AuditLogResponse } from '@/lib/audit-service';
import type { IAuditLogRepository } from './interface';

// 30 days in milliseconds — matches DynamoDB TTL retention policy
const AUDIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export class AuditLogPostgresRepository implements IAuditLogRepository {
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

            const logId = `log-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            const expiresAt = new Date(Date.now() + AUDIT_TTL_MS);

            // tenantId is required for multi-tenant PostgreSQL; fall back to 'org-default'
            // for backward compatibility with callers that don't pass tenantId
            const tenantId = (auditData as Record<string, unknown>).tenantId as string | undefined
                ?? 'org-default';

            await getPrismaClient().auditLog.create({
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
            if (filters?.resourceType) {
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

            const rows = await getPrismaClient().auditLog.findMany({
                where,
                orderBy: { timestamp: 'desc' },
                take: limit,
            });

            return {
                logs: rows.map((r) => this.transformToAuditLog(r)),
            };
        } catch (error: unknown) {
            console.error('[AuditLogPostgresRepository] Error fetching audit logs:', error);
            return { logs: [] };
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
        };
    }
}
