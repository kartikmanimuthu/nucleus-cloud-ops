import { NextResponse } from 'next/server';
import { getScheduledTask, updateLastRun, tryAcquireExecutionLock } from '@/lib/agent-ops/scheduled-task-service';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { executeAgentRun } from '@/lib/agent-ops/agent-executor';
import { finalizeScheduledRun } from '@/lib/agent-ops/scheduled-notifier';
import { checkScheduledTaskGrant, PERMISSION_REVOKED } from '@/lib/agent-ops/scheduled-task-permission';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { env } from '@/env';
import type { RouteAuthz } from '@nucleus/rbac';

/** Layer 1 permission declaration — see lib/rbac/rbac-allowlist.ts for the public set. */
export const authz: RouteAuthz = {
    POST: { action: 'execute', subject: 'ScheduledTask' },
};

/**
 * Resolve tenantId from either session auth or internal worker header.
 * Workers pass x-internal-key + x-tenant-id to bypass NextAuth session.
 *
 * The internal path authenticates ONLY when INTERNAL_API_KEY is configured AND
 * matches. There is deliberately no hardcoded fallback: a default like
 * 'internal-worker-key' would let anyone able to reach this service trigger any
 * tenant's task by sending the well-known key + an arbitrary x-tenant-id. If the
 * env var is unset, the internal branch never matches and we fall through to
 * session auth (fail closed).
 */
async function resolveTenantId(req: Request): Promise<{ tenantId: string; internal: boolean }> {
    const internalKey = req.headers.get('x-internal-key');
    if (env.INTERNAL_API_KEY && internalKey === env.INTERNAL_API_KEY) {
        const tenantId = req.headers.get('x-tenant-id');
        if (!tenantId) throw new Error('x-tenant-id header required for internal calls');
        return { tenantId, internal: true };
    }
    return { tenantId: await getSessionTenantId(), internal: false };
}

export async function POST(req: Request, { params }: { params: Promise<{ taskId: string }> }) {
    try {
        const { taskId } = await params;
        const { tenantId, internal } = await resolveTenantId(req);

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

        // ── Stored-grant re-check (Workstream H) ─────────────────────────────
        // Only on the internal (worker) path. A session-driven manual trigger is
        // already authorized as the CALLER by the `authz` declaration above; it is
        // the unattended path — where the only credential is a platform key —
        // that has to prove the CREATOR still holds the permission.
        if (internal) {
            const grant = await checkScheduledTaskGrant(task);

            if (!grant.ok) {
                console.error(`[trigger] ${PERMISSION_REVOKED} for task ${taskId}: ${grant.reason}`);
                AuditService.logUserAction({
                    eventType: 'agent.task.permission_revoked',
                    severity: 'high',
                    apiRoute: 'POST /api/agent-ops/scheduled-tasks/[taskId]/trigger',
                    httpMethod: 'POST',
                    action: 'Scheduled Task Permission Revoked',
                    resourceType: 'agent',
                    resourceId: taskId,
                    resourceName: task.name || taskId,
                    user: task.createdByUserId || task.createdBy || 'system',
                    userType: 'user',
                    status: 'error',
                    details:
                        `Scheduled task "${task.name || taskId}" was not executed: ${grant.reason}`,
                    metadata: { tenantId, taskId, code: PERMISSION_REVOKED, reason: grant.reason },
                }).catch(() => {});

                // 403 + an explicit code. The worker keys off the code to mark the
                // task and stop retrying; a bare 403 is treated as a transient
                // internal-key misconfiguration and WOULD be retried.
                return NextResponse.json(
                    { success: false, code: PERMISSION_REVOKED, error: grant.reason },
                    { status: 403 },
                );
            }

            if (!grant.verified) {
                console.warn(`[trigger] task ${taskId} ran without a verifiable creator grant: ${grant.reason}`);
            }
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
