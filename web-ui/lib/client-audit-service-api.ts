// Client-safe audit service that uses API routes instead of direct AWS SDK calls
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

export class ClientAuditService {
    private static baseUrl = '/api/audit';
    private static statsUrl = '/api/audit/stats';

    /**
     * Fetch audit logs via API route
     */
    static async getAuditLogs(filters: AuditLogFilters = {}): Promise<AuditLogResponse> {
        try {
            console.log('ClientAuditService - Fetching audit logs via API route');

            // Build query string from filters
            const queryParams = new URLSearchParams();
            Object.entries(filters).forEach(([key, value]) => {
                if (value !== undefined && value !== null && value !== '') {
                    queryParams.append(key, value.toString());
                }
            });

            const url = queryParams.toString()
                ? `${this.baseUrl}?${queryParams.toString()}`
                : this.baseUrl;

            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                },
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error || `HTTP error! status: ${response.status}`);
            }

            if (!result.success) {
                throw new Error(result.error || 'Failed to fetch audit logs');
            }

            console.log('ClientAuditService - Successfully fetched audit logs:', result.data.length);
            return {
                logs: result.data,
                nextPageToken: result.nextPageToken
            };
        } catch (error) {
            console.error('ClientAuditService - Error fetching audit logs:', error);
            throw error;
        }
    }

    /**
     * Get audit log statistics via API route
     */
    static async getAuditLogStats(filters: AuditLogFilters = {}): Promise<AuditLogStats> {
        try {
            console.log('ClientAuditService - Fetching audit log stats via API route');

            // Build query string from filters
            const queryParams = new URLSearchParams();
            Object.entries(filters).forEach(([key, value]) => {
                if (value !== undefined && value !== null && value !== '') {
                    queryParams.append(key, value.toString());
                }
            });

            const url = queryParams.toString()
                ? `${this.statsUrl}?${queryParams.toString()}`
                : this.statsUrl;

            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                },
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error || `HTTP error! status: ${response.status}`);
            }

            if (!result.success) {
                throw new Error(result.error || 'Failed to fetch audit log stats');
            }

            console.log('ClientAuditService - Successfully fetched audit log stats');
            return result.data;
        } catch (error) {
            console.error('ClientAuditService - Error fetching audit log stats:', error);
            throw error;
        }
    }

    /**
     * Get audit logs by correlation ID via API route
     */
    static async getAuditLogsByCorrelationId(correlationId: string): Promise<AuditLog[]> {
        try {
            console.log('ClientAuditService - Fetching audit logs by correlation ID via API route:', correlationId);

            const response = await fetch(`${this.baseUrl}/correlation/${encodeURIComponent(correlationId)}`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                },
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error || `HTTP error! status: ${response.status}`);
            }

            if (!result.success) {
                throw new Error(result.error || 'Failed to fetch audit logs by correlation ID');
            }

            console.log('ClientAuditService - Successfully fetched audit logs by correlation ID:', result.data.length);
            return result.data;
        } catch (error) {
            console.error('ClientAuditService - Error fetching audit logs by correlation ID:', error);
            throw error;
        }
    }

    /**
     * Create a new audit log entry via API route
     */
    static async logUserAction(auditData: {
        action: string;
        resourceType: string;
        resourceId: string;
        resourceName?: string;
        user: string;
        userType: string;
        status: 'success' | 'error' | 'warning';
        details?: string;
        metadata?: Record<string, any>;
        correlationId?: string;
        severity?: 'low' | 'medium' | 'high' | 'critical';
    }): Promise<void> {
        try {
            console.log('ClientAuditService - Creating audit log via API route');

            const response = await fetch(this.baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(auditData),
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error || `HTTP error! status: ${response.status}`);
            }

            if (!result.success) {
                throw new Error(result.error || 'Failed to create audit log');
            }

            console.log('ClientAuditService - Successfully created audit log');
        } catch (error) {
            console.error('ClientAuditService - Error creating audit log:', error);
            throw error;
        }
    }
}
