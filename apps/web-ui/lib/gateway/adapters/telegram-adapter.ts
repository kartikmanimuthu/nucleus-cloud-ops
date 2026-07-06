/**
 * Telegram Channel Adapter
 *
 * Implements ChannelAdapter for Telegram Bot API webhooks.
 * Handles bot commands, reply-to-bot messages, and inline keyboard callback queries.
 * Uses X-Telegram-Bot-Api-Secret-Token header for webhook verification.
 */

import type { NextRequest } from 'next/server';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { env } from '@/env';
import { buildDashboardRespondUrl, buildDashboardRunUrl } from '@/lib/gateway/utils/dashboard-url';
import { ChannelRateLimiter } from '@/lib/gateway/utils/rate-limiter';
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
    TelegramTriggerMeta,
    ScheduledTask,
} from '@/lib/agent-ops/types';

// ─── Constants ────────────────────────────────────────────────────────

const TELEGRAM_API_BASE = 'https://api.telegram.org';

// ─── Telegram Config Interface ────────────────────────────────────────

export interface TelegramIntegrationConfig {
    botToken: string;
    secretToken: string;
    enabled: boolean;
    autoApprove?: boolean;
}

// ─── Body Cache ───────────────────────────────────────────────────────

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

// ─── Markdown Helpers ─────────────────────────────────────────────────

/**
 * Escape special characters for Telegram MarkdownV2 format.
 */
function escapeMarkdownV2(text: string): string {
    return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

// ─── Adapter ──────────────────────────────────────────────────────────

export class TelegramAdapter implements ChannelAdapter {
    readonly channelType: ChannelType = 'telegram';
    readonly deliveryMode: DeliveryMode = 'streaming';
    readonly hilCapabilities: HilCapabilities = {
        clarification: true,
        approvalButtons: true,
        threadedReplies: true,
    };

    private rateLimiter = new ChannelRateLimiter(2000);

    /** Track ack message IDs per run for editMessageText updates */
    private ackMessageIds = new Map<string, number>();

    // ─── Inbound ──────────────────────────────────────────────────────

    async validateRequest(req: NextRequest): Promise<boolean> {
        const secretHeader = req.headers.get('x-telegram-bot-api-secret-token') || '';
        if (!secretHeader) return false;

        // Read body to cache it for parseInbound
        await readBody(req);

        // Try to resolve tenant from x-tenant-id header or body
        let tenantId = req.headers.get('x-tenant-id') || '';
        if (!tenantId) {
            try {
                const body = await readBody(req);
                const payload = JSON.parse(body);
                tenantId = String(
                    payload.message?.chat?.id ??
                    payload.callback_query?.message?.chat?.id ??
                    '',
                );
            } catch { /* ignore parse errors */ }
        }

        // Load secret: tenant config first, env var fallback
        let expectedSecret = '';
        if (tenantId) {
            const config = await TenantConfigService.getConfig<TelegramIntegrationConfig>(
                'agent-ops-telegram',
                tenantId,
            ).catch(() => null);
            expectedSecret = config?.secretToken || '';
        }
        if (!expectedSecret) {
            expectedSecret = env.TELEGRAM_SECRET_TOKEN || '';
        }
        if (!expectedSecret) {
            console.error('[TelegramAdapter] Secret token not configured');
            return false;
        }

        return secretHeader === expectedSecret;
    }

    async parseInbound(req: NextRequest): Promise<GatewayMessage> {
        const body = await readBody(req);
        const payload = JSON.parse(body);
        const tenantId = req.headers.get('x-tenant-id') || '';

        // ── Callback query (inline keyboard button press) ───────────
        if (payload.callback_query) {
            return this.parseCallbackQuery(payload.callback_query, tenantId);
        }

        // ── Message ─────────────────────────────────────────────────
        if (payload.message) {
            return this.parseMessage(payload.message, tenantId);
        }

        // Fallback for unsupported update types
        return {
            channelType: 'telegram',
            tenantId,
            taskDescription: '',
            channelMeta: {},
        };
    }

    async sendAck(req: NextRequest, runId: string): Promise<Response> {
        const body = await readBody(req);
        let chatId: number | undefined;
        try {
            const payload = JSON.parse(body);
            chatId = payload.message?.chat?.id ?? payload.callback_query?.message?.chat?.id;
        } catch { /* ignore */ }

        if (chatId) {
            try {
                const config = await this.loadConfig(
                    req.headers.get('x-tenant-id') || String(chatId),
                );
                const botToken = config?.botToken || env.TELEGRAM_BOT_TOKEN || '';
                if (botToken) {
                    const res = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            chat_id: chatId,
                            text: `Processing your request... (Run \`${runId}\`)`,
                            parse_mode: 'MarkdownV2',
                        }),
                    });
                    if (res.ok) {
                        const data = await res.json();
                        if (data.ok && data.result?.message_id) {
                            this.ackMessageIds.set(runId, data.result.message_id);
                        }
                    }
                }
            } catch (err) {
                console.error('[TelegramAdapter] sendAck error:', err);
            }
        }

        return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // ─── Outbound ─────────────────────────────────────────────────────

    async sendResult(run: AgentOpsRun, _events: AgentOpsEvent[]): Promise<void> {
        const trigger = run.trigger as TelegramTriggerMeta;
        const summary = run.result?.summary ?? '(no summary)';
        const toolsUsed = run.result?.toolsUsed ?? [];
        const durationMs = run.durationMs ?? 0;

        const lines = [
            '*Agent Ops Complete*',
            '',
            escapeMarkdownV2(summary),
            '',
            `*Tools:* ${escapeMarkdownV2(toolsUsed.join(', ') || 'None')}`,
            `*Duration:* ${Math.round(durationMs / 1000)}s`,
        ];

        const ackMsgId = this.ackMessageIds.get(run.runId);
        if (ackMsgId) {
            await this.editMessage(run, trigger.chatId, ackMsgId, lines.join('\n'));
            this.ackMessageIds.delete(run.runId);
        } else {
            await this.sendMessage(run, trigger.chatId, lines.join('\n'));
        }
    }

    async sendError(run: AgentOpsRun, error: string): Promise<void> {
        const trigger = run.trigger as TelegramTriggerMeta;
        const text = `*Agent Ops Failed*\n\n${escapeMarkdownV2(error)}`;
        await this.sendMessage(run, trigger.chatId, text);
    }

    async sendClarification(run: AgentOpsRun, question: string): Promise<void> {
        const trigger = run.trigger as TelegramTriggerMeta;
        const dashboardUrl = buildDashboardRespondUrl(run.runId);

        const text = [
            '*Clarification Needed*',
            '',
            escapeMarkdownV2(question),
            '',
            `[Open Dashboard](${escapeMarkdownV2(dashboardUrl)})`,
        ].join('\n');

        await this.sendMessage(run, trigger.chatId, text);
    }

    async sendApprovalRequest(
        run: AgentOpsRun,
        planSteps?: string[],
        pendingTools?: string[],
    ): Promise<void> {
        const trigger = run.trigger as TelegramTriggerMeta;
        const planText = (planSteps ?? []).map((s, i) => `${i + 1}\\. ${escapeMarkdownV2(s)}`).join('\n');
        const toolsText = pendingTools?.length
            ? `\n\n*Tools:* ${escapeMarkdownV2(pendingTools.join(', '))}`
            : '';

        const text = [
            '*Approval Required*',
            '',
            `*Task:* ${escapeMarkdownV2(run.taskDescription)}${toolsText}`,
            '',
            '*Plan:*',
            planText,
        ].join('\n');

        const inlineKeyboard = {
            inline_keyboard: [[
                { text: '✅ Approve', callback_data: `approve:${run.runId}:${run.tenantId}` },
                { text: '❌ Reject', callback_data: `reject:${run.runId}:${run.tenantId}` },
            ]],
        };

        await this.sendMessage(run, trigger.chatId, text, inlineKeyboard);
    }

    async sendStreamChunk(run: AgentOpsRun, event: AgentOpsEvent): Promise<void> {
        if (!this.rateLimiter.shouldSend(run.runId)) return;

        const trigger = run.trigger as TelegramTriggerMeta;
        const content = event.content || `[${event.eventType}] ${event.toolName || event.node}`;
        const ackMsgId = this.ackMessageIds.get(run.runId);

        if (ackMsgId) {
            await this.editMessage(run, trigger.chatId, ackMsgId, escapeMarkdownV2(content));
        }
    }

    async sendScheduledNotification(
        task: ScheduledTask,
        run: AgentOpsRun,
        outcome: ScheduledOutcome,
    ): Promise<void> {
        const chatIdRaw = task.notification?.chatId;
        if (!chatIdRaw) {
            console.warn('[TelegramAdapter] sendScheduledNotification: no chatId on task notification');
            return;
        }
        const chatId = Number(chatIdRaw);
        const dashboardUrl = buildDashboardRunUrl(run.runId);
        const durationSec = Math.round((run.durationMs ?? 0) / 1000);

        // Telegram rejects messages over 4096 chars. The variable-length piece is
        // the "detail" (summary / error / clarification question) — resolve it once
        // per outcome, then build the message lines from it via a small helper so
        // we can rebuild with a shorter detail without duplicating the branch ladder.
        const rawDetail =
            outcome === 'result' ? (run.result?.summary ?? '(no summary)') :
            outcome === 'failure' ? (run.error ?? 'Run did not complete.') :
            (run.clarification?.question ?? `Run is ${run.status.replace('_', ' ')}.`);

        const buildLines = (detail: string): string[] => {
            let lines: string[];
            if (outcome === 'result') {
                lines = [
                    `*Scheduled task complete* — ${escapeMarkdownV2(task.name)}`,
                    '',
                    escapeMarkdownV2(detail),
                    '',
                    `*Tools:* ${escapeMarkdownV2(run.result?.toolsUsed?.join(', ') || 'None')}`,
                    `*Duration:* ${durationSec}s`,
                ];
            } else if (outcome === 'failure') {
                lines = [
                    `*Scheduled task ${run.status === 'cancelled' ? 'cancelled' : 'failed'}* — ${escapeMarkdownV2(task.name)}`,
                    '',
                    escapeMarkdownV2(detail),
                ];
            } else {
                lines = [
                    `*Scheduled task needs attention* — ${escapeMarkdownV2(task.name)}`,
                    '',
                    escapeMarkdownV2(detail),
                ];
            }
            lines.push('', `Run ${escapeMarkdownV2(run.runId)}`, `[Open dashboard](${escapeMarkdownV2(dashboardUrl)})`);
            return lines;
        };

        // Never truncate the already-escaped text (that can cut a `\X` escape
        // sequence in half) — truncate the raw detail before escaping instead.
        let text = buildLines(rawDetail.slice(0, 3000)).join('\n');
        if (text.length > 4096) {
            // Worst-case escaping inflation is ~2x, so 1000 raw chars keeps the
            // full message safely under Telegram's 4096-char limit.
            text = buildLines(`${rawDetail.slice(0, 1000)}…`).join('\n');
        }

        await this.sendMessage(run, chatId, text);
    }

    // ─── Config ───────────────────────────────────────────────────────

    async getConfig(tenantId: string): Promise<Record<string, unknown>> {
        const config = await this.loadConfig(tenantId);
        return (config as unknown as Record<string, unknown>) ?? {};
    }

    // ─── Private helpers ──────────────────────────────────────────────

    private async loadConfig(tenantId: string): Promise<TelegramIntegrationConfig | null> {
        return TenantConfigService.getConfig<TelegramIntegrationConfig>(
            'agent-ops-telegram',
            tenantId,
        ).catch(() => null);
    }

    private parseMessage(
        message: Record<string, unknown>,
        headerTenantId: string,
    ): GatewayMessage {
        const from = message.from as Record<string, unknown> | undefined;
        const chat = message.chat as Record<string, unknown> | undefined;
        const userId = (from?.id as number) ?? 0;
        const chatId = (chat?.id as number) ?? 0;
        const messageId = message.message_id as number | undefined;
        const text = (message.text as string) || '';
        const entities = (message.entities as Array<Record<string, unknown>>) ?? [];
        const tenantId = headerTenantId || String(chatId);

        // Check for bot command entity
        const botCommandEntity = entities.find(e => e.type === 'bot_command');
        if (botCommandEntity) {
            const offset = (botCommandEntity.offset as number) ?? 0;
            const length = (botCommandEntity.length as number) ?? 0;
            const taskDescription = text.slice(offset + length).trim();

            return {
                channelType: 'telegram',
                tenantId,
                taskDescription,
                userId: String(userId),
                channelMeta: { userId, chatId, messageId },
            };
        }

        // Check for reply to bot message (clarification response)
        const replyToMessage = message.reply_to_message as Record<string, unknown> | undefined;
        if (replyToMessage) {
            const replyFrom = replyToMessage.from as Record<string, unknown> | undefined;
            const isBot = replyFrom?.is_bot === true;

            if (isBot) {
                return {
                    channelType: 'telegram',
                    tenantId,
                    taskDescription: text,
                    userId: String(userId),
                    replyContext: {
                        runId: '', // Will be resolved by gateway orchestrator
                        action: 'clarification_response',
                        content: text,
                        tenantId,
                    },
                    channelMeta: { userId, chatId, messageId },
                };
            }
        }

        // Plain message (no command, no reply)
        return {
            channelType: 'telegram',
            tenantId,
            taskDescription: text,
            userId: String(userId),
            channelMeta: { userId, chatId, messageId },
        };
    }

    private parseCallbackQuery(
        callbackQuery: Record<string, unknown>,
        headerTenantId: string,
    ): GatewayMessage {
        const from = callbackQuery.from as Record<string, unknown> | undefined;
        const message = callbackQuery.message as Record<string, unknown> | undefined;
        const chat = message?.chat as Record<string, unknown> | undefined;

        const userId = (from?.id as number) ?? 0;
        const chatId = (chat?.id as number) ?? 0;
        const messageId = message?.message_id as number | undefined;
        const callbackQueryId = (callbackQuery.id as string) || '';
        const data = (callbackQuery.data as string) || '';

        // Parse callback_data format: "action:runId:tenantId"
        const [action, runId, tenantIdFromData] = data.split(':');
        const tenantId = headerTenantId || tenantIdFromData || String(chatId);

        const replyContext: ReplyContext = {
            runId: runId || '',
            action: action as ReplyContext['action'],
            tenantId,
        };

        return {
            channelType: 'telegram',
            tenantId,
            taskDescription: '',
            userId: String(userId),
            replyContext,
            channelMeta: { userId, chatId, messageId, callbackQueryId },
        };
    }

    private async sendMessage(
        run: AgentOpsRun,
        chatId: number,
        text: string,
        replyMarkup?: Record<string, unknown>,
    ): Promise<void> {
        const config = await this.loadConfig(run.tenantId);
        const botToken = config?.botToken || env.TELEGRAM_BOT_TOKEN || '';

        if (!botToken) {
            console.warn('[TelegramAdapter] Bot token not configured');
            return;
        }

        try {
            const body: Record<string, unknown> = {
                chat_id: chatId,
                text,
                parse_mode: 'MarkdownV2',
            };
            if (replyMarkup) {
                body.reply_markup = replyMarkup;
            }

            const res = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            if (!res.ok) {
                const responseText = await res.text();
                console.warn(`[TelegramAdapter] sendMessage failed (${res.status}):`, responseText);
            }
        } catch (err) {
            console.error('[TelegramAdapter] sendMessage error:', err);
        }
    }

    private async editMessage(
        run: AgentOpsRun,
        chatId: number,
        messageId: number,
        text: string,
    ): Promise<void> {
        const config = await this.loadConfig(run.tenantId);
        const botToken = config?.botToken || env.TELEGRAM_BOT_TOKEN || '';

        if (!botToken) {
            console.warn('[TelegramAdapter] Bot token not configured');
            return;
        }

        try {
            const res = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/editMessageText`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    message_id: messageId,
                    text,
                    parse_mode: 'MarkdownV2',
                }),
            });

            if (!res.ok) {
                const responseText = await res.text();
                console.warn(`[TelegramAdapter] editMessageText failed (${res.status}):`, responseText);
            }
        } catch (err) {
            console.error('[TelegramAdapter] editMessageText error:', err);
        }
    }
}
