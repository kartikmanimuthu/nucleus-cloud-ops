import { NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { RightSizingService } from '@/lib/right-sizing-service';

// GET /api/right-sizing/summary — aggregates for KPI cards
export async function GET() {
    const authError = await authorize('read', 'RightSizing');
    if (authError) return authError;
    try {
        const summary = await RightSizingService.getSummary(await getSessionTenantId());
        return NextResponse.json({ success: true, data: summary });
    } catch (error: unknown) {
        console.error('API - Error fetching right-sizing summary:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to fetch summary' },
            { status: 500 }
        );
    }
}
