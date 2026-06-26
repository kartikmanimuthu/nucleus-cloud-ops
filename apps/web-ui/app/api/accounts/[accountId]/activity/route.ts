import { NextRequest, NextResponse } from 'next/server';
import { AuditService } from '@/lib/audit-service';
import { ScheduleExecutionService } from '@/lib/schedule-execution-service';
import { getSessionTenantId } from '@/lib/auth-session';

// GET /api/accounts/[accountId]/activity - Get recent activity logs for this account
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

        const decodedAccountId = decodeURIComponent(accountId);
        const tenantId = await getSessionTenantId();

        // Fetch audit logs
        const auditPromise = AuditService.getAuditLogs({
            limit: 100,
        }, tenantId);

        // Fetch schedule executions
        const executionsPromise = ScheduleExecutionService.getRecentExecutions({
            limit: 100,
        });

        const [{ logs }, executions] = await Promise.all([auditPromise, executionsPromise]);

        // Filter logs related to this account
        const accountLogs = logs.filter((log) => {
            if (log.accountId === decodedAccountId) return true;
            if (log.metadata?.accountId === decodedAccountId) return true;
            if (log.resourceId?.includes(decodedAccountId)) return true;
            return false;
        });

        // Transform audit logs to activity format
        const logActivities = accountLogs.map((log) => ({
            id: log.id,
            timestamp: log.timestamp,
            action: log.action,
            details: log.details,
            status: log.status,
            resourceType: log.resourceType,
            resourceName: log.resource,
            metadata: log.metadata,
        }));

        // Filter executions related to this account
        const accountExecutions = executions.filter(
            (exec) => exec.accountId === decodedAccountId
        );

        // Transform executions to activity format
        const executionActivities = accountExecutions.map((exec) => {
            const resourceCount =
                (exec.resourcesStarted || 0) +
                (exec.resourcesStopped || 0) +
                (exec.resourcesFailed || 0);

            return {
                id: exec.executionId,
                timestamp: exec.executionTime,
                action: 'Schedule Execution',
                details: `Schedule execution finished. Actioned ${resourceCount} resources (${exec.resourcesFailed || 0} failed).`,
                status: exec.status === 'success' ? 'success' : (exec.status === 'partial' || exec.status === 'failed' ? 'error' : 'info'),
                resourceType: 'schedule',
                resourceName: exec.scheduleId, // Ideally this would be the name, but ID is what we have on the record
                metadata: {
                    scheduleId: exec.scheduleId,
                    duration: exec.duration,
                    ...exec.schedule_metadata
                },
            };
        });

        // Merge and sort
        const activity = [...logActivities, ...executionActivities].sort(
            (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );

        return NextResponse.json({
            activity,
            total: activity.length,
            accountId: decodedAccountId,
        });
    } catch (error: any) {
        console.error('Error fetching activity for account:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to fetch activity' },
            { status: 500 }
        );
    }
}
