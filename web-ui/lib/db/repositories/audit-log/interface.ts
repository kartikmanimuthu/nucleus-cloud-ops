/**
 * IAuditLogRepository
 *
 * Contract for audit log persistence.
 * Implemented by AuditLogDynamoRepository and AuditLogPostgresRepository.
 * The feature flag USE_PG_AUDIT_LOGS controls which implementation is active.
 */
import type { AuditLog } from '@/lib/types';
import type { AuditLogFilters, AuditLogResponse } from '@/lib/audit-service';

export interface IAuditLogRepository {
    /**
     * Create a new audit log entry.
     * Fire-and-forget: errors are swallowed to prevent disrupting the main flow.
     */
    createAuditLog(auditData: Omit<AuditLog, 'id' | 'type' | 'timestamp'>): Promise<void>;
    getAuditLogs(tenantId: string, filters?: AuditLogFilters): Promise<AuditLogResponse>;
}
