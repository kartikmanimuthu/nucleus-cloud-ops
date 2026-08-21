import { NextRequest, NextResponse } from 'next/server';

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { loadAdminRegistry } from '@/lib/rbac/registry-admin';
import { createAction } from '@/lib/rbac/registry-admin-writes';

import { mapRegistryError, resolveActor } from '../_shared';

export const dynamic = 'force-dynamic';

export async function GET() {
    console.log('API - GET /api/settings/rbac/permissions - Listing permissions');
    const authError = await authorize('read', 'IAM');
    if (authError) return authError;
    try {
        const tenantId = await getSessionTenantId();
        const { actions } = await loadAdminRegistry(tenantId);
        return NextResponse.json({ success: true, data: actions });
    } catch (error) {
        console.error('API - Error listing permissions:', error);
        return NextResponse.json({ success: false, error: 'Failed to list permissions' }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    console.log('API - POST /api/settings/rbac/permissions - Creating permission');
    const authError = await authorize('create', 'IAM');
    if (authError) return authError;

    try {
        const actor = await resolveActor();
        const body = await request.json();
        if (!body?.key || !body?.label) {
            return NextResponse.json({ success: false, error: 'Key and label are required' }, { status: 400 });
        }
        const created = await createAction(actor, {
            key: String(body.key),
            label: String(body.label),
            description: body.description ?? null,
            aliasOfKey: body.aliasOfKey || null,
            isDangerous: Boolean(body.isDangerous),
            sortOrder: Number.isFinite(body.sortOrder) ? Number(body.sortOrder) : 100,
        });
        return NextResponse.json({ success: true, data: created }, { status: 201 });
    } catch (error) {
        console.error('API - Error creating permission:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to create permission' },
            { status: mapRegistryError(error) }
        );
    }
}
