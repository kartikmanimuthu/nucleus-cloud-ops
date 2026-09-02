/**
 * GET  /api/agent-ops/scheduled-tasks  — list tasks for tenant
 * POST /api/agent-ops/scheduled-tasks  — create task
 */

import { NextResponse } from 'next/server';
import { listScheduledTasks, createScheduledTask, validateScheduleInput } from '@/lib/agent-ops/scheduled-task-service';
import { SELECTABLE_MODES } from '@/lib/agent-ops/types';
import type { AgentMode } from '@/lib/agent-ops/types';
import { registerTask } from '@/lib/agent-ops/scheduler-engine';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { getAbilityForSession } from '@/lib/rbac/session-ability';
import { AuditService } from '@/lib/audit-service';
import type { TaskListQuery } from '@/lib/db/repositories/scheduled-task/interface';
import type { RouteAuthz } from '@nucleus/rbac';

/** Layer 1 permission declaration — see lib/rbac/rbac-allowlist.ts for the public set. */
export const authz: RouteAuthz = {
    GET: { action: 'read', subject: 'ScheduledTask' },
    POST: { action: 'create', subject: 'ScheduledTask' },
};

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

        // The task becomes a STORED GRANT that fires autonomously for as long as
        // it exists, so record WHOSE authority it runs under — from the session,
        // never from the body (`body.createdBy` below is a display string the
        // client controls). lib/agent-ops/scheduled-task-permission.ts recompiles
        // this user's ability at every execution.
        const creatorSession = await getAuthSession();
        const createdByUserId = creatorSession?.user?.id;
        // Role id is a creation-time snapshot for audit/drift only — the
        // execution-time check always re-resolves the CURRENT role.
        const createdByRoleId = (await getAbilityForSession())?.principal.roleId ?? undefined;

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
            // Persisted straight into the ScheduledTask row and later dispatched
            // on by the executor (trigger/route.ts passes mode: task.mode
            // through unchanged) — an unvalidated string here would land in the
            // DB with no matching execution graph. Accept only a mode the
            // client is actually allowed to pick; anything else falls back to
            // 'plan', the pre-deep behaviour.
            mode: (typeof body.mode === 'string' && SELECTABLE_MODES.includes(body.mode as AgentMode))
                ? (body.mode as AgentMode)
                : 'plan',
            autoApprove: body.autoApprove ?? false,
            model: body.model,
            accountId: body.accountId,
            accountName: body.accountName,
            mcpServerIds: body.mcpServerIds,
            knowledgeBaseIds: body.knowledgeBaseIds,
            notification: body.notification || { type: 'none' },
            createdBy: body.createdBy || 'api',
            createdByUserId,
            createdByRoleId,
        });
        registerTask(task);

        const session = creatorSession;
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
