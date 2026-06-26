import { NextResponse } from "next/server";
import { authorize } from "@/lib/rbac/authorize";
import { getSessionTenantId } from "@/lib/auth-session";
import { getTenantClient } from "@/lib/db/pg-config";

export async function GET() {
    console.log("API - GET /api/settings/members - Listing members");
    const authError = await authorize("read", "User");
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        const prisma = getTenantClient(tenantId);
        const members = await prisma.userTenantRole.findMany({
            orderBy: { assignedAt: "desc" },
        });
        return NextResponse.json({ success: true, data: members });
    } catch (error) {
        console.error("API - Error listing members:", error);
        return NextResponse.json(
            {
                success: false,
                error: error instanceof Error ? error.message : "Failed to list members",
            },
            { status: 500 }
        );
    }
}
