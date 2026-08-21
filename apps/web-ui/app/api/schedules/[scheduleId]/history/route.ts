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

        const tenantId = await getSessionTenantId();

        // Verify schedule exists
        const schedule = await ScheduleService.getSchedule(scheduleId, undefined, tenantId);
        if (!schedule) {
            return NextResponse.json(
                { error: "Schedule not found" },
                { status: 404 }
            );
        }

        // Parse query parameters — server-side pagination.
        const searchParams = request.nextUrl.searchParams;
        const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
        const rawLimit = parseInt(searchParams.get("limit") || "10", 10) || 10;
        const limit = Math.min(100, Math.max(1, rawLimit));

        // Fetch a page of execution history + the total count for this schedule.
        const { executions, total } = await ScheduleExecutionService.getExecutionsPageForSchedule(
            scheduleId,
            tenantId ?? "",
            { page, limit },
        );

        return NextResponse.json({
            success: true,
            scheduleId,
            scheduleName: schedule.name,
            executions,
            total,
            page,
            limit,
        });

    } catch (error: any) {
        console.error("[API] Error fetching execution history:", error);
        return NextResponse.json(
            { error: error.message || "Failed to fetch execution history" },
            { status: 500 }
        );
    }
}
