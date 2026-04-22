import { NextRequest, NextResponse } from "next/server";
import { authorize } from "@/lib/rbac/authorize";
import { getSessionTenantId, getAuthSession } from "@/lib/auth-session";
import { InvitationService } from "@/lib/invitation-service";
import { AuditService } from "@/lib/audit-service";

export async function POST(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    console.log("API - POST /api/invitations/[id]/revoke - Revoking invitation");
    const authError = await authorize("delete", "User");
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        const session = await getAuthSession();
        const { id } = await params;
        const invitation = await InvitationService.revokeInvitation(id, tenantId);

        AuditService.logUserAction({
            eventType: 'tenant.invitation.revoked',
            severity: 'medium',
            apiRoute: 'POST /api/invitations/[id]/revoke',
            httpMethod: 'POST',
            action: 'Revoked Invitation',
            resourceType: 'tenant',
            resourceId: id,
            resourceName: id,
            user: session!.user.email || session!.user.id,
            userType: 'user',
            status: 'success',
            details: `Revoked invitation ${id}`,
            metadata: { tenantId, invitationId: id },
        }).catch(() => {});

        return NextResponse.json({ success: true, data: invitation });
    } catch (error) {
        console.error("API - Error revoking invitation:", error);
        AuditService.logUserAction({
            eventType: 'tenant.invitation.revoked',
            severity: 'medium',
            apiRoute: 'POST /api/invitations/[id]/revoke',
            httpMethod: 'POST',
            action: 'Revoked Invitation',
            resourceType: 'tenant',
            resourceId: 'unknown',
            resourceName: 'unknown',
            user: 'unknown',
            userType: 'user',
            status: 'error',
            details: `Failed to revoke invitation: ${error instanceof Error ? error.message : 'Unknown error'}`,
            metadata: {},
        }).catch(() => {});
        return NextResponse.json(
            {
                success: false,
                error: error instanceof Error ? error.message : "Failed to revoke invitation",
            },
            { status: 500 }
        );
    }
}
