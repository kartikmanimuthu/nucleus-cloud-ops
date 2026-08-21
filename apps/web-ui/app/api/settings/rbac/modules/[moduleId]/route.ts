import { NextRequest, NextResponse } from 'next/server';

import { authorize } from '@/lib/rbac/authorize';
import { deleteModule, updateModule } from '@/lib/rbac/registry-admin-writes';

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

export async function PUT(request: NextRequest, { params }: { params: Promise<{ moduleId: string }> }) {
    console.log('API - PUT /api/settings/rbac/modules/[moduleId] - Updating module');
    const authError = await authorize('update', 'IAM');
    if (authError) return authError;

    try {
        const { moduleId } = await params;
        const actor = await resolveActor();
        const body = await request.json();
        const reason = typeof body?.reason === 'string' ? body.reason : undefined;
        const force = Boolean(body?.force);

        if (!body?.key || !body?.label) {
            return NextResponse.json({ success: false, error: 'Key and label are required' }, { status: 400 });
        }
        if (!Array.isArray(body.actionKeys) || !Array.isArray(body.subjectKeys)) {
            return NextResponse.json(
                { success: false, error: 'actionKeys and subjectKeys are required' },
                { status: 400 }
            );
        }
        // Present-but-non-numeric (e.g. "abc", null, {}) must fail as a 400, not
        // reach Prisma as a NaN on an Int column and 500. Omitted is fine.
        if (body.sortOrder !== undefined && !Number.isFinite(Number(body.sortOrder))) {
            return NextResponse.json({ success: false, error: 'sortOrder must be a number' }, { status: 400 });
        }

        const result = await updateModule(
            actor,
            moduleId,
            {
                key: String(body.key),
                label: String(body.label),
                description: body.description ?? null,
                icon: body.icon ?? null,
                navPath: body.navPath ?? null,
                sortOrder: body.sortOrder !== undefined ? Number(body.sortOrder) : undefined,
                enabled: body.enabled === undefined ? undefined : Boolean(body.enabled),
                actionKeys: body.actionKeys.map(String),
                subjectKeys: body.subjectKeys.map(String),
            },
            { force, reason }
        );
        // { id, materializedRules, revokedRules } — the UI reports e.g.
        // "3 grants preserved" from these counts.
        return NextResponse.json({ success: true, data: result });
    } catch (error) {
        console.error('API - Error updating module:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to update module' },
            { status: mapRegistryError(error) }
        );
    }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ moduleId: string }> }) {
    console.log('API - DELETE /api/settings/rbac/modules/[moduleId] - Deleting module');
    const authError = await authorize('delete', 'IAM');
    if (authError) return authError;

    try {
        const { moduleId } = await params;
        const actor = await resolveActor();
        const reason = await readReason(request);
        await deleteModule(actor, moduleId, reason);
        return NextResponse.json({ success: true, data: { id: moduleId } });
    } catch (error) {
        console.error('API - Error deleting module:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to delete module' },
            { status: mapRegistryError(error) }
        );
    }
}
