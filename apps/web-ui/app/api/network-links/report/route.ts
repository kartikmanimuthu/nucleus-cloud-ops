import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { NetworkLinksService } from '@/lib/network-links-service';
import { buildNetworkAvailabilityReport } from '@/lib/network-availability-report';
import { istDayStart, istDayEndExclusive } from '@/lib/ist-date-range';

// GET /api/network-links/report — Direct Connect & VPN compliance report for
// an explicit [dateFrom, dateTo] window. Reuses the ScalingAudit RBAC subject
// (Scale Sentinel's existing read gate) rather than minting a new one.
export async function GET(request: NextRequest) {
    const authError = await authorize('read', 'ScalingAudit');
    if (authError) return authError;

    try {
        const { searchParams } = new URL(request.url);
        const dateFrom = searchParams.get('dateFrom');
        const dateTo = searchParams.get('dateTo');
        if (!dateFrom || !dateTo) {
            return NextResponse.json(
                { success: false, error: 'dateFrom and dateTo are required' },
                { status: 400 }
            );
        }

        const tenantId = await getSessionTenantId();
        const samples = await NetworkLinksService.listSamples(tenantId, {
            accountId: searchParams.get('account') || undefined,
            region: searchParams.get('region') || undefined,
            dateFrom,
            dateTo,
        });
        const rows = buildNetworkAvailabilityReport(samples, istDayStart(dateFrom), istDayEndExclusive(dateTo));

        return NextResponse.json({ success: true, data: rows }, { status: 200 });
    } catch (error: unknown) {
        console.error('API - Error building network availability report:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to build network availability report' },
            { status: 500 }
        );
    }
}
