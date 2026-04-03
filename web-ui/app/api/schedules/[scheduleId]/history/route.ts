import { NextRequest, NextResponse } from "next/server";
import { ScheduleExecutionService } from "@/lib/schedule-execution-service";
import { ScheduleService } from "@/lib/schedule-service";
import { getSessionTenantId } from "@/lib/auth-session";

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ scheduleId: string }> }
) {
    try {
        const { scheduleId } = await params;
        const tenantId = await getSessionTenantId();

        if (!scheduleId) {
            return NextResponse.json(
                { error: "Schedule ID is required" },
                { status: 400 }
            );
        }

        // Verify schedule exists within tenant scope
        const schedule = await ScheduleService.getSchedule(scheduleId, undefined, tenantId);
        if (!schedule) {
            return NextResponse.json(
                { error: "Schedule not found" },
                { status: 404 }
            );
        }

        // Parse query parameters
        const searchParams = request.nextUrl.searchParams;
        const limit = parseInt(searchParams.get("limit") || "50", 10);

        // Fetch execution history scoped to tenant
        const executions = await ScheduleExecutionService.getExecutionsForSchedule(
            scheduleId,
            (schedule.accounts && schedule.accounts[0]) || "unknown",
            { limit },
            tenantId,
        );

        return NextResponse.json({
            success: true,
            scheduleId,
            scheduleName: schedule.name,
            executions,
            total: executions.length
        });

    } catch (error: any) {
        console.error("[API] Error fetching execution history:", error);
        return NextResponse.json(
            { error: error.message || "Failed to fetch execution history" },
            { status: 500 }
        );
    }
}
