import { NextRequest, NextResponse } from 'next/server';
import { ScheduleService } from '@/lib/schedule-service';
import { getSessionTenantId } from '@/lib/auth-session';
import type { RouteAuthz } from '@nucleus/rbac';

/** Layer 1 permission declaration — see lib/rbac/rbac-allowlist.ts for the public set. */
export const authz: RouteAuthz = {
    GET: { action: 'read', subject: 'Schedule' },
};

// GET /api/accounts/[accountId]/schedules - Fetch schedules for a specific account
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ accountId: string }> }
) {
    try {
        const { accountId } = await params;

        if (!accountId) {
            return NextResponse.json(
                { error: 'Account ID is required' },
                { status: 400 }
            );
        }

        const tenantId = await getSessionTenantId();

        // Use ScheduleService to fetch schedules filtered by accountId
        const { schedules, total } = await ScheduleService.getSchedules({
            accountId: decodeURIComponent(accountId),
            tenantId,
        });

        return NextResponse.json({
            schedules,
            total,
            accountId: decodeURIComponent(accountId),
        });
    } catch (error: any) {
        console.error('Error fetching schedules for account:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to fetch schedules' },
            { status: 500 }
        );
    }
}
