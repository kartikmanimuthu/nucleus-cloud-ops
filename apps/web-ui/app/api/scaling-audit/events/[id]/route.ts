import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { ScalingAuditService } from '@/lib/scaling-audit-service';

// GET /api/scaling-audit/events/[id] — full detail (raw cause + rawPayload) for the details dialog
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const authError = await authorize('read', 'ScalingAudit');
    if (authError) return authError;

    try {
        const { id } = await params;
        const event = await ScalingAuditService.getEvent(id, await getSessionTenantId());
        if (!event) {
            return NextResponse.json({ success: false, error: 'Scaling event not found' }, { status: 404 });
        }
        return NextResponse.json({ success: true, data: event });
    } catch (error: unknown) {
        console.error('API - Error fetching scaling audit event:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to fetch scaling event' },
            { status: 500 }
        );
    }
}
