import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth-session";
import { getPrismaClient } from "@/lib/db/pg-config";
import { ROLE_PERMISSIONS } from "@/lib/rbac/permissions";
import { z } from "zod";

const createTenantSchema = z.object({
    name: z.string().min(1, "Organization name is required").max(100),
    slug: z.string()
        .min(3, "Slug must be at least 3 characters")
        .max(50, "Slug must be at most 50 characters")
        .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, "Slug must be lowercase letters, numbers, or hyphens"),
});

export async function POST(req: NextRequest) {
    try {
        const session = await getAuthSession();
        if (!session?.user) {
            return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
        }

        const body = await req.json();
        const parsed = createTenantSchema.safeParse(body);
        if (!parsed.success) {
            return NextResponse.json(
                { error: parsed.error.errors[0].message },
                { status: 400 }
            );
        }

        const { name, slug } = parsed.data;
        const prisma = getPrismaClient();

        // Transaction: create Tenant + assign Owner role atomically
        const result = await prisma.$transaction(async (tx) => {
            // Check slug uniqueness inside transaction to prevent TOCTOU race conditions
            const existingSlug = await tx.tenant.findUnique({ where: { slug } });
            if (existingSlug) {
                throw new Error("SLUG_TAKEN");
            }

            const tenant = await tx.tenant.create({
                data: {
                    name,
                    slug,
                    status: "active",
                },
            });

            // Seed the 4 default roles into custom_roles for this tenant
            const defaultRoles = [
                { name: "Owner", level: 4, permissions: ROLE_PERMISSIONS.Owner },
                { name: "Admin", level: 3, permissions: ROLE_PERMISSIONS.Admin },
                { name: "Member", level: 2, permissions: ROLE_PERMISSIONS.Member },
                { name: "Viewer", level: 1, permissions: ROLE_PERMISSIONS.Viewer },
            ];
            await tx.customRole.createMany({
                data: defaultRoles.map((r) => ({
                    tenantId: tenant.id,
                    name: r.name,
                    permissions: r.permissions,
                    level: r.level,
                    createdBy: session.user.id,
                })),
                skipDuplicates: true,
            });

            // Assign the creating user as Owner — look up the seeded Owner role for roleId
            const ownerRole = await tx.customRole.findFirst({
                where: { tenantId: tenant.id, name: "Owner" },
            });
            await tx.userTenantRole.create({
                data: {
                    userId: session.user.id,
                    tenantId: tenant.id,
                    email: session.user.email,
                    role: "Owner",
                    roleId: ownerRole?.id ?? null,
                    assignedBy: session.user.id,
                },
            });

            return tenant;
        });

        // Auto-switch the user to the newly created tenant
        await prisma.authUser.update({
            where: { id: session.user.id },
            data: { activeTenantId: result.id },
        });

        console.log(`API - POST /api/tenants - Created tenant ${result.id} (slug: ${result.slug})`);

        return NextResponse.json(
            { success: true, tenantId: result.id, slug: result.slug },
            { status: 201 }
        );
    } catch (error: unknown) {
        if (error instanceof Error && error.message === "SLUG_TAKEN") {
            return NextResponse.json(
                { error: "This slug is already taken. Try another." },
                { status: 409 }
            );
        }
        console.error("API - POST /api/tenants - Error:", error);
        return NextResponse.json(
            { error: "Failed to create organization. Please try again." },
            { status: 500 }
        );
    }
}
