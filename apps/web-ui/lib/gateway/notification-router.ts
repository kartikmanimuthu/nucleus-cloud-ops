// web-ui/lib/gateway/notification-router.ts
import type { GatewayEventBus } from './event-bus';
import type { AdapterRegistry } from './adapter-registry';
import type { ChannelType, GatewayEvent } from './types';
import type { AgentOpsRun } from '@/lib/agent-ops/types';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { buildDashboardRespondUrl } from './utils/dashboard-url';
import { narrationEnabled } from './narration/narration-config';

export class NotificationRouter {
    constructor(
        private eventBus: GatewayEventBus,
        private adapterRegistry: AdapterRegistry,
    ) {}

    attachToRun(run: AgentOpsRun): () => void {
        return this.eventBus.subscribe(run.runId, async (event: GatewayEvent) => {
            try {
                const adapter = this.adapterRegistry.get(run.source as ChannelType);

                switch (event.type) {
                    case 'run:event':
                        if (adapter.sendStreamChunk && narrationEnabled(run.source as ChannelType)) {
                            await adapter.sendStreamChunk(run, event.data.event!);
                        }
                        break;

                    case 'run:completed': {
                        const events = await agentOpsService.getRunEvents(run.runId, run.tenantId);
                        await adapter.sendResult(event.data.run ?? run, events);
                        break;
                    }

                    case 'run:failed':
                        await adapter.sendError(run, event.data.error ?? 'Unknown error');
                        break;

                    case 'run:cancelled':
                        await adapter.sendError(run, 'Run was cancelled.');
                        break;

                    case 'hil:clarification':
                        if (adapter.hilCapabilities.clarification) {
                            await adapter.sendClarification(run, event.data.question!);
                        } else {
                            const url = buildDashboardRespondUrl(run.runId);
                            await adapter.sendError(run, `This run needs your input: ${url}`);
                        }
                        break;

                    case 'hil:plan_approval':
                        if (adapter.hilCapabilities.approvalButtons) {
                            await adapter.sendApprovalRequest(run, event.data.planSteps);
                        } else {
                            const url = buildDashboardRespondUrl(run.runId);
                            await adapter.sendError(run, `This run needs approval: ${url}`);
                        }
                        break;

                    case 'hil:tool_approval':
                        if (adapter.hilCapabilities.approvalButtons) {
                            await adapter.sendApprovalRequest(run, undefined, event.data.pendingTools);
                        } else {
                            const url = buildDashboardRespondUrl(run.runId);
                            await adapter.sendError(run, `This run needs tool approval: ${url}`);
                        }
                        break;
                }
            } catch (err) {
                console.error(`[NotificationRouter] Error dispatching ${event.type} for run ${run.runId}:`, err);
            }
        });
    }
}
