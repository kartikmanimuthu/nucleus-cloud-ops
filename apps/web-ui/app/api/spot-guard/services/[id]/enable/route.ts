import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getSessionUserEmail } from '@/lib/auth-session';
import { SpotGuardService, SpotGuardErrors } from '@/lib/spot-guard-service';

/**
 * POST /api/spot-guard/services/[id]/enable
 *
 * Puts an ECS service onto Fargate Spot. This is the one endpoint that newly moves
 * production traffic onto interruptible capacity, so it is the most heavily gated:
 * RBAC `update` on SpotGuard (which maps to Schedules, not Inventory), a typed
 * confirmation, and a live pre-flight against AWS in the service layer.
 *
 * `id` may be either an existing registry row id or the composite
 * `accountId:region:clusterName:serviceName` for a service discovered from inventory that
 * Nucleus has never managed — which is what lets the first opt-in happen straight from the
 * eligible-services list without a separate "register" step.
 */
const EnableSchema = z.object({
    // z.literal(true), not z.boolean(): a missing or false field must be a 400, never a
    // silent proceed.
    confirm: z.literal(true),
    /**
     * The user must type the service name. A plain boolean flag would let a replayed or
     * scripted POST flip a service the caller never looked at; echoing the name proves they
     * are acting on the service they think they are.
     */
    confirmServiceName: z.string().min(1),
    spotWeight: z.number().int().min(1).max(1000).optional(),
    // 0 = Spot-only (the default). >0 blends, and the pair is a RATIO, not percentages: 50/50
    // and 1/1 behave identically. The UI presents them as percentages because that is how
    // operators think about it, and equal numbers give the intended split either way.
    onDemandWeight: z.number().int().min(0).max(1000).optional(),
    onDemandBase: z.number().int().min(0).max(100).optional(),
});

/** Composite ids from the eligible list look like acct:region:cluster:service. */
function parseTarget(id: string) {
    const parts = id.split(':');
    if (parts.length === 4 && /^\d{12}$/.test(parts[0])) {
        return {
            kind: 'discovered' as const,
            accountId: parts[0],
            region: parts[1],
            clusterName: parts[2],
            serviceName: parts[3],
        };
    }
    return { kind: 'registry' as const, id };
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const authError = await authorize('update', 'SpotGuard');
    if (authError) return authError;

    try {
        const { id } = await params;
        const parsed = EnableSchema.safeParse(await request.json().catch(() => ({})));
        if (!parsed.success) {
            // Zod 4 → .issues (not .errors).
            return NextResponse.json(
                { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid request' },
                { status: 400 },
            );
        }

        const data = await SpotGuardService.enableSpot(
            await getSessionTenantId(),
            parseTarget(id),
            await getSessionUserEmail(),
            parsed.data,
        );
        // 202: the UpdateService call has been accepted but the ECS rolling deployment is
        // still in flight when we respond.
        return NextResponse.json({ success: true, data }, { status: 202 });
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Failed to enable Spot';
        console.error('API - Error enabling Spot:', error);

        // 404 for a cross-tenant or unknown target — never 403, which would confirm the row
        // exists in another tenant.
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
                { success: false, error: 'This service no longer exists in AWS. Run a discovery scan to refresh.' },
                { status: 409 },
            );
        }
        if (msg === SpotGuardErrors.DEPLOYMENT_IN_PROGRESS) {
            return NextResponse.json(
                { success: false, error: 'A deployment is already in progress for this service. Try again once it completes.' },
                { status: 409 },
            );
        }
        if (msg.startsWith(SpotGuardErrors.NO_SPOT_CAPACITY_PROVIDER)) {
            // Carries the cluster's real provider list, so the message is actionable rather
            // than just "failed".
            return NextResponse.json({ success: false, error: msg }, { status: 409 });
        }
        if (msg === SpotGuardErrors.ACCOUNT_NOT_FOUND) {
            return NextResponse.json(
                { success: false, error: 'The AWS account for this service is not connected.' },
                { status: 409 },
            );
        }
        if (msg === SpotGuardErrors.SPOT_AUTOMATION_DISABLED) {
            return NextResponse.json(
                {
                    success: false,
                    error:
                        'Spot automation is disabled for this account, so Nucleus will not restore or handle interruptions here. Enabling Spot would move this service onto interruptible capacity with no automated safety net. Turn on Spot Automation for the account first, in Accounts settings.',
                },
                { status: 409 },
            );
        }
        return NextResponse.json({ success: false, error: msg }, { status: 500 });
    }
}
