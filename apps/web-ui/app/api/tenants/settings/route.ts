import { NextRequest, NextResponse } from "next/server";
import { getAuthSession, getSessionTenantId } from "@/lib/auth-session";
import { authorize } from "@/lib/rbac/authorize";
import { TenantSettingsService } from "@/lib/tenant-settings-service";
import { AuditService } from "@/lib/audit-service";
import { z } from "zod";

const updateSettingsSchema = z.object({
    name: z.string().min(1, "Organization name is required").max(100),
    timezone: z.string().min(1, "Timezone is required"),
    notifications: z.object({
        scheduleExecutions: z.boolean(),
        memberInvites: z.boolean(),
        systemAlerts: z.boolean(),
    }),
});

export async function GET() {
    try {
        const tenantId = await getSessionTenantId();
        const settings = await TenantSettingsService.getSettings(tenantId);
        return NextResponse.json({ success: true, data: settings });
    } catch (error) {
        console.error("API - GET /api/tenants/settings - Error:", error);
        return NextResponse.json({ error: "Failed to fetch settings" }, { status: 500 });
    }
}

export async function PUT(req: NextRequest) {
    try {
        // Per D-09: Only Owner and Admin can edit settings
        const authError = await authorize("update", "Settings");
        if (authError) return authError;

        const session = await getAuthSession();
        const tenantId = await getSessionTenantId();

        const body = await req.json();
        const parsed = updateSettingsSchema.safeParse(body);
        if (!parsed.success) {
            return NextResponse.json(
                { error: parsed.error.issues[0].message },
                { status: 400 }
            );
        }

        await TenantSettingsService.updateSettings(
            tenantId,
            parsed.data,
            session!.user.id
        );

        AuditService.logUserAction({
            eventType: 'tenant.settings.updated',
            severity: 'medium',
            apiRoute: 'PUT /api/tenants/settings',
            httpMethod: 'PUT',
            action: 'Updated Settings',
            resourceType: 'tenant',
            resourceId: tenantId,
            resourceName: parsed.data.name,
            user: session!.user.email || session!.user.id,
            userType: 'user',
            status: 'success',
            details: `Updated organization settings: name="${parsed.data.name}", timezone="${parsed.data.timezone}"`,
            metadata: { tenantId, ...parsed.data },
        }).catch(() => {});

        console.log(`API - PUT /api/tenants/settings - Updated settings for tenant ${tenantId}`);
        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("API - PUT /api/tenants/settings - Error:", error);
        AuditService.logUserAction({
            eventType: 'tenant.settings.updated',
            severity: 'medium',
            apiRoute: 'PUT /api/tenants/settings',
            httpMethod: 'PUT',
            action: 'Updated Settings',
            resourceType: 'tenant',
            resourceId: 'unknown',
            resourceName: 'unknown',
            user: 'unknown',
            userType: 'user',
            status: 'error',
            details: `Failed to update settings: ${error instanceof Error ? error.message : 'Unknown error'}`,
            metadata: {},
        }).catch(() => {});
        return NextResponse.json({ error: "Failed to update settings" }, { status: 500 });
    }
}
