/**
 * Scheduled-run channel delivery — direct dispatch, unidirectional (server → channel).
 *
 * The adapter is resolved from task.notification.type; the destination comes
 * from task.notification (channelId / chatId); credentials load per-tenant
 * inside the adapter. Delivery is best-effort: nothing here ever throws.
 */
import type { ScheduledTask, AgentOpsRun, AgentOpsStatus } from './types';
import type { ChannelType, ScheduledOutcome } from '@/lib/gateway/types';
import { getAdapterRegistry } from '@/lib/gateway';
import { getScheduledTask, updateLastRun } from './scheduled-task-service';

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
    try {
        const type = task.notification?.type;
        if (!type || type === 'none') return;

        const outcome = mapRunStatusToOutcome(run.status);
        if (!outcome) {
            console.warn(`[ScheduledNotifier] Run ${run.runId} status '${run.status}' has no digest — skipping`);
            return;
        }

        const registry = getAdapterRegistry();
        if (!registry.has(type as ChannelType)) {
            console.warn(`[ScheduledNotifier] No adapter for notification type '${type}' — skipping`);
            return;
        }
        const adapter = registry.get(type as ChannelType);
        if (!adapter.sendScheduledNotification) {
            console.warn(`[ScheduledNotifier] Adapter '${type}' does not support scheduled notifications — skipping`);
            return;
        }

        await adapter.sendScheduledNotification(task, run, outcome);
        console.log(`[ScheduledNotifier] Delivered '${outcome}' digest for run ${run.runId} via ${type}`);
    } catch (err) {
        console.error('[ScheduledNotifier] Notification failed (non-fatal):', err);
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
