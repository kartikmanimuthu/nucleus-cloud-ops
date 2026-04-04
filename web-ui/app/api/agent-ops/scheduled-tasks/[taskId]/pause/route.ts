import { NextResponse } from 'next/server';
import { getScheduledTask, pauseScheduledTask } from '@/lib/agent-ops/scheduled-task-service';
import { unregisterTask } from '@/lib/agent-ops/scheduler-engine';
import { getSessionTenantId } from '@/lib/auth-session';

export async function POST(req: Request, { params }: { params: Promise<{ taskId: string }> }) {
    try {
        const { taskId } = await params;
        const tenantId = await getSessionTenantId();

        // Pre-flight ownership check (D-08)
        const task = await getScheduledTask(tenantId, taskId);
        if (!task) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });

        unregisterTask(taskId);
        await pauseScheduledTask(tenantId, taskId);
        return NextResponse.json({ success: true });
    } catch (err) {
        return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal server error' }, { status: 500 });
    }
}
