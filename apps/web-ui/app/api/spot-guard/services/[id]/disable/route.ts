import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getSessionUserEmail } from '@/lib/auth-session';
import { SpotGuardService, SpotGuardErrors } from '@/lib/spot-guard-service';

/**
 * POST /api/spot-guard/services/[id]/disable
 *
 * Moves the service to 100% On-Demand in AWS and marks it opted_out so the hourly job never
 * restores it. Same confirmation gate as enable, because this is also a live capacity change
 * that bounces every task via forceNewDeployment.
 *
 * For "stop automating but leave AWS alone", use PATCH .../services/[id] with
 * managementState: 'unmanaged' instead — the two answer different questions.
 */
const DisableSchema = z.object({
    confirm: z.literal(true),
    confirmServiceName: z.string().min(1),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const authError = await authorize('update', 'SpotGuard');
    if (authError) return authError;

    try {
        const { id } = await params;
        const parsed = DisableSchema.safeParse(await request.json().catch(() => ({})));
        if (!parsed.success) {
            return NextResponse.json(
                { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid request' },
                { status: 400 },
            );
        }

        const data = await SpotGuardService.disableSpot(
            await getSessionTenantId(),
            id,
            await getSessionUserEmail(),
            parsed.data,
        );
        return NextResponse.json({ success: true, data }, { status: 202 });
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Failed to disable Spot';
        console.error('API - Error disabling Spot:', error);

        if (msg === SpotGuardErrors.NOT_FOUND) {
            return NextResponse.json({ success: false, error: 'Service not found' }, { status: 404 });
        }
        if (msg === SpotGuardErrors.CONFIRMATION_MISMATCH) {
            return NextResponse.json(
                { success: false, error: 'The service name you typed does not match this service.' },
                { status: 400 },
            );
        }
        if (msg === SpotGuardErrors.SERVICE_NOT_IN_AWS) {
            return NextResponse.json(
                { success: false, error: 'This service no longer exists in AWS.' },
                { status: 409 },
            );
        }
        if (msg === SpotGuardErrors.DEPLOYMENT_IN_PROGRESS) {
            return NextResponse.json(
                { success: false, error: 'A deployment is already in progress for this service.' },
                { status: 409 },
            );
        }
        if (msg === SpotGuardErrors.ACCOUNT_NOT_FOUND) {
            return NextResponse.json(
                { success: false, error: 'The AWS account for this service is not connected.' },
                { status: 409 },
            );
        }
        return NextResponse.json({ success: false, error: msg }, { status: 500 });
    }
}
