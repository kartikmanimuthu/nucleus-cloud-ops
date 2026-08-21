import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { getCustomRole, updateCustomRole, deleteCustomRole } from '@/lib/rbac/custom-role-service';
import type { PermissionSet } from '@/lib/rbac/types';
import type { SubjectOverrides } from '@/lib/rbac/role-subject-overrides';
import { AuditService } from '@/lib/audit-service';

export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ roleId: string }> }
) {
    const authError = await authorize('read', 'Role');
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
    const authError = await authorize('update', 'Role');
    if (authError) return authError;

    // Hoisted so the catch can reference them: declared inside the try, the
    // error handler threw ReferenceError and every failure became a 500 with
    // an empty body — surfacing as "Unexpected end of JSON input".
    let tenantId = 'unknown';
    let callerEmail = 'unknown';

    try {
        const { roleId } = await params;
        tenantId = await getSessionTenantId();
        const session = await getAuthSession();
        callerEmail = session?.user?.email ?? 'unknown';
        const body = await request.json();
        const { name, permissions, overrides } = body as {
            name: string;
            permissions: PermissionSet;
            overrides?: SubjectOverrides;
        };

        if (!name || name.trim().length === 0) {
            return NextResponse.json({ success: false, error: 'Role name is required' }, { status: 400 });
        }
        if (name.trim().length > 50) {
            return NextResponse.json(
                { success: false, error: 'Role name must be 50 characters or less' },
                { status: 400 }
            );
        }

        const role = await updateCustomRole(
            tenantId,
            roleId,
            { name: name.trim(), permissions, overrides: overrides ?? {} },
            { userId: session?.user?.id ?? 'unknown', email: callerEmail }
        );

        AuditService.logUserAction({
            eventType: 'rbac.role.updated',
            severity: 'high',
            apiRoute: 'PUT /api/settings/roles/[roleId]',
            httpMethod: 'PUT',
            action: 'Updated Role',
            resourceType: 'rbac',
            resourceId: roleId,
            resourceName: name.trim(),
            user: callerEmail,
            userType: 'user',
            status: 'success',
            details: `Updated custom role "${name.trim()}"`,
            metadata: { tenantId, permissions, overrides: overrides ?? {} },
        }).catch(() => {});

        return NextResponse.json({ success: true, data: role });
    } catch (error) {
        console.error('API - Error updating role:', error);

        AuditService.logUserAction({
            eventType: 'rbac.role.updated',
            severity: 'high',
            apiRoute: 'PUT /api/settings/roles/[roleId]',
            httpMethod: 'PUT',
            action: 'Updated Role',
            resourceType: 'rbac',
            resourceId: (await params).roleId,
            resourceName: '',
            user: 'unknown',
            userType: 'user',
            status: 'error',
            details: `Failed to update role: ${error instanceof Error ? error.message : 'Unknown error'}`,
            metadata: {},
        }).catch(() => {});

        const message = error instanceof Error ? error.message : 'Failed to update role';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}

export async function DELETE(
    _request: NextRequest,
    { params }: { params: Promise<{ roleId: string }> }
) {
    console.log('API - DELETE /api/settings/roles/[roleId] - Deleting custom role');
    const authError = await authorize('delete', 'Role');
    if (authError) return authError;

    // Hoisted so the catch can reference them: declared inside the try, the
    // error handler threw ReferenceError and every failure became a 500 with
    // an empty body — surfacing as "Unexpected end of JSON input".
    let tenantId = 'unknown';
    let callerEmail = 'unknown';

    try {
        const { roleId } = await params;
        tenantId = await getSessionTenantId();
        const session = await getAuthSession();
        callerEmail = session?.user?.email ?? 'unknown';

        await deleteCustomRole(tenantId, roleId, {
            userId: session?.user?.id ?? 'unknown',
            email: callerEmail,
        });

        AuditService.logUserAction({
            eventType: 'rbac.role.deleted',
            severity: 'high',
            apiRoute: 'DELETE /api/settings/roles/[roleId]',
            httpMethod: 'DELETE',
            action: 'Deleted Role',
            resourceType: 'rbac',
            resourceId: roleId,
            resourceName: roleId,
            user: callerEmail,
            userType: 'user',
            status: 'success',
            details: `Deleted custom role "${roleId}"`,
            metadata: { tenantId },
        }).catch(() => {});

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('API - Error deleting role:', error);

        AuditService.logUserAction({
            eventType: 'rbac.role.deleted',
            severity: 'high',
            apiRoute: 'DELETE /api/settings/roles/[roleId]',
            httpMethod: 'DELETE',
            action: 'Deleted Role',
            resourceType: 'rbac',
            resourceId: (await params).roleId,
            resourceName: '',
            user: 'unknown',
            userType: 'user',
            status: 'error',
            details: `Failed to delete role: ${error instanceof Error ? error.message : 'Unknown error'}`,
            metadata: {},
        }).catch(() => {});

        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to delete role' },
            { status: 500 }
        );
    }
}
