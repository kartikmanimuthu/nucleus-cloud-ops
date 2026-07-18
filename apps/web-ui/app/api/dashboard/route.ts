/**
 * Consolidated dashboard API
 *
 * Single entry point for all dashboard zones. The `zone` query parameter selects
 * which metric bucket to return; `range` controls the time window for zones that
 * support it.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { DashboardService } from '@/lib/dashboard-service';
import type { TimeRange } from '@/lib/dashboard-types';

const VALID_RANGES = new Set<TimeRange>(['24h', '7d', '30d', '90d']);
const VALID_ZONES = new Set<string>([
    'hero',
    'action-center',
    'coverage',
    'cost-automation',
    'agent-activity',
    'inventory',
    'audit',
]);

export async function GET(request: NextRequest) {
    const authError = await authorize('read', 'Dashboard');
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        const searchParams = request.nextUrl.searchParams;
        const zone = searchParams.get('zone') || 'hero';
        const range = (searchParams.get('range') || '24h') as TimeRange;

        if (!VALID_ZONES.has(zone)) {
            return NextResponse.json({ success: false, error: `Unknown dashboard zone: ${zone}` }, { status: 400 });
        }
        if (!VALID_RANGES.has(range)) {
            return NextResponse.json({ success: false, error: 'Invalid range' }, { status: 400 });
        }

        let data: unknown;
        switch (zone) {
            case 'hero':
                data = await DashboardService.getHeroKpis(tenantId, range);
                break;
            case 'action-center':
                data = await DashboardService.getActionCenter(tenantId, range);
                break;
            case 'coverage':
                data = await DashboardService.getCoverage(tenantId);
                break;
            case 'cost-automation':
                data = await DashboardService.getCostAutomation(tenantId, range);
                break;
            case 'agent-activity':
                data = await DashboardService.getAgentActivity(tenantId, range);
                break;
            case 'inventory':
                data = await DashboardService.getInventorySnapshot(tenantId);
                break;
            case 'audit':
                data = await DashboardService.getAuditSnapshot(tenantId, range);
                break;
        }

        return NextResponse.json({ success: true, data });
    } catch (error) {
        console.error('API - GET /api/dashboard error:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to fetch dashboard data' },
            { status: 500 }
        );
    }
}
