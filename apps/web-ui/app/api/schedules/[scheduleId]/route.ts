import { NextRequest, NextResponse } from 'next/server';
import { ScheduleService } from '@/lib/schedule-service';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]/route';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import type { RouteAuthz } from '@nucleus/rbac';

/** Layer 1 permission declaration — see lib/rbac/rbac-allowlist.ts for the public set. */
export const authz: RouteAuthz = {
    GET: { action: 'read', subject: 'Schedule' },
    PUT: { action: 'update', subject: 'Schedule' },
    DELETE: { action: 'delete', subject: 'Schedule' },
};

// GET /api/schedules/[scheduleId] - Get a specific schedule by ID
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ scheduleId: string }> }
) {
    try {
        const { scheduleId } = await params;
        const tenantId = await getSessionTenantId();
        const schedule = await ScheduleService.getSchedule(scheduleId, undefined, tenantId);

        if (!schedule) {
            return NextResponse.json(
                { error: 'Schedule not found' },
                { status: 404 }
            );
        }

        return NextResponse.json(schedule);
    } catch (error) {
        console.error('Error fetching schedule:', error);
        return NextResponse.json(
            { error: 'Failed to fetch schedule' },
            { status: 500 }
        );
    }
}

// PUT /api/schedules/[scheduleId] - Update a specific schedule
export async function PUT(
    request: NextRequest,
    { params }: { params: Promise<{ scheduleId: string }> }
) {
    try {
        const { scheduleId } = await params;
        const session = await getServerSession(authOptions);
        const updatedBy = session?.user?.email || 'api-user';
        const tenantId = await getSessionTenantId();

        const body = await request.json();

        // Pre-flight ownership check (D-03) — also resolves name → UUID
        const existing = await ScheduleService.getSchedule(scheduleId, undefined, tenantId);
        if (!existing) {
            return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });
        }

        // Layer 2 — resource-aware. Deliberately AFTER the row is loaded and
        // BEFORE it is mutated: authorizing on the request body would let the
        // caller choose the accountId a condition is evaluated against.
        const authError = await authorize('update', 'Schedule', {
            accountId: existing.accountId,
            active: existing.active,
            timezone: existing.timezone,
        });
        if (authError) return authError;

        // Use the resolved UUID (existing.id), not the URL param which may be a name
        const updateData = { ...body, id: existing.id, updatedBy };
        const updatedSchedule = await ScheduleService.updateSchedule(existing.id, updateData, undefined, tenantId);

        return NextResponse.json(updatedSchedule);
    } catch (error) {
        console.error('Error updating schedule:', error);
        return NextResponse.json(
            { error: 'Failed to update schedule' },
            { status: 500 }
        );
    }
}

// DELETE /api/schedules/[scheduleId] - Delete a specific schedule
export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ scheduleId: string }> }
) {
    try {
        const { scheduleId } = await params;
        const session = await getServerSession(authOptions);
        const deletedBy = session?.user?.email || 'api-user';
        const tenantId = await getSessionTenantId();

        // Pre-flight ownership check (D-03)
        const existing = await ScheduleService.getSchedule(scheduleId, undefined, tenantId);
        if (!existing) {
            return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });
        }

        // Layer 2 — load, authorize, then mutate (never authorize on the body).
        const authError = await authorize('delete', 'Schedule', {
            accountId: existing.accountId,
            active: existing.active,
            timezone: existing.timezone,
        });
        if (authError) return authError;

        // Use the resolved UUID (existing.id), not the URL param which may be a name
        await ScheduleService.deleteSchedule(existing.id, undefined, deletedBy, tenantId);

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Error deleting schedule:', error);
        return NextResponse.json(
            { error: 'Failed to delete schedule' },
            { status: 500 }
        );
    }
}
