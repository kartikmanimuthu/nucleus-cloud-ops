// API route for fetching correlated audit logs
import { NextRequest, NextResponse } from 'next/server';
import { AuditService } from '@/lib/audit-service';
import { getSessionTenantId } from '@/lib/auth-session';

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ correlationId: string }> }
) {
    try {
        const { correlationId } = await params;

        if (!correlationId) {
            return NextResponse.json(
                {
                    success: false,
                    error: 'Correlation ID is required',
                },
                { status: 400 }
            );
        }

        console.log('API - Fetching correlated audit logs for:', correlationId);

        const tenantId = await getSessionTenantId();
        const auditLogs = await AuditService.getAuditLogsByCorrelation(correlationId, tenantId);

        return NextResponse.json({
            success: true,
            data: auditLogs,
            count: auditLogs.length,
        });
    } catch (error: unknown) {
        console.error('API - Error fetching correlated audit logs:', error);
        return NextResponse.json(
            {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to fetch correlated audit logs',
            },
            { status: 500 }
        );
    }
}
