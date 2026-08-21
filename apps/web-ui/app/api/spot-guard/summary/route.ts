import { NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { SpotGuardService } from '@/lib/spot-guard-service';

// GET /api/spot-guard/summary — KPI tiles for the Spot Guard page
export async function GET() {
    const authError = await authorize('read', 'SpotGuard');
    if (authError) return authError;

    try {
        const data = await SpotGuardService.getSummary(await getSessionTenantId());
        return NextResponse.json({ success: true, data });
    } catch (error: unknown) {
        console.error('API - Error fetching spot-guard summary:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to fetch summary' },
            { status: 500 },
        );
    }
}
