import { NextResponse } from 'next/server';

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { loadAdminRegistry } from '@/lib/rbac/registry-admin';

export const dynamic = 'force-dynamic';

export async function GET() {
    console.log('API - GET /api/settings/rbac/registry - Loading admin registry');
    const authError = await authorize('read', 'IAM');
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        const data = await loadAdminRegistry(tenantId);
        return NextResponse.json({ success: true, data });
    } catch (error) {
        console.error('API - Error loading admin registry:', error);
        return NextResponse.json({ success: false, error: 'Failed to load the permission registry' }, { status: 500 });
    }
}
