import { NextRequest, NextResponse } from "next/server";
import { ScheduleService } from "@/lib/schedule-service";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth-options";
import { authorize } from "@/lib/rbac/authorize";
import { getSessionTenantId } from "@/lib/auth-session";

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

        const session = await getServerSession(authOptions);
        const userEmail = session?.user?.email || "unknown-web-user";

        // Existence check + enqueue + metadata update + audit (shared with bulk route)
        const existing = await ScheduleService.getSchedule(scheduleId, undefined, tenantId);
        if (!existing) {
            console.log(`[API] Schedule ${scheduleId} not found`);
            return NextResponse.json(
                { error: "Schedule not found" },
                { status: 404 }
            );
        }

        const { executionTime } = await ScheduleService.executeSchedule(scheduleId, userEmail, tenantId);

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
        const status = errorMessage === "Schedule not found" ? 404 : 500;
        return NextResponse.json(
            { error: errorMessage },
            { status }
        );
    }
}
