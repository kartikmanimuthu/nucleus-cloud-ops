import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { DashboardService } from '@/lib/dashboard-service';
import type { TimeRange } from '@/lib/dashboard-types';

const VALID_RANGES = new Set<TimeRange>(['24h', '7d', '30d', '90d']);

export async function GET(request: NextRequest) {
  const authError = await authorize('read', 'Schedule');
  if (authError) return authError;

  try {
    const tenantId = await getSessionTenantId();
    const range = (request.nextUrl.searchParams.get('range') || '24h') as TimeRange;
    if (!VALID_RANGES.has(range)) {
      return NextResponse.json({ success: false, error: 'Invalid range' }, { status: 400 });
    }

    const data = await DashboardService.getCostMetrics(tenantId, range);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error('API - GET /api/dashboard/cost error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to fetch cost metrics' },
      { status: 500 }
    );
  }
}
