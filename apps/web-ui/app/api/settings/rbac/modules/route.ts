import { NextRequest, NextResponse } from 'next/server';

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { loadAdminRegistry } from '@/lib/rbac/registry-admin';
import { createModule } from '@/lib/rbac/registry-admin-writes';

import { mapRegistryError, resolveActor } from '../_shared';

export const dynamic = 'force-dynamic';

export async function GET() {
    console.log('API - GET /api/settings/rbac/modules - Listing modules');
    const authError = await authorize('read', 'IAM');
    if (authError) return authError;
    try {
        const tenantId = await getSessionTenantId();
        const { modules } = await loadAdminRegistry(tenantId);
        return NextResponse.json({ success: true, data: modules });
    } catch (error) {
        console.error('API - Error listing modules:', error);
        return NextResponse.json({ success: false, error: 'Failed to list modules' }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    console.log('API - POST /api/settings/rbac/modules - Creating module');
    const authError = await authorize('create', 'IAM');
    if (authError) return authError;

    try {
        const actor = await resolveActor();
        const body = await request.json();
        if (!body?.key || !body?.label) {
            return NextResponse.json({ success: false, error: 'Key and label are required' }, { status: 400 });
        }
        if (!Array.isArray(body.actionKeys) || !Array.isArray(body.subjectKeys)) {
            return NextResponse.json(
                { success: false, error: 'actionKeys and subjectKeys are required' },
                { status: 400 }
            );
        }
        // Present-but-non-numeric must fail as a 400, not reach Prisma as NaN.
        if (body.sortOrder !== undefined && !Number.isFinite(Number(body.sortOrder))) {
            return NextResponse.json({ success: false, error: 'sortOrder must be a number' }, { status: 400 });
        }

        const created = await createModule(actor, {
            key: String(body.key),
            label: String(body.label),
            description: body.description ?? null,
            icon: body.icon ?? null,
            navPath: body.navPath ?? null,
            sortOrder: body.sortOrder !== undefined ? Number(body.sortOrder) : undefined,
            enabled: body.enabled === undefined ? undefined : Boolean(body.enabled),
            actionKeys: body.actionKeys.map(String),
            subjectKeys: body.subjectKeys.map(String),
        });
        return NextResponse.json({ success: true, data: created }, { status: 201 });
    } catch (error) {
        console.error('API - Error creating module:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to create module' },
            { status: mapRegistryError(error) }
        );
    }
}
