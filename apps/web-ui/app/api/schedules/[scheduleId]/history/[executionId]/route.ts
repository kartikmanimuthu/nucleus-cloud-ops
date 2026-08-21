import { NextRequest, NextResponse } from "next/server";
import { ScheduleExecutionService } from "@/lib/schedule-execution-service";
import { ScheduleService } from "@/lib/schedule-service";
import { getSessionTenantId } from "@/lib/auth-session";
import type { RouteAuthz } from '@nucleus/rbac';

/** Layer 1 permission declaration — see lib/rbac/rbac-allowlist.ts for the public set. */
export const authz: RouteAuthz = {
    GET: { action: 'read', subject: 'Schedule' },
};

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

        const tenantId = await getSessionTenantId();

        // Verify schedule exists
        const schedule = await ScheduleService.getSchedule(scheduleId, undefined, tenantId);
        if (!schedule) {
            return NextResponse.json(
                { error: "Schedule not found" },
                { status: 404 }
            );
        }

        // Fetch single execution
        const execution = await ScheduleExecutionService.getExecutionById(
            scheduleId,
            executionId,
            tenantId,
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
