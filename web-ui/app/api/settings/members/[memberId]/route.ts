import { NextRequest, NextResponse } from "next/server";
import { authorize } from "@/lib/rbac/authorize";
import { getSessionTenantId, getSessionUserId, getAuthSession } from "@/lib/auth-session";
import { getTenantClient } from "@/lib/db/pg-config";
import { AuditService } from '@/lib/audit-service';

export async function PATCH(
    request: NextRequest,
    { params }: { params: Promise<{ memberId: string }> }
) {
    console.log("API - PATCH /api/settings/members/[memberId] - Updating member role");
    const authError = await authorize("update", "User");
    if (authError) return authError;

    try {
        const { memberId } = await params;
        const body = await request.json();
        const { role } = body as { role?: string };

        if (!role || typeof role !== "string" || role.trim() === "") {
            return NextResponse.json(
                { success: false, error: "role is required" },
                { status: 400 }
            );
        }

        const tenantId = await getSessionTenantId();
        const userId = await getSessionUserId();
        const session = await getAuthSession();
        const callerEmail = session?.user?.email ?? 'unknown';
        const prisma = getTenantClient(tenantId);

        // Self-edit guard
        const existing = await prisma.userTenantRole.findUnique({ where: { id: memberId } });
        if (!existing) {
            return NextResponse.json(
                { success: false, error: "Member not found" },
                { status: 404 }
            );
        }
        if (existing.userId === userId) {
            return NextResponse.json(
                { success: false, error: "Cannot change your own role" },
                { status: 403 }
            );
        }

        const updated = await prisma.userTenantRole.update({
            where: { id: memberId },
            data: { role: role.trim() },
        });

        AuditService.logUserAction({
            action: 'Changed Member Role',
            resourceType: 'tenant',
            resourceId: memberId,
            resourceName: memberId,
            user: callerEmail,
            userType: 'user',
            status: 'success',
            details: `Changed member role to "${role.trim()}"`,
            metadata: { tenantId, previousRole: existing.role, newRole: role.trim() },
        }).catch(() => {});

        return NextResponse.json({ success: true, data: updated });
    } catch (error) {
        console.error("API - Error updating member role:", error);

        AuditService.logUserAction({
            action: 'Changed Member Role',
            resourceType: 'tenant',
            resourceId: 'unknown',
            resourceName: '',
            user: 'unknown',
            userType: 'user',
            status: 'error',
            details: `Failed to change member role: ${error instanceof Error ? error.message : 'Unknown error'}`,
            metadata: {},
        }).catch(() => {});

        return NextResponse.json(
            {
                success: false,
                error: error instanceof Error ? error.message : "Failed to update member role",
            },
            { status: 500 }
        );
    }
}
