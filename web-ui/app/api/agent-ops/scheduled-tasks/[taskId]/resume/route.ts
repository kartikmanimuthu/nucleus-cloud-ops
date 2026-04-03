import { NextResponse } from 'next/server';
import { getScheduledTask, resumeScheduledTask } from '@/lib/agent-ops/scheduled-task-service';
import { registerTask } from '@/lib/agent-ops/scheduler-engine';
import { getSessionTenantId } from '@/lib/auth-session';

export async function POST(req: Request, { params }: { params: Promise<{ taskId: string }> }) {
    try {
        const { taskId } = await params;
        const tenantId = await getSessionTenantId();

        // Pre-flight ownership check (D-08)
        const existing = await getScheduledTask(tenantId, taskId);
        if (!existing) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });

        const task = await resumeScheduledTask(tenantId, taskId);
        if (!task) return NextResponse.json({ error: 'Not found' }, { status: 404 });
        registerTask(task);
        return NextResponse.json({ task });
    } catch (err) {
        return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal server error' }, { status: 500 });
    }
}
