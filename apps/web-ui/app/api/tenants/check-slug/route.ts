import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth-session";
import { getPrismaClient } from "@/lib/db/pg-config";
import type { RouteAuthz } from '@nucleus/rbac';

/** Layer 1 permission declaration — see lib/rbac/rbac-allowlist.ts for the public set. */
export const authz: RouteAuthz = {
    GET: { action: 'read', subject: 'Tenant' },
};

export async function GET(req: NextRequest) {
    try {
        const session = await getAuthSession();
        if (!session?.user) {
            return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
        }

        const slug = req.nextUrl.searchParams.get("slug");
        if (!slug) {
            return NextResponse.json({ error: "slug parameter required" }, { status: 400 });
        }

        // Validate slug format: lowercase alphanumeric + hyphens, 3-50 chars
        const slugRegex = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
        if (!slugRegex.test(slug)) {
            return NextResponse.json(
                { available: false, error: "Slug must be 3-50 lowercase letters, numbers, or hyphens" },
                { status: 400 }
            );
        }

        const prisma = getPrismaClient();
        const existing = await prisma.tenant.findUnique({ where: { slug } });

        return NextResponse.json({ available: !existing });
    } catch (error) {
        console.error("API - GET /api/tenants/check-slug - Error:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
