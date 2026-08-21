import { NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { ScalingAuditService } from '@/lib/scaling-audit-service';

// GET /api/scaling-audit/coverage — open watermark gaps, for the coverage/gap banner.
// A gap here means "we could not confirm completeness for this window" — the UI
// must render it, never silently omit it (see the module's reporting rule).
export async function GET() {
    const authError = await authorize('read', 'ScalingAudit');
    if (authError) return authError;
    try {
        const gaps = await ScalingAuditService.getWatermarkGaps(await getSessionTenantId());
        return NextResponse.json({ success: true, data: gaps });
    } catch (error: unknown) {
        console.error('API - Error fetching scaling audit coverage gaps:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to fetch coverage gaps' },
            { status: 500 }
        );
    }
}
