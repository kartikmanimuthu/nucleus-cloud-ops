/**
 * GET  /api/agent-ops/scheduled-tasks  — list tasks for tenant
 * POST /api/agent-ops/scheduled-tasks  — create task
 */

import { NextResponse } from 'next/server';
import { listScheduledTasks, createScheduledTask, validateScheduleInput } from '@/lib/agent-ops/scheduled-task-service';
import { registerTask } from '@/lib/agent-ops/scheduler-engine';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import type { TaskListQuery } from '@/lib/db/repositories/scheduled-task/interface';

const VALID_SORT_FIELDS: TaskListQuery['sortBy'][] = ['name', 'taskStatus', 'nextRunAt', 'lastRunAt', 'createdAt', 'updatedAt', 'runCount'];

export async function GET(req: Request) {
    try {
        const tenantId = await getSessionTenantId();
        const url = new URL(req.url);
        const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
        const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit') || '25', 10)));
        const sortByParam = url.searchParams.get('sortBy') as TaskListQuery['sortBy'] | null;
        const sortBy = sortByParam && VALID_SORT_FIELDS.includes(sortByParam) ? sortByParam : 'createdAt';
        const sortDir = url.searchParams.get('sortDir') === 'asc' ? 'asc' : 'desc';

        const { tasks, total, stats } = await listScheduledTasks({
            tenantId,
            page,
            limit,
            sortBy,
            sortDir,
        });

        return NextResponse.json({ success: true, data: tasks, total, stats });
    } catch (err) {
        return NextResponse.json({ success: false, error: err instanceof Error ? err.message : 'Internal server error' }, { status: 500 });
    }
}

export async function POST(req: Request) {
    try {
        const tenantId = await getSessionTenantId();
        const body = await req.json();

        const scheduleError = validateScheduleInput(body);
        if (scheduleError) {
            return NextResponse.json({ error: scheduleError }, { status: 400 });
        }
        const scheduleType = body.scheduleType === 'interval' ? 'interval' as const : 'cron' as const;

        const task = await createScheduledTask({
            tenantId,
            name: body.name,
            description: body.description,
            scheduleType,
            cronExpression: scheduleType === 'interval' ? '' : body.cronExpression,
            intervalMinutes: scheduleType === 'interval' ? Number(body.intervalMinutes) : undefined,
            timezone: body.timezone || 'UTC',
            // Agent Ops is plan-mode only — autonomous runs always take the
            // planner → final → memory_save path regardless of what the client sends.
            mode: 'plan',
            autoApprove: body.autoApprove ?? false,
            model: body.model,
            accountId: body.accountId,
            accountName: body.accountName,
            mcpServerIds: body.mcpServerIds,
            knowledgeBaseIds: body.knowledgeBaseIds,
            notification: body.notification || { type: 'none' },
            createdBy: body.createdBy || 'api',
        });
        registerTask(task);

        const session = await getAuthSession();
        AuditService.logUserAction({
            eventType: 'agent.task.created',
            severity: 'medium',
            apiRoute: 'POST /api/agent-ops/scheduled-tasks',
            httpMethod: 'POST',
            action: 'Created Scheduled Task',
            resourceType: 'agent',
            resourceId: task.taskId,
            resourceName: task.name || task.taskId,
            user: session?.user?.email || 'unknown',
            userType: 'user',
            status: 'success',
            details: `Created scheduled task "${task.name}"`,
            metadata: { tenantId },
        }).catch(() => {});

        return NextResponse.json({ task }, { status: 201 });
    } catch (err) {
        return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal server error' }, { status: 500 });
    }
}
