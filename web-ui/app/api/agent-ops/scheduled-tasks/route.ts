/**
 * GET  /api/agent-ops/scheduled-tasks  — list tasks for tenant
 * POST /api/agent-ops/scheduled-tasks  — create task
 */

import { NextResponse } from 'next/server';
import { listScheduledTasks, createScheduledTask } from '@/lib/agent-ops/scheduled-task-service';
import { registerTask } from '@/lib/agent-ops/scheduler-engine';
import { getSessionTenantId } from '@/lib/auth-session';

export async function GET() {
    try {
        const tenantId = await getSessionTenantId();
        const tasks = await listScheduledTasks(tenantId);
        return NextResponse.json({ tasks });
    } catch (err) {
        return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal server error' }, { status: 500 });
    }
}

export async function POST(req: Request) {
    try {
        const tenantId = await getSessionTenantId();
        const body = await req.json();
        const task = await createScheduledTask({
            tenantId,
            name: body.name,
            description: body.description,
            cronExpression: body.cronExpression,
            timezone: body.timezone || 'UTC',
            mode: body.mode || 'plan',
            autoApprove: body.autoApprove ?? false,
            model: body.model,
            accountId: body.accountId,
            accountName: body.accountName,
            mcpServerIds: body.mcpServerIds,
            notification: body.notification || { type: 'none' },
            createdBy: body.createdBy || 'api',
        });
        registerTask(task);
        return NextResponse.json({ task }, { status: 201 });
    } catch (err) {
        return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal server error' }, { status: 500 });
    }
}
