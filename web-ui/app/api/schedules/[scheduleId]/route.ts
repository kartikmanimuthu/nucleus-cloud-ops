import { NextRequest, NextResponse } from 'next/server';
import { ScheduleService } from '@/lib/schedule-service';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]/route';
import { getSessionTenantId } from '@/lib/auth-session';

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
        const updateData = { ...body, id: scheduleId, updatedBy };

        // Pre-flight ownership check (D-03)
        const existing = await ScheduleService.getSchedule(scheduleId, undefined, tenantId);
        if (!existing) {
            return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });
        }

        const updatedSchedule = await ScheduleService.updateSchedule(scheduleId, updateData, undefined, tenantId);

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

        await ScheduleService.deleteSchedule(scheduleId, undefined, deletedBy, tenantId);

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Error deleting schedule:', error);
        return NextResponse.json(
            { error: 'Failed to delete schedule' },
            { status: 500 }
        );
    }
}
