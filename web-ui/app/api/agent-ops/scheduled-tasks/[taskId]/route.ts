/**
 * GET    /api/agent-ops/scheduled-tasks/[taskId]  — get task
 * PATCH  /api/agent-ops/scheduled-tasks/[taskId]  — update task
 * DELETE /api/agent-ops/scheduled-tasks/[taskId]  — soft-delete
 */

import { NextResponse } from 'next/server';
import {
    getScheduledTask,
    updateScheduledTask,
    deleteScheduledTask,
} from '@/lib/agent-ops/scheduled-task-service';
import { registerTask, unregisterTask } from '@/lib/agent-ops/scheduler-engine';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';

type Ctx = { params: Promise<{ taskId: string }> };

export async function GET(req: Request, { params }: Ctx) {
    try {
        const { taskId } = await params;
        const tenantId = await getSessionTenantId();
        const task = await getScheduledTask(tenantId, taskId);
        if (!task) return NextResponse.json({ error: 'Not found' }, { status: 404 });
        return NextResponse.json({ task });
    } catch (err) {
        return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal server error' }, { status: 500 });
    }
}

export async function PATCH(req: Request, { params }: Ctx) {
    try {
        const { taskId } = await params;
        const tenantId = await getSessionTenantId();
        const body = await req.json();

        // Pre-flight ownership check (D-08)
        const existing = await getScheduledTask(tenantId, taskId);
        if (!existing) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });

        const task = await updateScheduledTask(tenantId, taskId, body);
        if (!task) return NextResponse.json({ error: 'Not found' }, { status: 404 });
        // Re-register with updated cron if task is active
        if (task.taskStatus === 'active') registerTask(task);

        const session = await getAuthSession();
        AuditService.logUserAction({
            eventType: 'agent.task.updated',
            severity: 'medium',
            apiRoute: 'PUT /api/agent-ops/scheduled-tasks/[taskId]',
            httpMethod: 'PATCH',
            action: 'Updated Scheduled Task',
            resourceType: 'agent',
            resourceId: taskId,
            resourceName: task.name || taskId,
            user: session?.user?.email || 'unknown',
            userType: 'user',
            status: 'success',
            details: `Updated scheduled task "${task.name || taskId}"`,
            metadata: { tenantId },
        }).catch(() => {});

        return NextResponse.json({ task });
    } catch (err) {
        return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal server error' }, { status: 500 });
    }
}

export async function DELETE(req: Request, { params }: Ctx) {
    try {
        const { taskId } = await params;
        const tenantId = await getSessionTenantId();

        // Pre-flight ownership check (D-08)
        const existing = await getScheduledTask(tenantId, taskId);
        if (!existing) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });

        unregisterTask(taskId);
        await deleteScheduledTask(tenantId, taskId);

        const session = await getAuthSession();
        AuditService.logUserAction({
            eventType: 'agent.task.deleted',
            severity: 'medium',
            apiRoute: 'DELETE /api/agent-ops/scheduled-tasks/[taskId]',
            httpMethod: 'DELETE',
            action: 'Deleted Scheduled Task',
            resourceType: 'agent',
            resourceId: taskId,
            resourceName: existing.name || taskId,
            user: session?.user?.email || 'unknown',
            userType: 'user',
            status: 'success',
            details: `Deleted scheduled task "${existing.name || taskId}"`,
            metadata: { tenantId },
        }).catch(() => {});

        return NextResponse.json({ success: true });
    } catch (err) {
        return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal server error' }, { status: 500 });
    }
}
