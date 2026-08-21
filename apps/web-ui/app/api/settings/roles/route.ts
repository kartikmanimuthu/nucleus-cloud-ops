import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { createCustomRole, getCustomRoles, getPresetRoles } from '@/lib/rbac/custom-role-service';
import type { PermissionSet } from '@/lib/rbac/types';
import type { SubjectOverrides } from '@/lib/rbac/role-subject-overrides';
import { AuditService } from '@/lib/audit-service';

export async function GET(_request: NextRequest) {
    console.log('API - GET /api/settings/roles - Fetching roles');
    const authError = await authorize('read', 'Role');
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        const [customRoles, presetRoles] = await Promise.all([
            getCustomRoles(tenantId),
            // Tenant passed so a tenant-authored module/action override resolves alongside
            // the global registry rows the preset rules point at.
            getPresetRoles(tenantId),
        ]);

        return NextResponse.json({
            success: true,
            data: { predefined: presetRoles, custom: customRoles },
        });
    } catch (error) {
        console.error('API - Error fetching roles:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to fetch roles' },
            { status: 500 }
        );
    }
}

export async function POST(request: NextRequest) {
    console.log('API - POST /api/settings/roles - Creating custom role');
    const authError = await authorize('create', 'Role');
    if (authError) return authError;

    // Hoisted out of the try so the catch can reference them. They were
    // declared inside it, so the error handler itself threw ReferenceError —
    // turning every failure into a 500 with an EMPTY body, which reaches the
    // browser as "Unexpected end of JSON input" and hides the real cause.
    let tenantId = 'unknown';
    let callerEmail = 'unknown';

    try {
        tenantId = await getSessionTenantId();
        const session = await getAuthSession();
        callerEmail = session?.user?.email ?? 'unknown';
        const body = await request.json();

        const { name, permissions, overrides } = body as {
            name: string;
            permissions: PermissionSet;
            overrides?: SubjectOverrides;
        };

        if (!name || typeof name !== 'string' || name.trim().length === 0) {
            return NextResponse.json({ success: false, error: 'Role name is required' }, { status: 400 });
        }
        if (name.trim().length > 50) {
            return NextResponse.json(
                { success: false, error: 'Role name must be 50 characters or less' },
                { status: 400 }
            );
        }
        if (!permissions || typeof permissions !== 'object') {
            return NextResponse.json({ success: false, error: 'Permissions object is required' }, { status: 400 });
        }

        const role = await createCustomRole(
            tenantId,
            { name: name.trim(), permissions, overrides: overrides ?? {} },
            { userId: session?.user?.id ?? 'unknown', email: callerEmail }
        );

        AuditService.logUserAction({
            eventType: 'rbac.role.created',
            severity: 'high',
            apiRoute: 'POST /api/settings/roles',
            httpMethod: 'POST',
            action: 'Created Role',
            resourceType: 'rbac',
            resourceId: role.id,
            resourceName: name.trim(),
            user: callerEmail,
            userType: 'user',
            status: 'success',
            details: `Created custom role "${name.trim()}"`,
            metadata: { tenantId, permissions, overrides: overrides ?? {} },
        }).catch(() => {});

        return NextResponse.json({ success: true, data: role }, { status: 201 });
    } catch (error) {
        console.error('API - Error creating role:', error);

        AuditService.logUserAction({
            eventType: 'rbac.role.created',
            severity: 'high',
            apiRoute: 'POST /api/settings/roles',
            httpMethod: 'POST',
            action: 'Created Role',
            resourceType: 'rbac',
            resourceId: 'unknown',
            resourceName: '',
            user: callerEmail,
            userType: 'user',
            status: 'error',
            details: `Failed to create role: ${error instanceof Error ? error.message : 'Unknown error'}`,
            metadata: { tenantId },
        }).catch(() => {});

        const message = error instanceof Error ? error.message : 'Failed to create role';
        const isConflict =
            message.includes('already exists') ||
            message.includes('Maximum') ||
            message.includes('predefined');
        return NextResponse.json({ success: false, error: message }, { status: isConflict ? 409 : 500 });
    }
}
