/**
 * Discord Channel Adapter
 *
 * Implements ChannelAdapter for Discord slash commands and message component interactions.
 * Uses Ed25519 signature verification (tweetnacl) and Discord's interaction response model.
 */

import nacl from 'tweetnacl';
import type { NextRequest } from 'next/server';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { env } from '@/env';
import { buildDashboardRespondUrl } from '@/lib/gateway/utils/dashboard-url';
import { NarrationSessions } from '@/lib/gateway/narration/narration-session';
import type {
    ChannelAdapter,
    ChannelType,
    DeliveryMode,
    HilCapabilities,
    GatewayMessage,
    ReplyContext,
} from '@/lib/gateway/types';
import type {
    AgentOpsRun,
    AgentOpsEvent,
    DiscordTriggerMeta,
} from '@/lib/agent-ops/types';

// ─── Constants ────────────────────────────────────────────────────────

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const DISCORD_MESSAGE_MAX_CHARS = 2000;

// Discord interaction types
const INTERACTION_PING = 1;
const INTERACTION_APPLICATION_COMMAND = 2;
const INTERACTION_MESSAGE_COMPONENT = 3;

// Discord interaction response types
const RESPONSE_PONG = 1;
const RESPONSE_DEFERRED_CHANNEL_MESSAGE = 5;

// Embed colors
const COLOR_GREEN = 0x00ff00;
const COLOR_RED = 0xff0000;
const COLOR_YELLOW = 0xffaa00;

// ─── Discord Config Interface ─────────────────────────────────────────

export interface DiscordIntegrationConfig {
    applicationId: string;
    publicKey: string;
    botToken: string;
    enabled: boolean;
    autoApprove?: boolean;
}

// ─── Body Cache ───────────────────────────────────────────────────────

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

// ─── Adapter ──────────────────────────────────────────────────────────

export class DiscordAdapter implements ChannelAdapter {
    readonly channelType: ChannelType = 'discord';
    readonly deliveryMode: DeliveryMode = 'streaming';
    readonly hilCapabilities: HilCapabilities = {
        clarification: true,
        approvalButtons: true,
        threadedReplies: true,
    };

    private narration = new NarrationSessions();

    // ─── Inbound ──────────────────────────────────────────────────────

    async validateRequest(req: NextRequest): Promise<boolean> {
        const signature = req.headers.get('x-signature-ed25519');
        const timestamp = req.headers.get('x-signature-timestamp');

        if (!signature || !timestamp) return false;

        const body = await readBody(req);

        // Try to extract guild_id or application_id from body to resolve tenant
        let publicKey = '';
        try {
            const payload = JSON.parse(body);
            const tenantId = payload.guild_id || '';
            if (tenantId) {
                const config = await TenantConfigService.getConfig<DiscordIntegrationConfig>(
                    'agent-ops-discord',
                    tenantId,
                ).catch(() => null);
                publicKey = config?.publicKey || '';
            }
        } catch { /* ignore parse errors */ }

        // Fallback to env var
        if (!publicKey) {
            publicKey = env.DISCORD_PUBLIC_KEY || '';
        }

        if (!publicKey) {
            console.error('[DiscordAdapter] Public key not configured');
            return false;
        }

        try {
            const message = Buffer.from(timestamp + body);
            const sig = Buffer.from(signature, 'hex');
            const key = Buffer.from(publicKey, 'hex');

            return nacl.sign.detached.verify(
                new Uint8Array(message),
                new Uint8Array(sig),
                new Uint8Array(key),
            );
        } catch {
            return false;
        }
    }

    async parseInbound(req: NextRequest): Promise<GatewayMessage> {
        const body = await readBody(req);
        const payload = JSON.parse(body);

        const interactionType: number = payload.type;

        // ── PING (type 1) — Discord URL verification ────────────────
        if (interactionType === INTERACTION_PING) {
            return {
                channelType: 'discord',
                tenantId: payload.guild_id || '',
                taskDescription: '',
                channelMeta: { ping: true },
            };
        }

        // ── MESSAGE_COMPONENT (type 3) — Button interactions ────────
        if (interactionType === INTERACTION_MESSAGE_COMPONENT) {
            return this.parseComponentInteraction(payload);
        }

        // ── APPLICATION_COMMAND (type 2) — Slash commands ───────────
        return this.parseSlashCommand(payload);
    }

    async sendAck(_req: NextRequest, _runId: string): Promise<Response> {
        return new Response(
            JSON.stringify({ type: RESPONSE_DEFERRED_CHANNEL_MESSAGE }),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            },
        );
    }

    // ─── Outbound ─────────────────────────────────────────────────────

    async sendResult(run: AgentOpsRun, _events: AgentOpsEvent[]): Promise<void> {
        this.narration.finish(run.runId);
        const trigger = run.trigger as DiscordTriggerMeta;
        const summary = run.result?.summary ?? '(no summary)';
        const toolsUsed = run.result?.toolsUsed ?? [];
        const durationMs = run.durationMs ?? 0;

        const embed = {
            title: 'Agent Ops Complete',
            description: summary,
            color: COLOR_GREEN,
            fields: [
                { name: 'Tools Used', value: toolsUsed.join(', ') || 'None', inline: true },
                { name: 'Duration', value: `${Math.round(durationMs / 1000)}s`, inline: true },
            ],
            timestamp: new Date().toISOString(),
        };

        await this.patchOriginalMessage(run, trigger, { embeds: [embed] });
    }

    async sendError(run: AgentOpsRun, error: string): Promise<void> {
        this.narration.finish(run.runId);
        const trigger = run.trigger as DiscordTriggerMeta;

        const embed = {
            title: 'Agent Ops Failed',
            description: error,
            color: COLOR_RED,
            timestamp: new Date().toISOString(),
        };

        await this.patchOriginalMessage(run, trigger, { embeds: [embed] });
    }

    async sendClarification(run: AgentOpsRun, question: string): Promise<void> {
        const trigger = run.trigger as DiscordTriggerMeta;
        const dashboardUrl = buildDashboardRespondUrl(run.runId);

        const embed = {
            title: 'Clarification Needed',
            description: question,
            color: COLOR_YELLOW,
            fields: [
                { name: 'Respond via Dashboard', value: `[Open Dashboard](${dashboardUrl})` },
            ],
            timestamp: new Date().toISOString(),
        };

        await this.patchOriginalMessage(run, trigger, { embeds: [embed] });
    }

    async sendApprovalRequest(
        run: AgentOpsRun,
        planSteps?: string[],
        pendingTools?: string[],
    ): Promise<void> {
        const trigger = run.trigger as DiscordTriggerMeta;
        const planText = (planSteps ?? []).map((s, i) => `${i + 1}. ${s}`).join('\n');
        const toolsText = pendingTools?.length
            ? `\n\n**Tools:** ${pendingTools.map(t => `\`${t}\``).join(', ')}`
            : '';

        const embed = {
            title: 'Approval Required',
            description: `**Task:** ${run.taskDescription}${toolsText}\n\n**Plan:**\n${planText}`,
            color: COLOR_YELLOW,
            footer: { text: `Run ID: ${run.runId}` },
            timestamp: new Date().toISOString(),
        };

        const components = [
            {
                type: 1, // ActionRow
                components: [
                    {
                        type: 2, // Button
                        style: 3, // Success (green)
                        label: 'Approve',
                        custom_id: `approve:${run.runId}:${run.tenantId}`,
                    },
                    {
                        type: 2, // Button
                        style: 4, // Danger (red)
                        label: 'Reject',
                        custom_id: `reject:${run.runId}:${run.tenantId}`,
                    },
                ],
            },
        ];

        await this.patchOriginalMessage(run, trigger, { embeds: [embed], components });
    }

    async sendStreamChunk(run: AgentOpsRun, event: AgentOpsEvent): Promise<void> {
        const text = await this.narration.applyEvent(run, event);
        if (text === null) return;

        const trigger = run.trigger as DiscordTriggerMeta;
        await this.patchOriginalMessage(run, trigger, {
            content: text.slice(0, DISCORD_MESSAGE_MAX_CHARS),
        });
    }

    // ─── Config ───────────────────────────────────────────────────────

    async getConfig(tenantId: string): Promise<Record<string, unknown>> {
        const config = await TenantConfigService.getConfig<DiscordIntegrationConfig>(
            'agent-ops-discord',
            tenantId,
        ).catch(() => null);
        return (config as unknown as Record<string, unknown>) ?? {};
    }

    // ─── Private helpers ──────────────────────────────────────────────

    private parseSlashCommand(payload: Record<string, unknown>): GatewayMessage {
        const data = payload.data as Record<string, unknown> | undefined;
        const options = (data?.options as Array<{ value?: string }>) ?? [];
        const taskDescription = options.map(o => o.value).filter(Boolean).join(' ');

        const member = payload.member as Record<string, unknown> | undefined;
        const user = member?.user as Record<string, unknown> | undefined;
        const userId = (user?.id as string) || '';
        const channelId = (payload.channel_id as string) || '';
        const guildId = (payload.guild_id as string) || '';
        const interactionId = (payload.id as string) || '';
        const interactionToken = (payload.token as string) || '';

        return {
            channelType: 'discord',
            tenantId: guildId,
            taskDescription,
            userId,
            channelMeta: {
                userId,
                channelId,
                guildId,
                interactionId,
                interactionToken,
            },
        };
    }

    private parseComponentInteraction(payload: Record<string, unknown>): GatewayMessage {
        const data = payload.data as Record<string, unknown> | undefined;
        const customId = (data?.custom_id as string) || '';
        const [action, runId, tenantId] = customId.split(':');

        const member = payload.member as Record<string, unknown> | undefined;
        const user = member?.user as Record<string, unknown> | undefined;
        const userId = (user?.id as string) || '';
        const channelId = (payload.channel_id as string) || '';
        const interactionId = (payload.id as string) || '';
        const interactionToken = (payload.token as string) || '';

        const replyContext: ReplyContext = {
            runId: runId || '',
            action: action as ReplyContext['action'],
            tenantId: tenantId || '',
        };

        return {
            channelType: 'discord',
            tenantId: tenantId || '',
            taskDescription: '',
            userId,
            replyContext,
            channelMeta: {
                userId,
                channelId,
                interactionId,
                interactionToken,
            },
        };
    }

    private async patchOriginalMessage(
        run: AgentOpsRun,
        trigger: DiscordTriggerMeta,
        body: Record<string, unknown>,
    ): Promise<void> {
        const config = await TenantConfigService.getConfig<DiscordIntegrationConfig>(
            'agent-ops-discord',
            run.tenantId,
        ).catch(() => null);

        if (!config?.applicationId || !trigger.interactionToken) {
            console.warn('[DiscordAdapter] Missing applicationId or interactionToken');
            return;
        }

        const url = `${DISCORD_API_BASE}/webhooks/${config.applicationId}/${trigger.interactionToken}/messages/@original`;

        try {
            const res = await fetch(url, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bot ${config.botToken}`,
                },
                body: JSON.stringify(body),
            });

            if (!res.ok) {
                const text = await res.text();
                console.warn(`[DiscordAdapter] PATCH failed (${res.status}):`, text);
            }
        } catch (err) {
            console.error('[DiscordAdapter] patchOriginalMessage error:', err);
        }
    }
}
