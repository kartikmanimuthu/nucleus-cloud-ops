import { NextRequest, NextResponse } from "next/server";
import { authorize } from "@/lib/rbac/authorize";
import { getSessionTenantId } from "@/lib/auth-session";
import { InvitationService } from "@/lib/invitation-service";

export async function POST(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    console.log("API - POST /api/invitations/[id]/resend - Resending invitation");
    const authError = await authorize("update", "User");
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        const { id } = await params;
        const invitation = await InvitationService.resendInvitation(id, tenantId);
        return NextResponse.json({ success: true, data: invitation });
    } catch (error) {
        console.error("API - Error resending invitation:", error);
        return NextResponse.json(
            {
                success: false,
                error: error instanceof Error ? error.message : "Failed to resend invitation",
            },
            { status: 500 }
        );
    }
}
