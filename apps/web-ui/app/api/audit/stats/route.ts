// API route for fetching audit log statistics
import { NextRequest, NextResponse } from 'next/server';
import { AuditService, AuditLogFilters } from '@/lib/audit-service';
import { getSessionTenantId } from '@/lib/auth-session';
import type { RouteAuthz } from '@nucleus/rbac';

/** Layer 1 permission declaration — see lib/rbac/rbac-allowlist.ts for the public set. */
export const authz: RouteAuthz = {
    GET: { action: 'read', subject: 'AuditLog' },
};

export async function GET(request: NextRequest) {
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
        if (searchParams.get('limit')) filters.limit = parseInt(searchParams.get('limit')!);

        console.log('API - Fetching audit log stats with filters:', filters);

        const tenantId = await getSessionTenantId();
        const stats = await AuditService.getAuditLogStats(filters, tenantId);

        return NextResponse.json(
            { success: true, data: stats },
            { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' } }
        );
    } catch (error: unknown) {
        console.error('API - Error fetching audit log stats:', error);
        return NextResponse.json(
            {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to fetch audit log statistics',
            },
            { status: 500 }
        );
    }
}
