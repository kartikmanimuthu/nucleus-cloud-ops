import { NextRequest, NextResponse } from 'next/server';

import { authorize } from '@/lib/rbac/authorize';
import { deleteAction, updateAction } from '@/lib/rbac/registry-admin-writes';

import { mapRegistryError, resolveActor } from '../../_shared';

export const dynamic = 'force-dynamic';

/** DELETE may arrive with no body at all — a JSON parse failure must not become a 500. */
async function readReason(request: NextRequest): Promise<string | undefined> {
    try {
        const body = await request.json();
        return typeof body?.reason === 'string' ? body.reason : undefined;
    } catch {
        return undefined;
    }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ actionId: string }> }) {
    console.log('API - PUT /api/settings/rbac/permissions/[actionId] - Updating permission');
    const authError = await authorize('update', 'IAM');
    if (authError) return authError;

    try {
        const { actionId } = await params;
        const actor = await resolveActor();
        const body = await request.json();
        const reason = typeof body?.reason === 'string' ? body.reason : undefined;

        // Present-but-non-numeric (e.g. "abc", null, {}) must fail as a 400, not
        // reach Prisma as a NaN on an Int column and 500. Omitted is fine — the
        // spread below simply leaves sortOrder out of the patch, unchanged.
        if (body.sortOrder !== undefined && !Number.isFinite(Number(body.sortOrder))) {
            return NextResponse.json({ success: false, error: 'sortOrder must be a number' }, { status: 400 });
        }

        await updateAction(
            actor,
            actionId,
            {
                ...(body.key !== undefined && { key: String(body.key) }),
                ...(body.label !== undefined && { label: String(body.label) }),
                ...(body.description !== undefined && { description: body.description }),
                ...(body.aliasOfKey !== undefined && { aliasOfKey: body.aliasOfKey }),
                ...(body.isDangerous !== undefined && { isDangerous: Boolean(body.isDangerous) }),
                ...(body.sortOrder !== undefined && { sortOrder: Number(body.sortOrder) }),
            },
            reason
        );
        return NextResponse.json({ success: true, data: { id: actionId } });
    } catch (error) {
        console.error('API - Error updating permission:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to update permission' },
            { status: mapRegistryError(error) }
        );
    }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ actionId: string }> }) {
    console.log('API - DELETE /api/settings/rbac/permissions/[actionId] - Deleting permission');
    const authError = await authorize('delete', 'IAM');
    if (authError) return authError;

    try {
        const { actionId } = await params;
        const actor = await resolveActor();
        const reason = await readReason(request);
        await deleteAction(actor, actionId, reason);
        return NextResponse.json({ success: true, data: { id: actionId } });
    } catch (error) {
        console.error('API - Error deleting permission:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to delete permission' },
            { status: mapRegistryError(error) }
        );
    }
}
