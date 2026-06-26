// web-ui/lib/gateway/gateway-service.ts
/**
 * Gateway Service — Orchestrator that ties adapters, event bus, and executor together.
 *
 * Two main flows:
 * 1. handleInbound: validate → parse → create run → ack → fire-and-forget execute
 * 2. handleResume: approve / reject / clarification_response on an existing run
 */

import type { NextRequest } from 'next/server';
import type { ChannelType, GatewayMessage } from './types';
import type { AdapterRegistry } from './adapter-registry';
import type { GatewayEventBus } from './event-bus';
import type { NotificationRouter } from './notification-router';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { executeAgentRun, resumeApprovedRun } from '@/lib/agent-ops/agent-executor';

export class GatewayService {
    constructor(
        private registry: AdapterRegistry,
        private eventBus: GatewayEventBus,
        private router: NotificationRouter,
    ) {}

    /**
     * Main inbound handler — called by the gateway API route for each channel.
     */
    async handleInbound(channelType: ChannelType, req: NextRequest): Promise<Response> {
        const adapter = this.registry.get(channelType);

        // 1. Validate request (signature, auth, etc.)
        const valid = await adapter.validateRequest(req);
        if (!valid) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
        }

        // 2. Parse inbound → GatewayMessage
        const message = await adapter.parseInbound(req);

        // 3. If replyContext present → delegate to handleResume
        if (message.replyContext) {
            return this.handleResume(adapter, message, req);
        }

        // 4. If no taskDescription → 400
        if (!message.taskDescription || message.taskDescription.trim() === '') {
            return new Response(
                JSON.stringify({ error: 'Missing task description' }),
                { status: 400 },
            );
        }

        // 5. Create run via agentOpsService
        const run = await agentOpsService.createRun({
            tenantId: message.tenantId,
            source: channelType,
            taskDescription: message.taskDescription,
            mode: message.mode ?? 'fast',
            trigger: message.channelMeta as any,
            accountId: message.accountId,
            accountName: message.accountName,
            selectedSkill: message.selectedSkill,
            mcpServerIds: message.mcpServerIds,
            autoApprove: message.autoApprove,
            model: message.model,
        });

        // 6. Attach notification router so events flow back to the channel
        const unsubscribe = this.router.attachToRun(run);

        // 7. Send ack to the channel
        const ackResponse = await adapter.sendAck(req, run.runId);

        // 8. Fire-and-forget execution with cleanup
        const eventBus = this.eventBus;
        executeAgentRun(run, eventBus).finally(() => {
            unsubscribe();
            eventBus.cleanup(run.runId);
        });

        return ackResponse;
    }

    /**
     * Handle HIL resume actions: approve, reject, clarification_response.
     */
    private async handleResume(
        adapter: ReturnType<AdapterRegistry['get']>,
        message: GatewayMessage,
        req: NextRequest,
    ): Promise<Response> {
        const { replyContext } = message;
        if (!replyContext) {
            return new Response(JSON.stringify({ error: 'Missing reply context' }), { status: 400 });
        }

        const { runId, action, content } = replyContext;
        const tenantId = replyContext.tenantId ?? message.tenantId;

        switch (action) {
            case 'approve': {
                const run = await agentOpsService.findAwaitingApprovalRun(runId);
                if (!run) {
                    return new Response(
                        JSON.stringify({ error: 'No awaiting-approval run found' }),
                        { status: 404 },
                    );
                }

                const unsubscribe = this.router.attachToRun(run);
                const eventBus = this.eventBus;

                // Fire-and-forget resume
                resumeApprovedRun(run, eventBus).finally(() => {
                    unsubscribe();
                    eventBus.cleanup(run.runId);
                });

                const ackResponse = await adapter.sendAck(req, run.runId);
                return ackResponse;
            }

            case 'reject': {
                const run = await agentOpsService.findAwaitingApprovalRun(runId);
                if (!run) {
                    return new Response(
                        JSON.stringify({ error: 'No awaiting-approval run found' }),
                        { status: 404 },
                    );
                }

                await agentOpsService.updateRunStatus(tenantId, runId, 'cancelled');
                await agentOpsService.recordEvent({
                    runId,
                    tenantId,
                    eventType: 'final',
                    node: '__rejected__',
                    content: 'Run rejected by user via channel.',
                });

                const ackResponse = await adapter.sendAck(req, run.runId);
                return ackResponse;
            }

            case 'clarification_response': {
                const run = await agentOpsService.getRun(tenantId, runId);
                if (!run) {
                    return new Response(
                        JSON.stringify({ error: 'Run not found' }),
                        { status: 404 },
                    );
                }

                // Enrich task description with the user's clarification
                const enrichedTask = `${run.taskDescription}\n\nAdditional context: ${content ?? ''}`;
                const updatedRun = { ...run, taskDescription: enrichedTask };

                await agentOpsService.updateRunStatus(tenantId, runId, 'queued');
                await agentOpsService.recordEvent({
                    runId,
                    tenantId,
                    eventType: 'planning',
                    node: 'clarification',
                    content: `User provided clarification: ${content ?? ''}`,
                });

                const unsubscribe = this.router.attachToRun(updatedRun);
                const eventBus = this.eventBus;

                // Fire-and-forget re-execution
                executeAgentRun(updatedRun, eventBus).finally(() => {
                    unsubscribe();
                    eventBus.cleanup(updatedRun.runId);
                });

                const ackResponse = await adapter.sendAck(req, run.runId);
                return ackResponse;
            }

            default:
                return new Response(
                    JSON.stringify({ error: `Unknown action: ${action}` }),
                    { status: 400 },
                );
        }
    }
}
