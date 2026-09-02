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

        const nextRole = role.trim();

        // ── WRITE BOTH COLUMNS, ALWAYS ──────────────────────────────────────
        // user_tenant_roles records the role twice: `role` (free text, labelled
        // "keep for backward compat" at schema.prisma:199) and `roleId` (the FK).
        // They are read by DIFFERENT code paths — authorize()'s legacy branch
        // resolves by NAME, while session-ability.ts:44 (CASL, the sidebar and
        // the page guard) resolves by FK and only consults the name when roleId
        // is NULL.
        //
        // This handler previously wrote `role` alone, leaving roleId pointing at
        // the PREVIOUS role. Nothing catches that: the CHECK constraint on `role`
        // was dropped in 20260403_drop_role_check_constraint and no trigger
        // enforces the two columns agreeing. The result is a member the API
        // authorises as one role and the UI renders as another — nine `smc`
        // memberships ended up with role='cloud-admin' against roleId=cloud-read,
        // granting Schedules and IAM through the API while the sidebar showed
        // them as read-only. See docs/rca-2026-08-21-role-column-divergence.md.
        //
        // roleId resolves to NULL for the predefined roles (Owner/Admin/Member/
        // Viewer), which have no tenant-local row — the documented meaning of a
        // null FK, and resolveRole() falls back to the name for exactly that case.
        // Same lookup shape as invitation-service.ts:66 and :331.
        const updated = await prisma.$transaction(async (tx) => {
            const customRole = await tx.customRole.findFirst({
                where: { tenantId, name: nextRole },
                select: { id: true },
            });

            const row = await tx.userTenantRole.update({
                where: { id: memberId },
                data: { role: nextRole, roleId: customRole?.id ?? null },
            });

            // Without this the change does not take effect. principalCache in
            // session-ability.ts:131 is keyed `tenantId:userId:version`, so the
            // OLD principal — carrying the old roleId — keeps being served until
            // the version moves. Mirrors withRbacVersionBump() in
            // registry-service.ts:129; inlined to avoid passing this route's
            // tenant-extended client where an RbacTransaction is expected.
            await tx.tenant.update({
                where: { id: tenantId },
                data: { rbacVersion: { increment: 1 } },
            });

            return row;
        });

        AuditService.logUserAction({
            eventType: 'tenant.member.role_changed',
            severity: 'high',
            apiRoute: 'PATCH /api/settings/members/[memberId]',
            httpMethod: 'PATCH',
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
            eventType: 'tenant.member.role_changed',
            severity: 'high',
            apiRoute: 'PATCH /api/settings/members/[memberId]',
            httpMethod: 'PATCH',
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
