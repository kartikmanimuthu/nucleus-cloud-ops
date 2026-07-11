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
    validateScheduleInput,
} from '@/lib/agent-ops/scheduled-task-service';
import type { UpdateScheduledTaskParams } from '@/lib/db/repositories/scheduled-task/interface';
import { registerTask, unregisterTask } from '@/lib/agent-ops/scheduler-engine';
import { cancelActiveRunsForTask } from '@/lib/agent-ops/agent-ops-service';
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

        // Whitelist the mutable fields — a raw pass-through would let clients
        // set lifecycle columns (runCount, taskStatus, nextRunAt, …) directly.
        // mode is intentionally NOT accepted: Agent Ops is plan-mode only.
        const updates: UpdateScheduledTaskParams = {};
        if (body.name !== undefined) updates.name = body.name;
        if (body.description !== undefined) updates.description = body.description;
        if (body.scheduleType !== undefined) updates.scheduleType = body.scheduleType;
        if (body.cronExpression !== undefined) updates.cronExpression = body.cronExpression;
        if (body.intervalMinutes !== undefined) updates.intervalMinutes = body.intervalMinutes;
        if (body.timezone !== undefined) updates.timezone = body.timezone;
        if (body.autoApprove !== undefined) updates.autoApprove = body.autoApprove;
        if (body.model !== undefined) updates.model = body.model;
        if (body.accountId !== undefined) updates.accountId = body.accountId;
        if (body.accountName !== undefined) updates.accountName = body.accountName;
        if (body.mcpServerIds !== undefined) updates.mcpServerIds = body.mcpServerIds;
        if (body.knowledgeBaseIds !== undefined) updates.knowledgeBaseIds = body.knowledgeBaseIds;
        if (body.notification !== undefined) updates.notification = body.notification;

        // Validate the schedule as it will look AFTER the update.
        if (updates.scheduleType !== undefined || updates.cronExpression !== undefined || updates.intervalMinutes !== undefined) {
            const merged = {
                scheduleType: updates.scheduleType ?? existing.scheduleType,
                cronExpression: updates.cronExpression ?? existing.cronExpression,
                intervalMinutes: updates.intervalMinutes ?? existing.intervalMinutes,
            };
            const scheduleError = validateScheduleInput(merged);
            if (scheduleError) {
                return NextResponse.json({ error: scheduleError }, { status: 400 });
            }
            if (merged.scheduleType === 'interval') updates.cronExpression = '';
        }

        const task = await updateScheduledTask(tenantId, taskId, updates);
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
        // A deleted task must not keep executing a run it already launched.
        await cancelActiveRunsForTask(tenantId, taskId).catch((err) => {
            console.error(`[delete] Failed to cancel active runs for task ${taskId}:`, err);
        });

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
