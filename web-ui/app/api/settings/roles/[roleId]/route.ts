import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { getCustomRole, updateCustomRole, deleteCustomRole } from '@/lib/rbac/custom-role-service';
import type { PermissionSet } from '@/lib/rbac/types';

export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ roleId: string }> }
) {
    const authError = await authorize('read', 'Settings');
    if (authError) return authError;

    try {
        const { roleId } = await params;
        const tenantId = await getSessionTenantId();
        const role = await getCustomRole(tenantId, roleId);
        if (!role) {
            return NextResponse.json({ success: false, error: 'Role not found' }, { status: 404 });
        }
        return NextResponse.json({ success: true, data: role });
    } catch (error) {
        console.error('API - Error fetching role:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to fetch role' },
            { status: 500 }
        );
    }
}

export async function PUT(
    request: NextRequest,
    { params }: { params: Promise<{ roleId: string }> }
) {
    console.log('API - PUT /api/settings/roles/[roleId] - Updating custom role');
    const authError = await authorize('update', 'Settings');
    if (authError) return authError;

    try {
        const { roleId } = await params;
        const tenantId = await getSessionTenantId();
        const body = await request.json();
        const { name, permissions } = body as { name: string; permissions: PermissionSet };

        if (!name || name.trim().length === 0) {
            return NextResponse.json({ success: false, error: 'Role name is required' }, { status: 400 });
        }
        if (name.trim().length > 50) {
            return NextResponse.json(
                { success: false, error: 'Role name must be 50 characters or less' },
                { status: 400 }
            );
        }

        const role = await updateCustomRole(tenantId, roleId, { name: name.trim(), permissions });
        return NextResponse.json({ success: true, data: role });
    } catch (error) {
        console.error('API - Error updating role:', error);
        const message = error instanceof Error ? error.message : 'Failed to update role';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}

export async function DELETE(
    _request: NextRequest,
    { params }: { params: Promise<{ roleId: string }> }
) {
    console.log('API - DELETE /api/settings/roles/[roleId] - Deleting custom role');
    const authError = await authorize('delete', 'Settings');
    if (authError) return authError;

    try {
        const { roleId } = await params;
        const tenantId = await getSessionTenantId();
        await deleteCustomRole(tenantId, roleId);
        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('API - Error deleting role:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to delete role' },
            { status: 500 }
        );
    }
}
