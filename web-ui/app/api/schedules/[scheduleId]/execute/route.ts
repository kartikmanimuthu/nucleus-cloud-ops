import { NextRequest, NextResponse } from "next/server";
import { ScheduleService } from "@/lib/schedule-service";
import { AuditService } from "@/lib/audit-service";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth-options";
import { authorize } from "@/lib/rbac/authorize";
import { getSessionTenantId } from "@/lib/auth-session";
import { getBoss } from "@/lib/boss-client";

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ scheduleId: string }> }
) {
    // Check authorization - execute action on Schedule subject
    const authError = await authorize('execute', 'Schedule');
    if (authError) return authError;

    try {
        const { scheduleId } = await params;
        const tenantId = await getSessionTenantId();
        console.log(`[API] Execute Now triggered for schedule ${scheduleId}`);

        if (!scheduleId) {
            return NextResponse.json(
                { error: "Schedule ID is required" },
                { status: 400 }
            );
        }

        // 1. Fetch schedule to verify existence
        const schedule = await ScheduleService.getSchedule(scheduleId, undefined, tenantId);
        if (!schedule) {
            console.log(`[API] Schedule ${scheduleId} not found`);
            return NextResponse.json(
                { error: "Schedule not found" },
                { status: 404 }
            );
        }

        // Get user session
        const session = await getServerSession(authOptions);
        const userEmail = session?.user?.email;

        const executionTime = new Date().toISOString();

        // 2. Enqueue partial scan job via pg-boss (fire-and-forget)
        try {
            const payload = {
                scheduleId: schedule.id,
                scheduleName: schedule.name,
                triggeredBy: 'web-ui',
                userEmail: userEmail || 'unknown-web-user',
                tenantId,
            };

            console.log(`[API] Enqueuing scheduler-scan job for schedule ${schedule.id} with payload:`, payload);

            const boss = await getBoss();
            await boss.send('scheduler-scan', payload);

        } catch (enqueueError) {
            console.error(`[API] Job enqueue failed:`, enqueueError);

            const errorMessage = enqueueError instanceof Error ? enqueueError.message : String(enqueueError);

            // Log audit for failure
            await AuditService.logResourceAction({
                action: "Execute Schedule",
                resourceType: "schedule",
                resourceId: schedule.id,
                resourceName: schedule.name,
                status: 'error',
                details: `Manual execution enqueue failed: ${errorMessage}`,
                user: userEmail || "unknown-web-user",
                source: "platform",
                tenantId,
                metadata: { tenantId },
            });

            return NextResponse.json(
                {
                    success: false,
                    error: errorMessage,
                    message: "Failed to enqueue scan job"
                },
                { status: 500 }
            );
        }

        // 3. Update schedule metadata
        await ScheduleService.updateSchedule(schedule.id, {
            lastExecution: executionTime,
            executionCount: (schedule.executionCount || 0) + 1,
            active: true
        }, (schedule.accounts && schedule.accounts[0]) || 'unknown', tenantId);

        // 4. Log Audit
        await AuditService.logResourceAction({
            action: "Execute Schedule",
            resourceType: "schedule",
            resourceId: schedule.id,
            resourceName: schedule.name,
            status: 'success',
            details: `Manual execution triggered via Dashboard (Async). Execution running in background.`,
            user: userEmail || "unknown-web-user",
            source: "platform",
            tenantId,
            metadata: { tenantId },
        });

        return NextResponse.json({
            success: true,
            message: "Schedule execution triggered successfully (Background)",
            executionTime,
            executionStatus: 'success',
            isAsync: true
        });

    } catch (error) {
        console.error("[API] Error executing schedule:", error);
        const errorMessage = error instanceof Error ? error.message : "Failed to execute schedule";
        return NextResponse.json(
            { error: errorMessage },
            { status: 500 }
        );
    }
}
