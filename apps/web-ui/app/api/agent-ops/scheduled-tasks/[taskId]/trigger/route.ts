import { NextResponse } from 'next/server';
import { getScheduledTask, updateLastRun, tryAcquireExecutionLock } from '@/lib/agent-ops/scheduled-task-service';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { executeAgentRun } from '@/lib/agent-ops/agent-executor';
import { finalizeScheduledRun } from '@/lib/agent-ops/scheduled-notifier';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { env } from '@/env';

const INTERNAL_API_KEY = env.INTERNAL_API_KEY || 'internal-worker-key';

/**
 * Resolve tenantId from either session auth or internal worker header.
 * Workers pass x-internal-key + x-tenant-id to bypass NextAuth session.
 */
async function resolveTenantId(req: Request): Promise<string> {
    const internalKey = req.headers.get('x-internal-key');
    if (internalKey === INTERNAL_API_KEY) {
        const tenantId = req.headers.get('x-tenant-id');
        if (!tenantId) throw new Error('x-tenant-id header required for internal calls');
        return tenantId;
    }
    return getSessionTenantId();
}

export async function POST(req: Request, { params }: { params: Promise<{ taskId: string }> }) {
    try {
        const { taskId } = await params;
        const tenantId = await resolveTenantId(req);

        const task = await getScheduledTask(tenantId, taskId);
        if (!task) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });

        // A stale cron tick (or a race with pause/delete) must not execute an
        // autonomous AWS-mutating run for a task that is no longer active.
        if (task.taskStatus !== 'active') {
            return NextResponse.json(
                { success: false, skipped: true, error: `Task is ${task.taskStatus} — trigger suppressed` },
                { status: 409 },
            );
        }

        // Suppress duplicate triggers in the same minute window — a cron tick
        // racing a manual trigger across ECS containers (AOPS-04).
        const lockWindow = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
        const lockAcquired = await tryAcquireExecutionLock(taskId, lockWindow);
        if (!lockAcquired) {
            return NextResponse.json(
                { success: false, skipped: true, error: 'Duplicate trigger suppressed by execution lock' },
                { status: 409 },
            );
        }

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
            knowledgeBaseIds: task.knowledgeBaseIds,
            trigger: { taskId: task.taskId, taskName: task.name, scheduledAt },
        });

        const session = await getAuthSession();
        AuditService.logUserAction({
            eventType: 'agent.task.triggered',
            severity: 'medium',
            apiRoute: 'POST /api/agent-ops/scheduled-tasks/[taskId]/trigger',
            httpMethod: 'POST',
            action: 'Triggered Scheduled Task',
            resourceType: 'agent',
            resourceId: taskId,
            resourceName: task.name || taskId,
            user: session?.user?.email || 'system',
            userType: 'user',
            status: 'success',
            details: `Triggered scheduled task "${task.name || taskId}", created run ${run.runId}`,
            metadata: { tenantId, runId: run.runId },
        }).catch(() => {});

        // Fire-and-forget — lastRun refresh + channel delivery happen post-run
        executeAgentRun(run)
            .then(async () => {
                const freshRun = await agentOpsService.getRun(task.tenantId, run.runId);
                if (freshRun) {
                    await finalizeScheduledRun(freshRun);
                } else {
                    await updateLastRun(task.tenantId, task.taskId, run.runId, 'completed');
                }
            })
            .catch(err => console.error(`[trigger] Run ${run.runId} failed:`, err));

        return NextResponse.json({ runId: run.runId, status: run.status });
    } catch (err) {
        return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal server error' }, { status: 500 });
    }
}
