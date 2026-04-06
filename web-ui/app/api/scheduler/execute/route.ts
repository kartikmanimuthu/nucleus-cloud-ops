import { NextResponse } from "next/server";
import { AuditService } from "@/lib/audit-service";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth-options";
import { authorize } from "@/lib/rbac/authorize";
import { getSessionTenantId } from "@/lib/auth-session";
import { getBoss } from "@/lib/boss-client";

export async function POST() {
    const authError = await authorize('execute', 'Schedule');
    if (authError) return authError;

    try {
        console.log(`[API] Execute Now (Full Scan) triggered`);

        const session = await getServerSession(authOptions);
        const userEmail = session?.user?.email;
        const tenantId = await getSessionTenantId();

        if (!tenantId) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
        }

        const executionTime = new Date().toISOString();

        try {
            const payload = {
                triggeredBy: 'web-ui',
                userEmail: userEmail || 'unknown-web-user',
                tenantId,
            };

            // Send to per-tenant queue (matches workers/src/jobs/scheduler/index.ts registration)
            const queueName = `scheduler-scan:${tenantId}`;
            console.log(`[API] Enqueuing job to ${queueName}`, payload);

            const boss = await getBoss();
            await boss.send(queueName, payload);

        } catch (enqueueError) {
            console.error(`[API] Job enqueue failed:`, enqueueError);
            const errorMessage = enqueueError instanceof Error ? enqueueError.message : String(enqueueError);

            await AuditService.logUserAction({
                action: "Execute Full Scan",
                resourceType: "scheduler",
                resourceId: "full-scan",
                resourceName: "Scheduler Full Scan",
                status: 'error',
                details: `Manual full scan triggering failed: ${errorMessage}`,
                user: userEmail || "unknown-web-user",
                userType: "user",
                tenantId,
            });

            return NextResponse.json(
                { success: false, error: errorMessage, message: "Failed to enqueue scan job" },
                { status: 500 }
            );
        }

        await AuditService.logUserAction({
            action: "Execute Full Scan",
            resourceType: "scheduler",
            resourceId: "full-scan",
            resourceName: "Scheduler Full Scan",
            status: 'success',
            details: `Manual full scan triggered via Dashboard (Async). Execution running in background.`,
            user: userEmail || "unknown-web-user",
            userType: "user",
            tenantId,
        });

        return NextResponse.json({
            success: true,
            message: "Full scan execution triggered successfully (Background)",
            executionTime,
            executionStatus: 'success',
            isAsync: true
        });

    } catch (error) {
        console.error("[API] Error executing full scan:", error);
        const errorMessage = error instanceof Error ? error.message : "Failed to execute full scan";
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}
