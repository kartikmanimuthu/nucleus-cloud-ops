// web-ui/lib/agent-ops/scheduled-notifier.ts
import type { ScheduledTask, AgentOpsRun } from './types';
import { getGatewayEventBus } from '@/lib/gateway/event-bus';

export async function notifyScheduledRunResult(task: ScheduledTask, run: AgentOpsRun): Promise<void> {
    const { notification } = task;
    if (notification.type === 'none' || !notification.type) return;

    const eventBus = getGatewayEventBus();

    try {
        if (run.status === 'completed') {
            eventBus.emit({
                type: 'run:completed',
                runId: run.runId,
                tenantId: run.tenantId,
                timestamp: new Date(),
                data: { run },
            });
        } else {
            eventBus.emit({
                type: 'run:failed',
                runId: run.runId,
                tenantId: run.tenantId,
                timestamp: new Date(),
                data: { error: run.error ?? 'Scheduled task failed' },
            });
        }
    } catch (err) {
        console.error('[ScheduledNotifier] Notification failed (non-fatal):', err);
    }
}
