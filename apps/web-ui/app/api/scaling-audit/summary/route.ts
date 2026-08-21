import { NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { ScalingAuditService } from '@/lib/scaling-audit-service';

// GET /api/scaling-audit/summary — aggregates for KPI cards + filter facets
export async function GET() {
    const authError = await authorize('read', 'ScalingAudit');
    if (authError) return authError;
    try {
        const tenantId = await getSessionTenantId();
        const [summary, facets] = await Promise.all([
            ScalingAuditService.getSummary(tenantId),
            ScalingAuditService.getFacets(tenantId),
        ]);
        return NextResponse.json({ success: true, data: { ...summary, facets } });
    } catch (error: unknown) {
        console.error('API - Error fetching scaling audit summary:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to fetch summary' },
            { status: 500 }
        );
    }
}
