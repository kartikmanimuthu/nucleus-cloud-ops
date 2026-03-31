import { NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { canAssignRole } from '@/lib/rbac/permissions';
import { assignUserRole } from '@/lib/rbac/role-service';
import { getAuthSession } from '@/lib/auth-session';
import type { PredefinedRole } from '@/lib/rbac/types';

const VALID_ROLES: PredefinedRole[] = ['Owner', 'Admin', 'Member', 'Viewer'];
const DEFAULT_TENANT_ID = 'default';

export async function POST(request: Request) {
    // Check authorization - must be able to update users
    const authError = await authorize('update', 'User');
    if (authError) return authError;

    try {
        const session = await getAuthSession();
        const adminEmail = session?.user?.email || 'system';

        const body = await request.json();
        const { userId, email, role, tenantId } = body;

        // Validate required fields
        if (!userId || !email || !role) {
            return NextResponse.json(
                { error: 'Missing required fields: userId, email, role' },
                { status: 400 }
            );
        }

        // Validate role is a known predefined role
        if (!VALID_ROLES.includes(role)) {
            return NextResponse.json(
                { error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}` },
                { status: 400 }
            );
        }

        // Enforce role hierarchy: assigner cannot assign a role above their own level (D-09)
        const currentUserRole = session?.user?.role as PredefinedRole | undefined;
        if (!currentUserRole || !canAssignRole(currentUserRole, role as PredefinedRole)) {
            return NextResponse.json(
                { error: 'Forbidden', message: 'Cannot assign a role above your own level' },
                { status: 403 }
            );
        }

        // Use provided tenantId or default
        const effectiveTenantId = tenantId || DEFAULT_TENANT_ID;

        // Assign the role
        await assignUserRole(
            userId,
            email,
            effectiveTenantId,
            role as PredefinedRole,
            adminEmail
        );

        return NextResponse.json({
            success: true,
            message: `Role ${role} assigned to ${email}`,
            userId,
            email,
            role,
            tenantId: effectiveTenantId,
            assignedBy: adminEmail,
            assignedAt: new Date().toISOString(),
        });

    } catch (error) {
        console.error('Error assigning role:', error);
        return NextResponse.json(
            { error: 'Failed to assign role', details: (error as Error).message },
            { status: 500 }
        );
    }
}
