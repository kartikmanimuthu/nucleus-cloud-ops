import { NextResponse } from 'next/server';
import { getScheduledTask, pauseScheduledTask } from '@/lib/agent-ops/scheduled-task-service';
import { cancelActiveRunsForTask } from '@/lib/agent-ops/agent-ops-service';
import { unregisterTask } from '@/lib/agent-ops/scheduler-engine';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import type { RouteAuthz } from '@nucleus/rbac';

/** Layer 1 permission declaration — see lib/rbac/rbac-allowlist.ts for the public set. */
export const authz: RouteAuthz = {
    POST: { action: 'update', subject: 'ScheduledTask' },
};

export async function POST(req: Request, { params }: { params: Promise<{ taskId: string }> }) {
    try {
        const { taskId } = await params;
        const tenantId = await getSessionTenantId();

        // Pre-flight ownership check (D-08)
        const task = await getScheduledTask(tenantId, taskId);
        if (!task) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });

        unregisterTask(taskId);
        await pauseScheduledTask(tenantId, taskId);
        // Stop any run the task already launched (an on-time cron tick can create a
        // run seconds before the user pauses). Never let this block the pause itself.
        const cancelledRuns = await cancelActiveRunsForTask(tenantId, taskId).catch((err) => {
            console.error(`[pause] Failed to cancel active runs for task ${taskId}:`, err);
            return [] as string[];
        });

        const session = await getAuthSession();
        AuditService.logUserAction({
            eventType: 'agent.task.paused',
            severity: 'medium',
            apiRoute: 'POST /api/agent-ops/scheduled-tasks/[taskId]/pause',
            httpMethod: 'POST',
            action: 'Paused Scheduled Task',
            resourceType: 'agent',
            resourceId: taskId,
            resourceName: task.name || taskId,
            user: session?.user?.email || 'unknown',
            userType: 'user',
            status: 'success',
            details: `Paused scheduled task "${task.name || taskId}"`,
            metadata: { tenantId, cancelledRuns: cancelledRuns.length },
        }).catch(() => {});

        return NextResponse.json({ success: true, cancelledRuns: cancelledRuns.length });
    } catch (err) {
        return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal server error' }, { status: 500 });
    }
}
