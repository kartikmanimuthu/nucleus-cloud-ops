import { NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { DashboardService } from '@/lib/dashboard-service';

export async function GET() {
  const authError = await authorize('read', 'KnowledgeBase');
  if (authError) return authError;

  try {
    const tenantId = await getSessionTenantId();
    const data = await DashboardService.getKnowledgeBaseMetrics(tenantId);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error('API - GET /api/dashboard/knowledge-base error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to fetch knowledge base metrics' },
      { status: 500 }
    );
  }
}
