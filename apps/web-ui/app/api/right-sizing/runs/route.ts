import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getSessionUserId } from '@/lib/auth-session';
import { isRightSizingEnabled } from '@/lib/right-sizing/feature-flag';
import { RightSizingService } from '@/lib/right-sizing-service';

// GET /api/right-sizing/runs — run history
export async function GET(request: NextRequest) {
    const authError = await authorize('read', 'RightSizing');
    if (authError) return authError;
    try {
        if (!isRightSizingEnabled()) {
            return NextResponse.json({ success: true, data: [], meta: { total: 0, page: 1, limit: 0 } });
        }
        const { searchParams } = new URL(request.url);
        const page = parseInt(searchParams.get('page') || '1', 10);
        const limit = parseInt(searchParams.get('limit') || '20', 10);
        const { runs, total } = await RightSizingService.listRuns(await getSessionTenantId(), page, limit);
        return NextResponse.json({ success: true, data: runs, meta: { total, page, limit } });
    } catch (error: unknown) {
        console.error('API - Error fetching right-sizing runs:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to fetch runs' },
            { status: 500 }
        );
    }
}

// POST /api/right-sizing/runs — trigger on-demand scan
export async function POST() {
    const authError = await authorize('update', 'RightSizing');
    if (authError) return authError;
    try {
        if (!isRightSizingEnabled()) {
            return NextResponse.json({ success: false, error: 'Right Sizing is not enabled' }, { status: 400 });
        }
        const tenantId = await getSessionTenantId();
        const userId = await getSessionUserId();
        const { run, alreadyRunning } = await RightSizingService.triggerScan(tenantId, userId);
        return NextResponse.json({ success: true, data: run, alreadyRunning }, { status: alreadyRunning ? 200 : 202 });
    } catch (error: unknown) {
        console.error('API - Error triggering right-sizing scan:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to trigger scan' },
            { status: 500 }
        );
    }
}
