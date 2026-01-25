import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { authorize } from '@/lib/rbac/authorize';
import { assignUserRole } from '@/lib/rbac/role-service';
import { TenantRole } from '@/lib/rbac/types';

const VALID_ROLES: TenantRole[] = ['TenantAdmin', 'TenantOperator', 'TenantViewer'];
const DEFAULT_TENANT_ID = 'default';

export async function POST(request: Request) {
    // Check authorization - must be able to update users
    const authError = await authorize('update', 'User');
    if (authError) return authError;

    try {
        const session = await getServerSession(authOptions);
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

        // Validate role
        if (!VALID_ROLES.includes(role)) {
            return NextResponse.json(
                { error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}` },
                { status: 400 }
            );
        }

        // Use provided tenantId or default
        const effectiveTenantId = tenantId || DEFAULT_TENANT_ID;

        // Assign the role
        await assignUserRole(
            userId,
            email,
            effectiveTenantId,
            role as TenantRole,
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
