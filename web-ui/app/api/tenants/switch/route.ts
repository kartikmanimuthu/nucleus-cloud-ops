import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth-session";
import { getPrismaClient } from "@/lib/db/pg-config";
import { AuditService } from '@/lib/audit-service';

export async function POST(req: NextRequest) {
    try {
        const session = await getAuthSession();
        if (!session?.user) {
            return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
        }

        const { tenantId } = await req.json();
        if (!tenantId || typeof tenantId !== "string") {
            return NextResponse.json({ error: "tenantId is required" }, { status: 400 });
        }

        const prisma = getPrismaClient();

        // Verify user actually belongs to this tenant (never skip this check)
        const utr = await prisma.userTenantRole.findFirst({
            where: { userId: session.user.id, tenantId },
        });
        if (!utr) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        // Persist the active tenant choice on AuthUser (NOT getTenantClient — AuthUser is not tenant-scoped)
        await prisma.authUser.update({
            where: { id: session.user.id },
            data: { activeTenantId: tenantId },
        });

        console.log(`API - POST /api/tenants/switch - User ${session.user.id} switched to tenant ${tenantId}`);

        AuditService.logUserAction({
            action: 'Switched Organization',
            resourceType: 'tenant',
            resourceId: tenantId,
            resourceName: tenantId,
            user: session.user.email || session.user.id,
            userType: 'user',
            status: 'success',
            details: `Switched active organization to ${tenantId}`,
            metadata: { tenantId },
        }).catch(() => {});

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("API - POST /api/tenants/switch - Error:", error);
        return NextResponse.json({ error: "Failed to switch organization" }, { status: 500 });
    }
}
