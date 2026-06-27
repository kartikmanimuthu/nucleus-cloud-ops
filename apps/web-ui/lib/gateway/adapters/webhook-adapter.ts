/**
 * Webhook Channel Adapter
 *
 * Generic webhook adapter with HMAC-SHA256 validation and HTTP callback delivery.
 * Accepts JSON payloads with a taskDescription and callbackUrl, validates via
 * x-webhook-signature header, and POSTs results back to the callbackUrl.
 */

import * as crypto from 'crypto';
import type { NextRequest } from 'next/server';
import { env } from '@/env';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { buildDashboardRespondUrl } from '@/lib/gateway/utils/dashboard-url';
import type {
    ChannelAdapter,
    ChannelType,
    DeliveryMode,
    HilCapabilities,
    GatewayMessage,
} from '@/lib/gateway/types';
import type {
    AgentOpsRun,
    AgentOpsEvent,
    WebhookTriggerMeta,
} from '@/lib/agent-ops/types';

interface WebhookIntegrationConfig {
    webhookSecret: string;
    enabled: boolean;
    autoApprove?: boolean;
}

interface WebhookInboundPayload {
    taskDescription: string;
    tenantId: string;
    callbackUrl: string;
    replyContext?: {
        runId: string;
        action: 'clarification_response' | 'approve' | 'reject';
        content?: string;
    };
    mode?: 'fast' | 'plan';
    autoApprove?: boolean;
    accountId?: string;
}

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;

/**
 * Cache raw body text across validateRequest -> parseInbound calls.
 * NextRequest body can only be consumed once, so we store it keyed by request.
 */
const bodyCache = new WeakMap<NextRequest, string>();

async function readBody(req: NextRequest): Promise<string> {
    const cached = bodyCache.get(req);
    if (cached !== undefined) return cached;
    const text = await req.text();
    bodyCache.set(req, text);
    return text;
}

export class WebhookAdapter implements ChannelAdapter {
    readonly channelType: ChannelType = 'webhook';
    readonly deliveryMode: DeliveryMode = 'callback';
    readonly hilCapabilities: HilCapabilities = {
        clarification: false,
        approvalButtons: false,
        threadedReplies: false,
    };

    // ─── Inbound ──────────────────────────────────────────────────────

    async validateRequest(req: NextRequest): Promise<boolean> {
        const body = await readBody(req);
        const signature = req.headers.get('x-webhook-signature') || '';

        if (!signature) return false;

        // Try to extract tenantId from body for tenant-specific secret lookup
        let tenantId = '';
        try {
            const parsed = JSON.parse(body);
            tenantId = parsed.tenantId || '';
        } catch { /* ignore parse errors */ }

        // Load webhook secret: tenant config first, env var fallback
        let webhookSecret = '';
        if (tenantId) {
            const config = await TenantConfigService.getConfig<WebhookIntegrationConfig>(
                'agent-ops-webhook',
                tenantId,
            ).catch(() => null);
            webhookSecret = config?.webhookSecret || '';
        }
        if (!webhookSecret) {
            webhookSecret = env.WEBHOOK_SECRET || '';
        }
        if (!webhookSecret) {
            console.error('[WebhookAdapter] Webhook secret not configured');
            return false;
        }

        // HMAC-SHA256 verification
        const hmac = crypto.createHmac('sha256', webhookSecret);
        hmac.update(body);
        const expectedSignature = hmac.digest('hex');

        try {
            return crypto.timingSafeEqual(
                Buffer.from(signature),
                Buffer.from(expectedSignature),
            );
        } catch {
            return false;
        }
    }

    async parseInbound(req: NextRequest): Promise<GatewayMessage> {
        const body = await readBody(req);
        const payload: WebhookInboundPayload = JSON.parse(body);

        const webhookId = crypto.randomUUID();

        return {
            channelType: 'webhook',
            tenantId: payload.tenantId,
            taskDescription: payload.taskDescription || '',
            mode: payload.mode,
            autoApprove: payload.autoApprove,
            accountId: payload.accountId,
            replyContext: payload.replyContext
                ? {
                    runId: payload.replyContext.runId,
                    action: payload.replyContext.action,
                    content: payload.replyContext.content,
                    tenantId: payload.tenantId,
                }
                : undefined,
            channelMeta: {
                callbackUrl: payload.callbackUrl,
                webhookId,
            },
        };
    }

    async sendAck(_req: NextRequest, runId: string): Promise<Response> {
        return new Response(
            JSON.stringify({ runId, status: 'queued' }),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            },
        );
    }

    // ─── Outbound ─────────────────────────────────────────────────────

    async sendResult(run: AgentOpsRun, _events: AgentOpsEvent[]): Promise<void> {
        const trigger = run.trigger as WebhookTriggerMeta;
        if (!trigger?.callbackUrl) return;

        await this.postWithRetry(trigger.callbackUrl, {
            runId: run.runId,
            status: 'completed',
            summary: run.result?.summary ?? '',
            toolsUsed: run.result?.toolsUsed ?? [],
            duration: run.durationMs ?? 0,
        });
    }

    async sendError(run: AgentOpsRun, error: string): Promise<void> {
        const trigger = run.trigger as WebhookTriggerMeta;
        if (!trigger?.callbackUrl) return;

        await this.postWithRetry(trigger.callbackUrl, {
            runId: run.runId,
            status: 'failed',
            error,
        });
    }

    async sendClarification(run: AgentOpsRun, question: string): Promise<void> {
        const trigger = run.trigger as WebhookTriggerMeta;
        if (!trigger?.callbackUrl) return;

        const dashboardUrl = buildDashboardRespondUrl(run.runId);
        await this.postWithRetry(trigger.callbackUrl, {
            runId: run.runId,
            status: 'awaiting_input',
            question,
            dashboardUrl,
        });
    }

    async sendApprovalRequest(
        run: AgentOpsRun,
        planSteps?: string[],
        pendingTools?: string[],
    ): Promise<void> {
        const trigger = run.trigger as WebhookTriggerMeta;
        if (!trigger?.callbackUrl) return;

        const dashboardUrl = buildDashboardRespondUrl(run.runId);
        await this.postWithRetry(trigger.callbackUrl, {
            runId: run.runId,
            status: 'awaiting_approval',
            planSteps: planSteps ?? [],
            pendingTools: pendingTools ?? [],
            dashboardUrl,
        });
    }

    // ─── Config ───────────────────────────────────────────────────────

    async getConfig(tenantId: string): Promise<Record<string, unknown>> {
        const config = await TenantConfigService.getConfig<WebhookIntegrationConfig>(
            'agent-ops-webhook',
            tenantId,
        ).catch(() => null);
        return (config as unknown as Record<string, unknown>) ?? {};
    }

    // ─── Private helpers ──────────────────────────────────────────────

    private async postWithRetry(
        url: string,
        payload: Record<string, unknown>,
        attempts = MAX_RETRY_ATTEMPTS,
    ): Promise<void> {
        for (let i = 0; i < attempts; i++) {
            try {
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });

                if (res.ok) return;

                console.warn(
                    `[WebhookAdapter] Callback POST failed (attempt ${i + 1}/${attempts}): ${res.status}`,
                );
            } catch (err) {
                console.warn(
                    `[WebhookAdapter] Callback POST error (attempt ${i + 1}/${attempts}):`,
                    err,
                );
            }

            // Exponential backoff: 1s, 2s, 4s
            if (i < attempts - 1) {
                await new Promise(resolve =>
                    setTimeout(resolve, RETRY_BASE_DELAY_MS * Math.pow(2, i)),
                );
            }
        }

        console.error(`[WebhookAdapter] All ${attempts} callback attempts failed for ${url}`);
    }
}
