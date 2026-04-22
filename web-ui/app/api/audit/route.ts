// API route for fetching audit logs
import { NextRequest, NextResponse } from 'next/server';
import { AuditService, AuditLogFilters } from '@/lib/audit-service';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';

export async function GET(request: NextRequest) {
    // Authorization check
    const authError = await authorize('read', 'AuditLog');
    if (authError) return authError;

    try {
        const { searchParams } = new URL(request.url);

        // Build filters from query parameters
        const filters: AuditLogFilters = {};

        if (searchParams.get('startDate')) filters.startDate = searchParams.get('startDate')!;
        if (searchParams.get('endDate')) filters.endDate = searchParams.get('endDate')!;
        if (searchParams.get('eventType')) filters.eventType = searchParams.get('eventType')!;
        if (searchParams.get('status')) filters.status = searchParams.get('status')!;
        if (searchParams.get('severity')) filters.severity = searchParams.get('severity')!;
        if (searchParams.get('userType')) filters.userType = searchParams.get('userType')!;
        if (searchParams.get('resourceType')) filters.resourceType = searchParams.get('resourceType')!;
        if (searchParams.get('user')) filters.user = searchParams.get('user')!;
        if (searchParams.get('correlationId')) filters.correlationId = searchParams.get('correlationId')!;
        if (searchParams.get('executionId')) filters.executionId = searchParams.get('executionId')!;
        if (searchParams.get('resourceId')) filters.resourceId = searchParams.get('resourceId')!;
        if (searchParams.get('ipAddress')) filters.ipAddress = searchParams.get('ipAddress')!;
        if (searchParams.get('source')) filters.source = searchParams.get('source')!;
        if (searchParams.get('searchTerm')) filters.searchTerm = searchParams.get('searchTerm')!;
        if (searchParams.get('limit')) filters.limit = parseInt(searchParams.get('limit')!);
        if (searchParams.get('nextPageToken')) filters.nextPageToken = searchParams.get('nextPageToken')!;

        console.log('API - Fetching audit logs with filters:', filters);

        const tenantId = await getSessionTenantId();
        const { logs, nextPageToken } = await AuditService.getAuditLogs(filters, tenantId);

        return NextResponse.json({
            success: true,
            data: logs,
            nextPageToken,
            count: logs.length,
        });
    } catch (error: unknown) {
        console.error('API - Error fetching audit logs:', error);
        return NextResponse.json(
            {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to fetch audit logs',
            },
            { status: 500 }
        );
    }
}

export async function POST(request: NextRequest) {
    try {
        const auditData = await request.json();

        // Extract user info from headers (if available)
        const userAgent = request.headers.get('user-agent') || 'Unknown';
        const ipAddress = request.headers.get('x-forwarded-for') ||
            request.headers.get('x-real-ip') ||
            'unknown';

        const tenantId = await getSessionTenantId();

        // Add audit log
        await AuditService.createAuditLog({
            ...auditData,
            tenantId,
            userAgent,
            ipAddress,
            source: 'platform',
        });

        return NextResponse.json({
            success: true,
            message: 'Audit log created successfully',
        });
    } catch (error: unknown) {
        console.error('API - Error creating audit log:', error);
        return NextResponse.json(
            {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to create audit log',
            },
            { status: 500 }
        );
    }
}

export async function DELETE() {
    return NextResponse.json(
        { success: false, error: 'Audit log deletion is not supported — logs are immutable with TTL-based expiry' },
        { status: 501 }
    );
}
