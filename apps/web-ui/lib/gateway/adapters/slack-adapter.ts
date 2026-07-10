/**
 * Slack Channel Adapter
 *
 * Implements ChannelAdapter for Slack slash commands and interaction payloads.
 * Consolidates logic from slack-notifier.ts and slack-validator.ts into the
 * unified gateway pattern.
 */

import * as crypto from 'crypto';
import type { NextRequest } from 'next/server';
import { env } from '@/env';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { getBotToken } from '@/lib/connectors/connection-service';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { buildDashboardRespondUrl, buildDashboardRunUrl } from '@/lib/gateway/utils/dashboard-url';
import type {
    ChannelAdapter,
    ChannelType,
    DeliveryMode,
    HilCapabilities,
    GatewayMessage,
    ReplyContext,
    ScheduledOutcome,
} from '@/lib/gateway/types';
import type {
    AgentOpsRun,
    AgentOpsEvent,
    ScheduledTask,
    SlackIntegrationConfig,
    SlackTriggerMeta,
} from '@/lib/agent-ops/types';

const SLACK_TIMESTAMP_MAX_AGE = 5 * 60; // 5 minutes

/**
 * Cache raw body text across validateRequest → parseInbound calls.
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

export class SlackAdapter implements ChannelAdapter {
    readonly channelType: ChannelType = 'slack';
    readonly deliveryMode: DeliveryMode = 'callback';
    readonly hilCapabilities: HilCapabilities = {
        clarification: true,
        approvalButtons: true,
        threadedReplies: true,
    };

    // ─── Inbound ──────────────────────────────────────────────────────

    async validateRequest(req: NextRequest): Promise<boolean> {
        const body = await readBody(req);
        const timestamp = req.headers.get('x-slack-request-timestamp') || '';
        const signature = req.headers.get('x-slack-signature') || '';

        if (!timestamp || !signature) return false;

        // Try to resolve tenantId from the body (team_id in slash commands or interaction payloads)
        const params = new URLSearchParams(body);
        let tenantId = params.get('team_id') || '';
        if (!tenantId && params.has('payload')) {
            try {
                const payload = JSON.parse(params.get('payload')!);
                tenantId = payload.team?.id || '';
            } catch { /* ignore */ }
        }

        // Load signing secret: tenant config first, env var fallback
        let signingSecret = '';
        if (tenantId) {
            const config = await TenantConfigService.getConfig<SlackIntegrationConfig>(
                'agent-ops-slack',
                tenantId,
            ).catch(() => null);
            signingSecret = config?.signingSecret || '';
        }
        if (!signingSecret) {
            signingSecret = env.SLACK_SIGNING_SECRET || '';
        }
        if (!signingSecret) {
            console.error('[SlackAdapter] Signing secret not configured');
            return false;
        }

        // Reject requests older than 5 minutes
        const now = Math.floor(Date.now() / 1000);
        const requestTimestamp = parseInt(timestamp, 10);
        if (Math.abs(now - requestTimestamp) > SLACK_TIMESTAMP_MAX_AGE) {
            console.warn('[SlackAdapter] Request too old:', { now, requestTimestamp });
            return false;
        }

        // HMAC-SHA256 verification
        const sigBasestring = `v0:${timestamp}:${body}`;
        const hmac = crypto.createHmac('sha256', signingSecret);
        hmac.update(sigBasestring);
        const expectedSignature = `v0=${hmac.digest('hex')}`;

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
        const params = new URLSearchParams(body);

        // ── Interaction payload (button clicks) ──────────────────────
        if (params.has('payload')) {
            return this.parseInteractionPayload(params.get('payload')!);
        }

        // ── Slash command ────────────────────────────────────────────
        return this.parseSlashCommand(params);
    }

    async sendAck(_req: NextRequest, runId: string): Promise<Response> {
        return new Response(
            JSON.stringify({
                response_type: 'ephemeral',
                text: `\u{1F680} Agent Ops Started — Run \`${runId}\`\nProcessing your request...`,
            }),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            },
        );
    }

    // ─── Outbound ─────────────────────────────────────────────────────

    async sendResult(run: AgentOpsRun, _events: AgentOpsEvent[]): Promise<void> {
        const summary = run.result?.summary ?? '(no summary)';
        const text = `✅ Complete\n${summary}`;
        await this.postToSlackThreadOrWebhook(text, run);
    }

    async sendError(run: AgentOpsRun, error: string): Promise<void> {
        const text = `❌ Agent Ops failed: ${error}`;
        await this.postToSlackThreadOrWebhook(text, run);
    }

    async sendClarification(run: AgentOpsRun, question: string): Promise<void> {
        const dashboardUrl = buildDashboardRespondUrl(run.runId);
        const text = [
            `❓ *Clarification needed* (Run \`${run.runId}\`)`,
            '',
            question,
            '',
            '_Reply in this thread to continue, or use the dashboard:_',
            dashboardUrl,
        ].join('\n');
        await this.postToSlackThreadOrWebhook(text, run);
    }

    async sendApprovalRequest(
        run: AgentOpsRun,
        planSteps?: string[],
        pendingTools?: string[],
    ): Promise<void> {
        const trigger = run.trigger as SlackTriggerMeta;
        const channelId = trigger?.channelId;
        const threadTs = trigger?.threadTs;

        if (!channelId) {
            console.warn('[SlackAdapter] sendApprovalRequest: no channelId on trigger');
            return;
        }

        const config = await this.loadConfig(run.tenantId);
        const botToken = await this.resolveBotToken(run.tenantId, config);
        if (!botToken) {
            console.warn('[SlackAdapter] sendApprovalRequest: no botToken configured');
            return;
        }

        const planText = (planSteps ?? []).map((s, i) => `${i + 1}. ${s}`).join('\n');
        const toolsText = pendingTools?.length
            ? `\n\n*Tools that will execute:* ${pendingTools.map(t => `\`${t}\``).join(', ')}`
            : '';

        const approveValue = `${run.runId}|${run.tenantId}`;
        const rejectValue = `${run.runId}|${run.tenantId}`;

        const blocks = [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `\u{1F916} *Agent Ops — Approval Required*\n\n*Task:* ${run.taskDescription}${toolsText}`,
                },
            },
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `*Execution Plan:*\n\`\`\`\n${planText}\n\`\`\``,
                },
            },
            {
                type: 'context',
                elements: [{ type: 'mrkdwn', text: `Run ID: \`${run.runId}\`` }],
            },
            {
                type: 'actions',
                elements: [
                    {
                        type: 'button',
                        text: { type: 'plain_text', text: '✅ Approve', emoji: true },
                        style: 'primary',
                        action_id: 'agent_ops_approve',
                        value: approveValue,
                    },
                    {
                        type: 'button',
                        text: { type: 'plain_text', text: '❌ Reject', emoji: true },
                        style: 'danger',
                        action_id: 'agent_ops_reject',
                        value: rejectValue,
                    },
                ],
            },
        ];

        try {
            const res = await fetch('https://slack.com/api/chat.postMessage', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${botToken}`,
                },
                body: JSON.stringify({
                    channel: channelId,
                    ...(threadTs && { thread_ts: threadTs }),
                    blocks,
                    text: `Approval required for Agent Ops run \`${run.runId}\``,
                }),
            });

            const data = await res.json();
            if (data.ok) {
                console.log(`[SlackAdapter] Approval Block Kit posted, ts=${data.ts}`);
                // Persist the message ts so we can update it later
                await agentOpsService.updateApprovalMessageTs(
                    run.tenantId,
                    run.runId,
                    data.ts as string,
                ).catch((err: unknown) => {
                    console.warn('[SlackAdapter] Failed to persist approval message ts:', err);
                });
            } else {
                console.warn('[SlackAdapter] Block Kit post failed:', data.error);
            }
        } catch (err) {
            console.error('[SlackAdapter] sendApprovalRequest error:', err);
        }
    }

    async sendScheduledNotification(
        task: ScheduledTask,
        run: AgentOpsRun,
        outcome: ScheduledOutcome,
    ): Promise<void> {
        const channelId = task.notification?.channelId;
        if (!channelId) {
            console.warn('[SlackAdapter] sendScheduledNotification: no channelId on task notification');
            return;
        }
        const config = await this.loadConfig(run.tenantId);
        const botToken = await this.resolveBotToken(run.tenantId, config);
        if (!botToken) {
            console.warn('[SlackAdapter] sendScheduledNotification: no botToken configured');
            return;
        }

        const dashboardUrl = buildDashboardRunUrl(run.runId);
        const durationSec = Math.round((run.durationMs ?? 0) / 1000);

        let header: string;
        let detail: string;
        if (outcome === 'result') {
            header = `✅ Scheduled task "${task.name}" completed`;
            const tools = run.result?.toolsUsed?.length
                ? `\n*Tools:* ${run.result.toolsUsed.join(', ')}`
                : '';
            detail = `${run.result?.summary ?? '(no summary)'}${tools}\n*Duration:* ${durationSec}s`;
        } else if (outcome === 'failure') {
            header = `❌ Scheduled task "${task.name}" ${run.status === 'cancelled' ? 'was cancelled' : 'failed'}`;
            detail = run.error ?? 'Run did not complete.';
        } else {
            header = `⏸️ Scheduled task "${task.name}" needs your attention`;
            detail = run.clarification?.question
                ?? (run.approvalRequest
                    ? `Approval required (${run.approvalRequest.approvalType}).`
                    : `Run is ${run.status.replace('_', ' ')}.`);
        }

        const blocks = [
            {
                type: 'section',
                text: { type: 'mrkdwn', text: `*${header}*\n\n${detail.slice(0, 2900)}` },
            },
            {
                type: 'context',
                elements: [{ type: 'mrkdwn', text: `Run \`${run.runId}\` · <${dashboardUrl}|Open in dashboard>` }],
            },
        ];

        try {
            const res = await fetch('https://slack.com/api/chat.postMessage', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${botToken}`,
                },
                body: JSON.stringify({ channel: channelId, blocks, text: header }),
            });
            const data = await res.json();
            if (!data.ok) {
                console.warn('[SlackAdapter] sendScheduledNotification post failed:', data.error);
            }
        } catch (err) {
            console.error('[SlackAdapter] sendScheduledNotification error:', err);
        }
    }

    // ─── Config ───────────────────────────────────────────────────────

    async getConfig(tenantId: string): Promise<Record<string, unknown>> {
        const config = await this.loadConfig(tenantId);
        return (config as unknown as Record<string, unknown>) ?? {};
    }

    // ─── Private helpers ──────────────────────────────────────────────

    private async loadConfig(tenantId: string): Promise<SlackIntegrationConfig | null> {
        return TenantConfigService.getConfig<SlackIntegrationConfig>(
            'agent-ops-slack',
            tenantId,
        ).catch(() => null);
    }

    /**
     * Resolve the bot token for outbound Slack calls. Precedence:
     * installed workspace-bot token (ConnectorApp) → manual botToken (tenant config).
     */
    private async resolveBotToken(tenantId: string, config: SlackIntegrationConfig | null): Promise<string | null> {
        const installed = await getBotToken(tenantId).catch(() => null);
        return installed || config?.botToken || null;
    }

    private async parseSlashCommand(params: URLSearchParams): Promise<GatewayMessage> {
        const text = params.get('text') || '';
        const userId = params.get('user_id') || '';
        const channelId = params.get('channel_id') || '';
        const responseUrl = params.get('response_url') || '';
        const teamId = params.get('team_id') || '';
        const threadTs = params.get('thread_ts') || undefined;
        const userName = params.get('user_name') || undefined;
        const channelName = params.get('channel_name') || undefined;

        // If this is a threaded reply, check for an awaiting_input run
        let replyContext: ReplyContext | undefined;
        if (threadTs && channelId) {
            const awaitingRun = await agentOpsService.findAwaitingRunBySlackThread(
                channelId,
                threadTs,
            );
            if (awaitingRun) {
                replyContext = {
                    runId: awaitingRun.runId,
                    action: 'clarification_response',
                    content: text,
                    tenantId: awaitingRun.tenantId,
                };
            }
        }

        return {
            channelType: 'slack',
            tenantId: teamId,
            taskDescription: text,
            userId,
            replyContext,
            channelMeta: {
                userId,
                channelId,
                responseUrl,
                teamId,
                threadTs,
                userName,
                channelName,
            },
        };
    }

    private parseInteractionPayload(payloadJson: string): GatewayMessage {
        const payload = JSON.parse(payloadJson);
        const action = payload.actions?.[0];
        const actionId: string = action?.action_id || '';
        const actionValue: string = action?.value || '';
        const channelId = payload.channel?.id || '';
        const messageTs = payload.message?.ts || '';
        const responseUrl = payload.response_url || '';

        // Parse "runId|tenantId" from button value
        const [runId, tenantId] = actionValue.split('|');

        let resolvedAction: ReplyContext['action'] = 'approve';
        if (actionId === 'agent_ops_reject') {
            resolvedAction = 'reject';
        }

        return {
            channelType: 'slack',
            tenantId: tenantId || '',
            taskDescription: '',
            replyContext: {
                runId: runId || '',
                action: resolvedAction,
                tenantId: tenantId || '',
            },
            channelMeta: {
                channelId,
                messageTs,
                responseUrl,
                actionId,
            },
        };
    }

    private async postToSlackThreadOrWebhook(
        text: string,
        run: AgentOpsRun,
    ): Promise<void> {
        const trigger = run.trigger as SlackTriggerMeta;
        const responseUrl = trigger?.responseUrl;

        try {
            let postedToThread = false;

            if (trigger?.threadTs && trigger?.channelId) {
                const config = await this.loadConfig(run.tenantId);
                const botToken = await this.resolveBotToken(run.tenantId, config);
                if (botToken) {
                    const res = await fetch('https://slack.com/api/chat.postMessage', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${botToken}`,
                        },
                        body: JSON.stringify({
                            channel: trigger.channelId,
                            thread_ts: trigger.threadTs,
                            text,
                        }),
                    });

                    if (res.ok) {
                        const data = await res.json();
                        if (data.ok) {
                            postedToThread = true;
                        } else {
                            console.warn('[SlackAdapter] Thread reply failed:', data.error);
                        }
                    }
                }
            }

            if (!postedToThread && responseUrl) {
                await fetch(responseUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ response_type: 'in_channel', text }),
                });
            }
        } catch (err) {
            console.error('[SlackAdapter] Failed to post to Slack:', err);
        }
    }
}
