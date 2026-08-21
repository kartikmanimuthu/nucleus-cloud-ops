import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { SpotGuardService } from '@/lib/spot-guard-service';

const MAX_RANGE_DAYS = 92;

// GET /api/spot-guard/report?from=&to= — Spot vs On-Demand hours
export async function GET(request: NextRequest) {
    const authError = await authorize('read', 'SpotGuard');
    if (authError) return authError;

    try {
        const { searchParams } = new URL(request.url);
        const now = new Date();

        const to = searchParams.get('to') ? new Date(searchParams.get('to')!) : now;
        const from = searchParams.get('from')
            ? new Date(searchParams.get('from')!)
            : new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);

        if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
            return NextResponse.json({ success: false, error: 'Invalid from/to date' }, { status: 400 });
        }
        if (from >= to) {
            return NextResponse.json({ success: false, error: '`from` must be before `to`' }, { status: 400 });
        }
        // Bounded window: sessions are retained 90 days, so a wider range would silently
        // report a partial answer as if it were complete.
        const days = (to.getTime() - from.getTime()) / 86_400_000;
        if (days > MAX_RANGE_DAYS) {
            return NextResponse.json(
                { success: false, error: `Range too large: ${Math.round(days)} days requested, ${MAX_RANGE_DAYS} maximum (sessions are retained 90 days).` },
                { status: 400 },
            );
        }

        const data = await SpotGuardService.getHoursReport(await getSessionTenantId(), { from, to });
        return NextResponse.json({ success: true, data });
    } catch (error: unknown) {
        console.error('API - Error fetching spot-guard report:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to fetch report' },
            { status: 500 },
        );
    }
}
