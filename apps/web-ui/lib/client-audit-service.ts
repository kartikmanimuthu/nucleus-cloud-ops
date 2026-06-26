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
    searchTerm?: string;
    limit?: number;
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

    /**
     * Fetch audit logs via API route
     */
    static async getAuditLogs(filters?: AuditLogFilters): Promise<AuditLog[]> {
        try {
            console.log('ClientAuditService - Fetching audit logs via API', filters);

            const params = new URLSearchParams();
            if (filters) {
                Object.entries(filters).forEach(([key, value]) => {
                    if (value !== undefined && value !== null) {
                        params.append(key, value.toString());
                    }
                });
            }

            const url = params.toString() ? `${this.baseUrl}?${params.toString()}` : this.baseUrl;
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                },
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const result = await response.json();

            if (!result.success) {
                throw new Error(result.error || 'Failed to fetch audit logs');
            }

            return result.data;
        } catch (error) {
            console.error('ClientAuditService - Error fetching audit logs:', error);
            throw error;
        }
    }

    /**
     * Fetch audit log stats via API route
     */
    static async getAuditLogStats(filters?: AuditLogFilters): Promise<AuditLogStats> {
        try {
            console.log('ClientAuditService - Fetching audit log stats via API', filters);

            const params = new URLSearchParams();
            if (filters) {
                Object.entries(filters).forEach(([key, value]) => {
                    if (value !== undefined && value !== null) {
                        params.append(key, value.toString());
                    }
                });
            }

            const url = params.toString() ? `${this.baseUrl}/stats?${params.toString()}` : `${this.baseUrl}/stats`;
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                },
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const result = await response.json();

            if (!result.success) {
                throw new Error(result.error || 'Failed to fetch audit log stats');
            }

            return result.data;
        } catch (error) {
            console.error('ClientAuditService - Error fetching audit log stats:', error);
            throw error;
        }
    }

    /**
     * Create a new audit log via API route
     */
    static async logUserAction(auditData: {
        action: string;
        resourceType: string;
        resourceId: string;
        resourceName?: string;
        user: string;
        userType: 'user' | 'admin' | 'system';
        status: 'success' | 'error' | 'warning';
        details?: string;
        metadata?: Record<string, any>;
        correlationId?: string;
        severity?: 'low' | 'medium' | 'high' | 'critical';
    }): Promise<void> {
        try {
            console.log('ClientAuditService - Logging user action via API');

            const response = await fetch(this.baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(auditData),
            });

            const result = await response.json();

            if (!response.ok) {
                console.error('ClientAuditService - Failed to log action:', result.error);
            }
        } catch (error) {
            console.error('ClientAuditService - Error logging action:', error);
            // We generally don't throw here to avoid disrupting user flow for audit logging
        }
    }
}
