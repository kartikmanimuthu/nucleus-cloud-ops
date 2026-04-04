import { NextResponse } from 'next/server';
import { getScheduledTask, updateLastRun } from '@/lib/agent-ops/scheduled-task-service';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { executeAgentRun } from '@/lib/agent-ops/agent-executor';
import { notifyScheduledRunResult } from '@/lib/agent-ops/scheduled-notifier';
import { getSessionTenantId } from '@/lib/auth-session';

export async function POST(req: Request, { params }: { params: Promise<{ taskId: string }> }) {
    try {
        const { taskId } = await params;
        const tenantId = await getSessionTenantId();

        // Pre-flight ownership check (D-08)
        const task = await getScheduledTask(tenantId, taskId);
        if (!task) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });

        const scheduledAt = new Date().toISOString();
        const run = await agentOpsService.createRun({
            tenantId: task.tenantId,
            source: 'scheduled',
            taskDescription: task.description,
            mode: task.mode,
            autoApprove: task.autoApprove,
            model: task.model,
            accountId: task.accountId,
            accountName: task.accountName,
            mcpServerIds: task.mcpServerIds,
            trigger: { taskId: task.taskId, taskName: task.name, scheduledAt },
        });

        // Fire-and-forget
        executeAgentRun(run)
            .then(async () => {
                const freshRun = await agentOpsService.getRun(task.tenantId, run.runId);
                const status = freshRun?.status ?? 'completed';
                await updateLastRun(task.tenantId, task.taskId, run.runId, status);
                if (freshRun) await notifyScheduledRunResult(task, freshRun);
            })
            .catch(err => console.error(`[trigger] Run ${run.runId} failed:`, err));

        return NextResponse.json({ runId: run.runId, status: run.status });
    } catch (err) {
        return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal server error' }, { status: 500 });
    }
}
