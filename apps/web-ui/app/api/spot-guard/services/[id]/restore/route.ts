import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getSessionUserEmail } from '@/lib/auth-session';
import { SpotGuardService } from '@/lib/spot-guard-service';

/**
 * POST /api/spot-guard/services/[id]/restore — "Restore now".
 *
 * Enqueues a forced restore pass rather than mutating AWS inline, so it goes through the same
 * worker path (and the same seven safety gates) as the hourly job. `force` bypasses ONLY the
 * backoff: scheduler protection, governance, in-flight-deployment and the daily restore cap
 * all still apply, which is why this needs no confirmation gate — the worker can still refuse.
 *
 * No confirmation is required precisely because this cannot force an unsafe change; contrast
 * enable/disable, which apply a strategy directly.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const authError = await authorize('update', 'SpotGuard');
    if (authError) return authError;

    try {
        const { id } = await params;
        const { jobId } = await SpotGuardService.triggerRestore(
            await getSessionTenantId(),
            await getSessionUserEmail(),
            [id],
        );

        // 200 when a pass was already queued/active for this tenant (the per-tenant
        // singleton collapsed it), 202 when a new job was created. The client can tell the
        // difference and word its toast accordingly.
        return NextResponse.json(
            { success: true, data: { jobId, alreadyQueued: jobId === null } },
            { status: jobId === null ? 200 : 202 },
        );
    } catch (error: unknown) {
        console.error('API - Error triggering spot-guard restore:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to trigger restore' },
            { status: 500 },
        );
    }
}
