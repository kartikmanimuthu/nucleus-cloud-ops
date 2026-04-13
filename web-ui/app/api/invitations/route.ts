import { NextRequest, NextResponse } from "next/server";
import { authorize } from "@/lib/rbac/authorize";
import { getSessionTenantId, getAuthSession } from "@/lib/auth-session";
import { InvitationService } from "@/lib/invitation-service";
import { AuditService } from "@/lib/audit-service";

export async function POST(request: NextRequest) {
    console.log("API - POST /api/invitations - Creating invitation");
    const authError = await authorize("create", "User");
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        const session = await getAuthSession();
        const invitedBy = session!.user.id;
        const { email, role } = await request.json();

        if (!email || !role) {
            return NextResponse.json(
                { success: false, error: "Email and role are required" },
                { status: 400 }
            );
        }

        const result = await InvitationService.createInvitation(tenantId, email, role, invitedBy);

        AuditService.logUserAction({
            action: 'Created Invitation',
            resourceType: 'tenant',
            resourceId: result.id || email,
            resourceName: email,
            user: session!.user.email || invitedBy,
            userType: 'user',
            status: 'success',
            details: `Invited ${email} with role "${role}"`,
            metadata: { tenantId, email, role },
        }).catch(() => {});

        return NextResponse.json({ success: true, data: result }, { status: 201 });
    } catch (error) {
        console.error("API - Error creating invitation:", error);
        AuditService.logUserAction({
            action: 'Created Invitation',
            resourceType: 'tenant',
            resourceId: 'unknown',
            resourceName: 'unknown',
            user: 'unknown',
            userType: 'user',
            status: 'error',
            details: `Failed to create invitation: ${error instanceof Error ? error.message : 'Unknown error'}`,
            metadata: {},
        }).catch(() => {});
        const message = error instanceof Error ? error.message : "Failed to create invitation";
        const isConflict = message.includes("already");
        return NextResponse.json(
            { success: false, error: message },
            { status: isConflict ? 409 : 500 }
        );
    }
}

export async function GET() {
    console.log("API - GET /api/invitations - Listing invitations");
    const authError = await authorize("read", "User");
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        const invitations = await InvitationService.listInvitations(tenantId);
        return NextResponse.json({ success: true, data: invitations });
    } catch (error) {
        console.error("API - Error listing invitations:", error);
        return NextResponse.json(
            {
                success: false,
                error: error instanceof Error ? error.message : "Failed to list invitations",
            },
            { status: 500 }
        );
    }
}
