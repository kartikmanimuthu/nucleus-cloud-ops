import { NextRequest, NextResponse } from 'next/server';
import { ScheduleService } from '@/lib/schedule-service';
import { AuditService } from '@/lib/audit-service';
import { Schedule, UISchedule } from '@/lib/types';

// GET /api/schedules - Get all schedules with optional filtering
export async function GET(request: NextRequest) {
    try {


        // Get query parameters for filtering
        const { searchParams } = new URL(request.url);
        const statusFilter = searchParams.get('status') || undefined;
        const resourceFilter = searchParams.get('resource') || undefined;
        const searchTerm = searchParams.get('search') || undefined;

        const filters = {
            statusFilter,
            resourceFilter,
            searchTerm
        };



        // Fetch schedules with optional filters
        const schedules = await ScheduleService.getSchedules(filters);



        return NextResponse.json({
            success: true,
            data: schedules,
            count: schedules.length,
        });
    } catch (error: unknown) {
        console.error('API - Error fetching schedules:', error);
        return NextResponse.json(
            {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to fetch schedules',
            },
            { status: 500 }
        );
    }
}

// POST /api/schedules - Create a new schedule
export async function POST(request: NextRequest) {
    try {
        console.log('API - Creating new schedule');

        const body = await request.json();

        // Validate required fields
        if (!body.name || !body.starttime || !body.endtime || !body.timezone || !body.days) {
            return NextResponse.json(
                {
                    success: false,
                    error: 'Missing required fields: name, starttime, endtime, timezone, and days are required',
                },
                { status: 400 }
            );
        }

        // Validate accountId if resource selection is intended
        // Note: For backward compatibility, we don't strictly require it yet unless business logic demands it.
        // But the requirement says "schedule has to be created against an account".
        if (!body.accountId) {
            return NextResponse.json(
                {
                    success: false,
                    error: 'Account ID is required',
                },
                { status: 400 }
            );
        }

        // Validate days array
        if (!Array.isArray(body.days) || body.days.length === 0) {
            return NextResponse.json(
                {
                    success: false,
                    error: 'Days must be a non-empty array',
                },
                { status: 400 }
            );
        }

        // Validate timezone
        try {
            Intl.DateTimeFormat(undefined, { timeZone: body.timezone });
        } catch (error) {
            return NextResponse.json(
                {
                    success: false,
                    error: 'Invalid timezone',
                },
                { status: 400 }
            );
        }

        // Create schedule
        const schedule = await ScheduleService.createSchedule({
            ...body,
            active: body.active !== undefined ? body.active : true, // Default to active
        });

        // Log audit event
        await AuditService.logUserAction({
            action: 'Create Schedule',
            resourceType: 'schedule',
            resourceId: schedule.name,
            resourceName: schedule.name,
            user: 'system', // This would be passed from the client in a real implementation
            userType: 'user',
            status: 'success',
            details: `Created schedule "${schedule.name}"`,
        });

        return NextResponse.json({
            success: true,
            data: schedule,
            message: `Schedule "${body.name}" created successfully`
        }, { status: 201 });
    } catch (error: unknown) {
        console.error('API - Error creating schedule:', error);

        // Log audit event for error
        if (error instanceof Error) {
            await AuditService.logUserAction({
                action: 'Create Schedule',
                resourceType: 'schedule',
                resourceId: 'unknown',
                resourceName: 'Unknown Schedule',
                user: 'system',
                userType: 'user',
                status: 'error',
                details: `Failed to create schedule: ${error.message}`,
            });
        }

        // Handle specific DynamoDB errors
        if (error instanceof Error && error.message.includes('already exists')) {
            return NextResponse.json({
                success: false,
                error: error.message
            }, { status: 409 });
        }

        return NextResponse.json(
            {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to create schedule'
            },
            { status: 500 }
        );
    }
}
