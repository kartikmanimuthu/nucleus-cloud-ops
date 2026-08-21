// web-ui/lib/gateway/gateway-service.ts
/**
 * Gateway Service — Orchestrator that ties adapters, event bus, and executor together.
 *
 * Two main flows:
 * 1. handleInbound: validate → parse → create run → ack → fire-and-forget execute
 * 2. handleResume: approve / reject / clarification_response on an existing run
 */

import type { NextRequest } from 'next/server';
import type { ChannelType, GatewayMessage, ChannelAdapter } from './types';
import type { AdapterRegistry } from './adapter-registry';
import type { GatewayEventBus } from './event-bus';
import type { NotificationRouter } from './notification-router';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { executeAgentRun, resumeApprovedRun } from '@/lib/agent-ops/agent-executor';
import { triageChatMessage, chatTriageEnabled } from '@/lib/agent/triage';
import { resolveModelConfig, resolveDefaultModelConfig } from '@/lib/agent/model-resolver';
import { generateDirectReply } from '@/lib/gateway/persona/direct-reply';
import { chatbotPersonaEnabled } from '@/lib/gateway/persona/persona-config';

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

        // 4. If no taskDescription → ack or 400, depending on delivery semantics.
        // 'streaming' channels (Telegram, Discord) push updates async and retry
        // forever on a non-2xx response — e.g. Telegram's automatic /start
        // handshake has no text, and a 400 there would jam that channel's entire
        // queue behind an endless retry. 'callback' channels (Slack, Jira,
        // webhook) get a synchronous reply the caller displays immediately, so
        // the 400 there is a normal validation response, not a delivery signal.
        if (!message.taskDescription || message.taskDescription.trim() === '') {
            if (adapter.deliveryMode === 'streaming') {
                return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }
            return new Response(
                JSON.stringify({ error: 'Missing task description' }),
                { status: 400 },
            );
        }

        // 4.5. Persona router: small talk gets an instant reply and never
        // touches Agent Ops. Any failure inside (model resolution, the
        // classifier itself) falls through to the normal task path below —
        // never silently drop a real request.
        if (
            chatbotPersonaEnabled(channelType) &&
            chatTriageEnabled() &&
            adapter.sendDirectReply
        ) {
            const directReply = await this.tryDirectReply(message, req, adapter);
            if (directReply) return directReply;
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

            case 'reset': {
                // End the current conversation so the next message starts fresh.
                if (runId) {
                    await agentOpsService.closeTelegramSession(tenantId, runId);
                }
                const chatId = Number((message.channelMeta as { chatId?: number })?.chatId);
                if (adapter.sendSessionReset && Number.isFinite(chatId)) {
                    await adapter.sendSessionReset(tenantId, chatId);
                }
                return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }

            default:
                return new Response(
                    JSON.stringify({ error: `Unknown action: ${action}` }),
                    { status: 400 },
                );
        }
    }

    /**
     * Returns a direct-reply Response when triage classifies the message as
     * small talk, or null to fall through to the normal Agent Ops path.
     * Fails open (returns null) on any error — a wasted run is cheaper than
     * silently dropping a real request.
     */
    private async tryDirectReply(
        message: GatewayMessage,
        req: NextRequest,
        adapter: ChannelAdapter,
    ): Promise<Response | null> {
        try {
            const model = message.model
                ? await resolveModelConfig(message.model, message.tenantId)
                : await resolveDefaultModelConfig(message.tenantId);

            const triage = await triageChatMessage({
                tenantId: message.tenantId,
                message: message.taskDescription,
                model,
            });
            if (triage.route !== 'direct') return null;

            const text = await generateDirectReply({ message: message.taskDescription, model });
            return await adapter.sendDirectReply!(req, text);
        } catch (err) {
            console.warn(`[GatewayService] Persona routing failed (non-fatal, falling through to task): ${err}`);
            return null;
        }
    }
}
