import { NextRequest, NextResponse } from 'next/server';
import { EventBridgeClient, DescribeRuleCommand, PutRuleCommand } from '@aws-sdk/client-eventbridge';
import { AuditService } from '@/lib/audit-service';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { getSessionTenantId } from '@/lib/auth-session';

// Get AWS configuration
const region = process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || 'ap-south-1';
const EVENTBRIDGE_RULE_NAME = process.env.EVENTBRIDGE_RULE_NAME || 'cost-optimization-scheduler-rule';

// Create EventBridge client
const getEventBridgeClient = () => {
    return new EventBridgeClient({ region });
};

// Helper to parse interval from cron expression
const parseIntervalFromCron = (scheduleExpression: string): number => {
    if (scheduleExpression.includes('0/5')) return 5;
    if (scheduleExpression.includes('0,15,30,45')) return 15;
    if (scheduleExpression.includes('0,30')) return 30;
    // For hourly, check for patterns like 'cron(30 * * * ? *)' or 'cron(0 * * * ? *)'
    if (scheduleExpression.match(/cron\(\d+ \* \* \* \? \*\)/)) return 60;
    return 30; // Default
};

// Helper to generate cron expression from interval
const generateCronExpression = (interval: number): string => {
    switch (interval) {
        case 5:
            return 'cron(0/5 * * * ? *)';
        case 15:
            return 'cron(0,15,30,45 * * * ? *)';
        case 30:
            return 'cron(0,30 * * * ? *)';
        case 60:
            // Run at 30 minutes past each hour in UTC (aligns with IST on the hour)
            return 'cron(30 * * * ? *)';
        default:
            throw new Error(`Invalid schedule interval: ${interval}. Supported values are 5, 15, 30, and 60 minutes.`);
    }
};

// GET /api/settings/scheduler - Get current scheduler settings
export async function GET() {
    try {
        const client = getEventBridgeClient();

        const command = new DescribeRuleCommand({
            Name: EVENTBRIDGE_RULE_NAME
        });

        const response = await client.send(command);

        const scheduleExpression = response.ScheduleExpression || '';
        const scheduleInterval = parseIntervalFromCron(scheduleExpression);

        return NextResponse.json({
            success: true,
            data: {
                ruleName: EVENTBRIDGE_RULE_NAME,
                scheduleExpression,
                scheduleInterval,
                ruleState: response.State,
                ruleArn: response.Arn,
                description: response.Description
            }
        });
    } catch (error: any) {
        console.error('Error fetching scheduler settings:', error);

        // Handle specific AWS errors
        if (error.name === 'ResourceNotFoundException') {
            return NextResponse.json(
                { success: false, error: `EventBridge rule '${EVENTBRIDGE_RULE_NAME}' not found` },
                { status: 404 }
            );
        }

        return NextResponse.json(
            { success: false, error: error.message || 'Failed to fetch scheduler settings' },
            { status: 500 }
        );
    }
}

// PUT /api/settings/scheduler - Update scheduler settings
export async function PUT(request: NextRequest) {
    try {
        const session = await getServerSession(authOptions);
        const updatedBy = session?.user?.email || 'api-user';
        const tenantId = await getSessionTenantId();

        const body = await request.json();
        const { scheduleInterval } = body;

        // Validate interval
        if (!scheduleInterval || ![5, 15, 30, 60].includes(scheduleInterval)) {
            return NextResponse.json(
                { success: false, error: 'Invalid scheduleInterval. Must be 5, 15, 30, or 60.' },
                { status: 400 }
            );
        }

        const client = getEventBridgeClient();

        // First, get the current rule to preserve other settings
        const describeCommand = new DescribeRuleCommand({
            Name: EVENTBRIDGE_RULE_NAME
        });

        const currentRule = await client.send(describeCommand);

        // Generate new cron expression
        const newScheduleExpression = generateCronExpression(scheduleInterval);

        // Update the rule with the new schedule
        const putCommand = new PutRuleCommand({
            Name: EVENTBRIDGE_RULE_NAME,
            ScheduleExpression: newScheduleExpression,
            State: currentRule.State, // Preserve current state
            Description: currentRule.Description || `Cost optimization scheduler - runs every ${scheduleInterval} minutes`
        });

        await client.send(putCommand);

        // Log audit entry
        await AuditService.logUserAction({
            action: 'Update Scheduler Settings',
            resourceType: 'settings',
            resourceId: EVENTBRIDGE_RULE_NAME,
            resourceName: 'Scheduler Cron Settings',
            user: updatedBy,
            userType: 'user',
            status: 'success',
            details: `Updated scheduler interval from ${parseIntervalFromCron(currentRule.ScheduleExpression || '')} to ${scheduleInterval} minutes`,
            tenantId,
        });

        return NextResponse.json({
            success: true,
            data: {
                ruleName: EVENTBRIDGE_RULE_NAME,
                scheduleExpression: newScheduleExpression,
                scheduleInterval,
                ruleState: currentRule.State,
                previousInterval: parseIntervalFromCron(currentRule.ScheduleExpression || '')
            },
            message: `Scheduler updated to run every ${scheduleInterval} minutes`
        });
    } catch (error: any) {
        console.error('Error updating scheduler settings:', error);

        // Log audit entry for failure
        try {
            await AuditService.logUserAction({
                action: 'Update Scheduler Settings',
                resourceType: 'settings',
                resourceId: EVENTBRIDGE_RULE_NAME,
                resourceName: 'Scheduler Cron Settings',
                user: 'system',
                userType: 'user',
                status: 'error',
                details: `Failed to update scheduler: ${error.message}`,
                tenantId,
            });
        } catch (auditError) {
            console.error('Failed to log audit entry:', auditError);
        }

        // Handle specific AWS errors
        if (error.name === 'ResourceNotFoundException') {
            return NextResponse.json(
                { success: false, error: `EventBridge rule '${EVENTBRIDGE_RULE_NAME}' not found` },
                { status: 404 }
            );
        }

        if (error.name === 'AccessDeniedException') {
            return NextResponse.json(
                { success: false, error: 'Permission denied. Lambda execution role may not have EventBridge permissions.' },
                { status: 403 }
            );
        }

        return NextResponse.json(
            { success: false, error: error.message || 'Failed to update scheduler settings' },
            { status: 500 }
        );
    }
}
