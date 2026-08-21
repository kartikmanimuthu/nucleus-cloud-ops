import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getSessionUserId } from '@/lib/auth-session';
import { CapacityPlanningService } from '@/lib/capacity-planning-service';

// GET /api/capacity-planning/runs — run history
export async function GET(request: NextRequest) {
    const authError = await authorize('read', 'ScalingAudit');
    if (authError) return authError;
    try {
        const { searchParams } = new URL(request.url);
        const page = parseInt(searchParams.get('page') || '1', 10);
        const limit = parseInt(searchParams.get('limit') || '20', 10);
        const { runs, total } = await CapacityPlanningService.listRuns(await getSessionTenantId(), page, limit);
        return NextResponse.json({ success: true, data: runs, meta: { total, page, limit } });
    } catch (error: unknown) {
        console.error('API - Error fetching capacity planning runs:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to fetch runs' },
            { status: 500 }
        );
    }
}

// POST /api/capacity-planning/runs — trigger on-demand scan
export async function POST() {
    const authError = await authorize('update', 'ScalingAudit');
    if (authError) return authError;
    try {
        const tenantId = await getSessionTenantId();
        const userId = await getSessionUserId();
        const { alreadyRunning } = await CapacityPlanningService.triggerScan(tenantId, userId);
        return NextResponse.json({ success: true, alreadyRunning }, { status: alreadyRunning ? 200 : 202 });
    } catch (error: unknown) {
        console.error('API - Error triggering capacity planning scan:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to trigger scan' },
            { status: 500 }
        );
    }
}
