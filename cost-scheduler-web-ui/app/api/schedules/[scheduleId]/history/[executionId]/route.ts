import { NextRequest, NextResponse } from "next/server";
import { ScheduleExecutionService } from "@/lib/schedule-execution-service";
import { ScheduleService } from "@/lib/schedule-service";

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ scheduleId: string; executionId: string }> }
) {
    try {
        const { scheduleId, executionId } = await params;

        if (!scheduleId || !executionId) {
            return NextResponse.json(
                { error: "Schedule ID and Execution ID are required" },
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

        // Fetch single execution
        const execution = await ScheduleExecutionService.getExecutionById(
            scheduleId,
            executionId
        );

        if (!execution) {
            return NextResponse.json(
                { error: "Execution not found" },
                { status: 404 }
            );
        }

        return NextResponse.json({
            success: true,
            execution,
            schedule: {
                id: schedule.id,
                name: schedule.name,
            }
        });

    } catch (error: any) {
        console.error("[API] Error fetching execution details:", error);
        return NextResponse.json(
            { error: error.message || "Failed to fetch execution details" },
            { status: 500 }
        );
    }
}
