import { NextRequest, NextResponse } from "next/server";
import { ScheduleExecutionService } from "@/lib/schedule-execution-service";
import { ScheduleService } from "@/lib/schedule-service";

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ scheduleId: string }> }
) {
    try {
        const { scheduleId } = await params;

        if (!scheduleId) {
            return NextResponse.json(
                { error: "Schedule ID is required" },
                { status: 400 }
            );
        }

        // Verify schedule exists
        const schedule = await ScheduleService.getSchedule(scheduleId);
        if (!schedule) {
            return NextResponse.json(
                { error: "Schedule not found" },
                { status: 404 }
            );
        }

        // Parse query parameters
        const searchParams = request.nextUrl.searchParams;
        const limit = parseInt(searchParams.get("limit") || "50", 10);
        const accountId = (schedule.accounts && schedule.accounts[0]) || "unknown";

        // Fetch execution history
        const executions = await ScheduleExecutionService.getExecutionsForSchedule(
            scheduleId,
            accountId,
            'default', // tenantId
            { limit }
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
