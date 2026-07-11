/**
 * Scheduled-run channel delivery — direct dispatch, unidirectional (server → channel).
 *
 * The adapter is resolved from task.notification.type; the destination comes
 * from task.notification (channelId / chatId / issueKey); credentials load
 * per-tenant inside the adapter. Nothing here ever throws, but delivery is NOT
 * silent: every attempt is recorded as a 'notification' event on the run, so a
 * missing bot token or a rejected API call is visible in the run timeline.
 */
import type { ScheduledTask, AgentOpsRun, AgentOpsStatus } from './types';
import type { ChannelType, ScheduledOutcome } from '@/lib/gateway/types';
import { getAdapterRegistry } from '@/lib/gateway';
import { getScheduledTask, updateLastRun } from './scheduled-task-service';
import { recordEvent } from './agent-ops-service';

export function mapRunStatusToOutcome(status: AgentOpsStatus): ScheduledOutcome | null {
    switch (status) {
        case 'completed':
            return 'result';
        case 'failed':
        case 'cancelled':
            return 'failure';
        case 'awaiting_input':
        case 'awaiting_approval':
            return 'attention';
        default:
            return null; // queued / in_progress — nothing to report yet
    }
}

export async function notifyScheduledRunResult(task: ScheduledTask, run: AgentOpsRun): Promise<void> {
    const type = task.notification?.type;
    if (!type || type === 'none') return;

    const outcome = mapRunStatusToOutcome(run.status);
    if (!outcome) {
        console.warn(`[ScheduledNotifier] Run ${run.runId} status '${run.status}' has no digest — skipping`);
        return;
    }

    // recordEvent never throws, so these markers can't abort finalization.
    const recordFailure = async (reason: string) => {
        console.error(`[ScheduledNotifier] Digest delivery FAILED for run ${run.runId} via ${type}: ${reason}`);
        await recordEvent({
            runId: run.runId,
            tenantId: run.tenantId,
            eventType: 'notification',
            node: 'scheduled_notifier',
            content: `Scheduled digest delivery via ${type} failed: ${reason}`,
            metadata: { channel: type, status: 'failed', outcome, error: reason, taskId: task.taskId },
        });
    };

    try {
        const registry = getAdapterRegistry();
        if (!registry.has(type as ChannelType)) {
            await recordFailure(`no adapter registered for channel '${type}'`);
            return;
        }
        const adapter = registry.get(type as ChannelType);
        if (!adapter.sendScheduledNotification) {
            await recordFailure(`channel '${type}' does not support scheduled notifications`);
            return;
        }

        await adapter.sendScheduledNotification(task, run, outcome);
        console.log(`[ScheduledNotifier] Delivered '${outcome}' digest for run ${run.runId} via ${type}`);
        await recordEvent({
            runId: run.runId,
            tenantId: run.tenantId,
            eventType: 'notification',
            node: 'scheduled_notifier',
            content: `Scheduled digest delivered via ${type}`,
            metadata: { channel: type, status: 'sent', outcome, taskId: task.taskId },
        });
    } catch (err) {
        await recordFailure(err instanceof Error ? err.message : String(err));
    }
}

/**
 * Post-run finalization for scheduled runs: refresh lastRun* on the task and
 * deliver the outcome digest. Safe to call with any run — no-ops unless
 * run.source === 'scheduled' with a taskId on the trigger. Never throws.
 */
export async function finalizeScheduledRun(run: AgentOpsRun, opts?: { countRun?: boolean }): Promise<void> {
    try {
        if (run.source !== 'scheduled') return;
        const taskId = (run.trigger as { taskId?: string } | null)?.taskId;
        if (!taskId) return;

        const task = await getScheduledTask(run.tenantId, taskId);
        if (!task) {
            console.warn(`[ScheduledNotifier] Task ${taskId} not found for run ${run.runId} — skipping finalize`);
            return;
        }

        await updateLastRun(run.tenantId, taskId, run.runId, run.status, {
            incrementRunCount: opts?.countRun ?? true,
        });
        await notifyScheduledRunResult(task, run);
    } catch (err) {
        console.error('[ScheduledNotifier] finalizeScheduledRun failed (non-fatal):', err);
    }
}
