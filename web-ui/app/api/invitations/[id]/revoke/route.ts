import { NextRequest, NextResponse } from "next/server";
import { authorize } from "@/lib/rbac/authorize";
import { getSessionTenantId } from "@/lib/auth-session";
import { InvitationService } from "@/lib/invitation-service";

export async function POST(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    console.log("API - POST /api/invitations/[id]/revoke - Revoking invitation");
    const authError = await authorize("delete", "User");
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        const { id } = await params;
        const invitation = await InvitationService.revokeInvitation(id, tenantId);
        return NextResponse.json({ success: true, data: invitation });
    } catch (error) {
        console.error("API - Error revoking invitation:", error);
        return NextResponse.json(
            {
                success: false,
                error: error instanceof Error ? error.message : "Failed to revoke invitation",
            },
            { status: 500 }
        );
    }
}
