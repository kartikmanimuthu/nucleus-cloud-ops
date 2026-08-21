import { NextRequest, NextResponse } from 'next/server';
import { ScheduleService } from '@/lib/schedule-service';

import { getServerSession } from 'next-auth';
import { authOptions } from '../auth/[...nextauth]/route';
import { authorize } from '@/lib/rbac/authorize';
import { getReadRowFilter } from '@/lib/rbac/row-filter';
import { getSessionTenantId } from '@/lib/auth-session';

// GET /api/schedules - Get all schedules with optional filtering
export async function GET(request: NextRequest) {
    // Authorization check
    const authError = await authorize('read', 'Schedule');
    if (authError) return authError;

    try {        // Get query parameters for filtering
        const { searchParams } = new URL(request.url);
        const statusFilter = searchParams.get('status') || undefined;
        const resourceFilter = searchParams.get('resource') || undefined;
        const searchTerm = searchParams.get('search') || undefined;
        const page = parseInt(searchParams.get('page') || '1', 10);
        const limit = parseInt(searchParams.get('limit') || '10', 10);

        const filters = {
            statusFilter,
            resourceFilter,
            searchTerm,
            page,
            limit,
            tenantId: await getSessionTenantId(),
            // Gate 3. authorize() above settled WHETHER this caller may list
            // schedules; this settles WHICH ones, in SQL, so page counts stay
            // honest.
            rowFilter: await getReadRowFilter('Schedule'),
        };

        // Fetch schedules with optional filters
        const { schedules, total } = await ScheduleService.getSchedules(filters);

        return NextResponse.json({
            success: true,
            data: schedules,
            count: schedules.length,
            meta: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit)
            }
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
    // Authorization check - create requires manage permission
    const authError = await authorize('create', 'Schedule');
    if (authError) return authError;

    let tenantId: string | undefined;
    try {
        console.log('API - Creating new schedule');

        const session = await getServerSession(authOptions);
        const createdBy = session?.user?.email || 'api-user';
        tenantId = await getSessionTenantId();

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

        // Validate start and end times are different
        if (body.starttime === body.endtime) {
            return NextResponse.json(
                {
                    success: false,
                    error: 'Start time and end time must be different',
                },
                { status: 400 }
            );
        }

        // Create schedule — map accountId → accounts array for the repository
        // ScheduleService.createSchedule already logs audit events internally
        const schedule = await ScheduleService.createSchedule({
            ...body,
            accounts: [body.accountId],
            active: body.active !== undefined ? body.active : true,
            createdBy,
            updatedBy: createdBy
        }, tenantId);

        return NextResponse.json({
            success: true,
            data: schedule,
            message: `Schedule "${body.name}" created successfully`
        }, { status: 201 });
    } catch (error: unknown) {
        console.error('API - Error creating schedule:', error);

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
