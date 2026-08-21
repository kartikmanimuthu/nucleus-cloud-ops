import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getSessionUserEmail } from '@/lib/auth-session';
import { SpotGuardService, SpotGuardErrors } from '@/lib/spot-guard-service';

// GET /api/spot-guard/services/[id] — service detail + recent timeline
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const authError = await authorize('read', 'SpotGuard');
    if (authError) return authError;

    try {
        const { id } = await params;
        const data = await SpotGuardService.getServiceDetail(id, await getSessionTenantId());
        return NextResponse.json({ success: true, data });
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Failed to fetch service';
        // NOT_FOUND for a cross-tenant id, never 403 — a 403 would confirm the row exists
        // in some other tenant. The repository scopes its lookup, so the two cases are
        // indistinguishable from here by design.
        if (msg === SpotGuardErrors.NOT_FOUND) {
            return NextResponse.json({ success: false, error: 'Service not found' }, { status: 404 });
        }
        console.error('API - Error fetching spot-guard service:', error);
        return NextResponse.json({ success: false, error: msg }, { status: 500 });
    }
}

// Zod 4: read .issues, never .errors.
const PatchSchema = z.object({
    managementState: z.enum(['managed', 'unmanaged', 'opted_out']),
});

/**
 * PATCH /api/spot-guard/services/[id] — change management state only.
 *
 * This is the NON-MUTATING off-ramp: it changes whether Nucleus automates the service and
 * touches nothing in AWS. Use POST .../disable to actually move the service off Spot.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const authError = await authorize('update', 'SpotGuard');
    if (authError) return authError;

    try {
        const { id } = await params;
        const parsed = PatchSchema.safeParse(await request.json().catch(() => ({})));
        if (!parsed.success) {
            return NextResponse.json(
                { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid request' },
                { status: 400 },
            );
        }

        const data = await SpotGuardService.setManagementState(
            await getSessionTenantId(),
            id,
            parsed.data.managementState,
            await getSessionUserEmail(),
        );
        return NextResponse.json({ success: true, data });
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Failed to update service';
        if (msg === SpotGuardErrors.NOT_FOUND) {
            return NextResponse.json({ success: false, error: 'Service not found' }, { status: 404 });
        }
        console.error('API - Error updating spot-guard service:', error);
        return NextResponse.json({ success: false, error: msg }, { status: 500 });
    }
}

// DELETE /api/spot-guard/services/[id] — drop the registry row. AWS is untouched.
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const authError = await authorize('delete', 'SpotGuard');
    if (authError) return authError;

    try {
        const { id } = await params;
        const { getSpotGuardRepository } = await import('@/lib/db/repository-factory');
        await getSpotGuardRepository().deleteService(id, await getSessionTenantId());
        return NextResponse.json({ success: true, data: { id } });
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Failed to delete service';
        if (msg === SpotGuardErrors.NOT_FOUND) {
            return NextResponse.json({ success: false, error: 'Service not found' }, { status: 404 });
        }
        console.error('API - Error deleting spot-guard service:', error);
        return NextResponse.json({ success: false, error: msg }, { status: 500 });
    }
}
