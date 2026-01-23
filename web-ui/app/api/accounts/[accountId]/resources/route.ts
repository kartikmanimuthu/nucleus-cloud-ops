import { NextRequest, NextResponse } from 'next/server';
import { ScheduleService } from '@/lib/schedule-service';

// GET /api/accounts/[accountId]/resources - Get aggregated resources from all schedules for this account
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

        // Fetch all schedules for this account
        const { schedules } = await ScheduleService.getSchedules({
            accountId: decodeURIComponent(accountId),
        });

        // Aggregate unique resources from all schedules
        const resourceMap = new Map<string, {
            id: string;
            type: 'ec2' | 'ecs' | 'rds' | 'asg';
            name: string;
            arn?: string;
            clusterArn?: string;
            schedules: string[]; // List of schedule names that include this resource
        }>();

        for (const schedule of schedules) {
            if (schedule.resources && Array.isArray(schedule.resources)) {
                for (const resource of schedule.resources) {
                    const existing = resourceMap.get(resource.id);
                    if (existing) {
                        // Add schedule name if not already present
                        if (!existing.schedules.includes(schedule.name)) {
                            existing.schedules.push(schedule.name);
                        }
                    } else {
                        resourceMap.set(resource.id, {
                            id: resource.id,
                            type: resource.type,
                            name: resource.name || resource.id,
                            arn: resource.arn,
                            clusterArn: resource.clusterArn,
                            schedules: [schedule.name],
                        });
                    }
                }
            }
        }

        const resources = Array.from(resourceMap.values());

        return NextResponse.json({
            resources,
            total: resources.length,
            accountId: decodeURIComponent(accountId),
        });
    } catch (error: any) {
        console.error('Error fetching resources for account:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to fetch resources' },
            { status: 500 }
        );
    }
}
