import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getSessionUserId } from '@/lib/auth-session';
import { RightSizingService } from '@/lib/right-sizing-service';
import type { RecommendationStatus } from '@/lib/db/repositories/right-sizing/interface';

// PATCH /api/right-sizing/recommendations/[id] — approve | dismiss | snooze | open
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const authError = await authorize('update', 'RightSizing');
    if (authError) return authError;

    try {
        const { id } = await params;
        const body = await request.json().catch(() => ({}));
        const status = body.status as RecommendationStatus | undefined;
        if (!status) {
            return NextResponse.json({ success: false, error: 'status is required' }, { status: 400 });
        }
        const snoozeUntil = body.snoozeUntil ? new Date(body.snoozeUntil) : null;
        const tenantId = await getSessionTenantId();
        const userId = await getSessionUserId();

        const updated = await RightSizingService.updateStatus(id, tenantId, status, userId, snoozeUntil);
        return NextResponse.json({ success: true, data: updated });
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Failed to update recommendation';
        if (msg === 'NOT_FOUND') {
            // Don't distinguish "not yours" from "doesn't exist" — avoid cross-tenant leak.
            return NextResponse.json({ success: false, error: 'Recommendation not found' }, { status: 404 });
        }
        const status = msg.includes('not supported') || msg.startsWith('Invalid status') ? 400 : 500;
        console.error('API - Error updating right-sizing recommendation:', error);
        return NextResponse.json({ success: false, error: msg }, { status });
    }
}
