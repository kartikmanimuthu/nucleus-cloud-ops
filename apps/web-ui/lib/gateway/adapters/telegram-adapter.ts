/**
 * Telegram Channel Adapter
 *
 * Implements ChannelAdapter for Telegram Bot API webhooks.
 * Handles bot commands, reply-to-bot messages, and inline keyboard callback queries.
 * Uses X-Telegram-Bot-Api-Secret-Token header for webhook verification.
 */

import type { NextRequest } from 'next/server';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { getTelegramBotLinkRepository } from '@/lib/db/repository-factory';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
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

/** A Telegram chat is one ongoing conversation until it goes quiet this long. */
const CONVERSATION_IDLE_MS = 30 * 60 * 1000;

/** Commands that end the current conversation and start a fresh one. */
const RESET_COMMANDS = new Set(['/new', '/n']);

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

/**
 * Cache the secretToken → tenantId resolution across validateRequest →
 * parseInbound so both use the same (correct) internal tenantId without a
 * duplicate lookup. Value is `null` when resolution was attempted but no
 * link exists.
 */
const tenantIdCache = new WeakMap<NextRequest, string | null>();

async function resolveTenantId(req: NextRequest, secretToken: string): Promise<string | null> {
    if (!secretToken) return null;
    if (tenantIdCache.has(req)) return tenantIdCache.get(req) ?? null;
    const tenantId = await getTelegramBotLinkRepository().findTenantIdBySecretToken(secretToken).catch(() => null);
    tenantIdCache.set(req, tenantId);
    return tenantId;
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

        // Telegram updates carry no tenant-identifying field at all — the secret
        // token echoed back in this header is the only value that ties a request
        // back to the tenant who registered this bot's webhook (see TelegramBotLink).
        const tenantId = await resolveTenantId(req, secretHeader);

        // Load secret: tenant config first, env var fallback (single-tenant setups)
        let expectedSecret = '';
        let enabled = true;
        if (tenantId) {
            const config = await TenantConfigService.getConfig<TelegramIntegrationConfig>(
                'agent-ops-telegram',
                tenantId,
            ).catch(() => null);
            expectedSecret = config?.secretToken || '';
            enabled = config?.enabled ?? true;
        }
        if (!expectedSecret) {
            expectedSecret = env.TELEGRAM_SECRET_TOKEN || '';
        }
        if (!expectedSecret) {
            console.error('[TelegramAdapter] Secret token not configured');
            return false;
        }

        return enabled && secretHeader === expectedSecret;
    }

    async parseInbound(req: NextRequest): Promise<GatewayMessage> {
        const body = await readBody(req);
        const payload = JSON.parse(body);
        const secretHeader = req.headers.get('x-telegram-bot-api-secret-token') || '';
        // Resolve via the same TelegramBotLink lookup validateRequest already did
        // (cached on req) — falls back to null, handled per-branch below.
        const resolvedTenantId = await resolveTenantId(req, secretHeader);

        // ── Callback query (inline keyboard button press) ───────────
        if (payload.callback_query) {
            return this.parseCallbackQuery(payload.callback_query, resolvedTenantId);
        }

        // ── Message ─────────────────────────────────────────────────
        if (payload.message) {
            return this.parseMessage(payload.message, resolvedTenantId);
        }

        // Fallback for unsupported update types
        return {
            channelType: 'telegram',
            tenantId: resolvedTenantId || '',
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
                const secretHeader = req.headers.get('x-telegram-bot-api-secret-token') || '';
                const tenantId = (await resolveTenantId(req, secretHeader)) || String(chatId);
                const config = await this.loadConfig(tenantId);
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

    /**
     * Scheduled-task digest → Telegram chat. THROWS on missing config or a
     * failed Telegram API call so the scheduled notifier can record the
     * failure on the run instead of silently dropping the digest.
     */
    async sendScheduledNotification(
        task: ScheduledTask,
        run: AgentOpsRun,
        outcome: ScheduledOutcome,
    ): Promise<void> {
        const chatIdRaw = task.notification?.chatId;
        if (!chatIdRaw) {
            throw new Error('No Telegram chatId configured on the task notification');
        }
        const config = await this.loadConfig(run.tenantId);
        if (config && config.enabled === false) {
            throw new Error('Telegram integration is deactivated — activate it under Channels → Telegram');
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

        await this.sendMessage(run, chatId, text, undefined, { strict: true });
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

    private async parseMessage(
        message: Record<string, unknown>,
        resolvedTenantId: string | null,
    ): Promise<GatewayMessage> {
        const from = message.from as Record<string, unknown> | undefined;
        const chat = message.chat as Record<string, unknown> | undefined;
        const userId = (from?.id as number) ?? 0;
        const chatId = (chat?.id as number) ?? 0;
        const messageId = message.message_id as number | undefined;
        const text = (message.text as string) || '';
        const entities = (message.entities as Array<Record<string, unknown>>) ?? [];
        // chat.id is Telegram's own bookkeeping, not our tenantId — only fall back
        // to it if no TelegramBotLink exists (e.g. env-var-only setups), matching
        // prior (already-broken) behavior rather than silently dropping the run.
        if (!resolvedTenantId) {
            console.warn('[TelegramAdapter] No tenant linked for this bot, falling back to raw chat.id:', chatId);
        }
        const tenantId = resolvedTenantId || String(chatId);

        const botCommandEntity = entities.find(e => e.type === 'bot_command');
        if (botCommandEntity) {
            const offset = (botCommandEntity.offset as number) ?? 0;
            const length = (botCommandEntity.length as number) ?? 0;
            const command = text.slice(offset, offset + length).split('@')[0].toLowerCase();
            const taskDescription = text.slice(offset + length).trim();

            // /new (or /n) ends the current conversation. Bare → reset + confirm, and
            // the next message begins fresh. With text → fall through to a brand-new
            // task below (that new run simply supersedes the old one as the newest).
            if (RESET_COMMANDS.has(command) && !taskDescription) {
                const current = await this.findSessionRun(chatId);
                return {
                    channelType: 'telegram',
                    tenantId,
                    taskDescription: '',
                    userId: String(userId),
                    replyContext: {
                        runId: current?.runId ?? '',
                        action: 'reset',
                        tenantId: current?.tenantId ?? tenantId,
                    },
                    channelMeta: { userId, chatId, messageId },
                };
            }

            // Any other command (/cloudops …, /start) — or /new with text — begins a
            // fresh task; commands are an explicit "new request" signal, never a
            // continuation of the running conversation.
            return {
                channelType: 'telegram',
                tenantId,
                taskDescription,
                userId: String(userId),
                channelMeta: { userId, chatId, messageId },
            };
        }

        // If a run is currently waiting for the user's answer, this message IS that
        // answer — feed it into the same run/thread rather than spawning a new run.
        // Telegram DMs have no thread concept, so the chatId is the conversation key;
        // the user just types, no need for Telegram's native reply-to feature. Once a
        // run has finished, findSessionRun returns null and the message below starts
        // a fresh task.
        const sessionRun = await this.findSessionRun(chatId);
        if (sessionRun) {
            return {
                channelType: 'telegram',
                tenantId,
                taskDescription: text,
                userId: String(userId),
                replyContext: {
                    runId: sessionRun.runId,
                    action: 'clarification_response',
                    content: text,
                    tenantId: sessionRun.tenantId,
                },
                channelMeta: { userId, chatId, messageId },
            };
        }

        // Nothing awaiting input → a brand-new task (starts a fresh run/thread).
        return {
            channelType: 'telegram',
            tenantId,
            taskDescription: text,
            userId: String(userId),
            channelMeta: { userId, chatId, messageId },
        };
    }

    /** The run this chat's next message should continue, or null to start fresh. */
    private findSessionRun(chatId: number) {
        return agentOpsService.findResumableTelegramRun(
            chatId,
            new Date(Date.now() - CONVERSATION_IDLE_MS),
        );
    }

    /** Confirm to the chat that /new started a fresh conversation. */
    async sendSessionReset(tenantId: string, chatId: number): Promise<void> {
        const config = await this.loadConfig(tenantId);
        const botToken = config?.botToken || env.TELEGRAM_BOT_TOKEN || '';
        if (!botToken) return;
        const text = [
            '*New conversation started*',
            '',
            escapeMarkdownV2('Your next message begins a fresh task — earlier context is cleared.'),
        ].join('\n');
        try {
            await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'MarkdownV2' }),
            });
        } catch (err) {
            console.error('[TelegramAdapter] sendSessionReset error:', err);
        }
    }

    private parseCallbackQuery(
        callbackQuery: Record<string, unknown>,
        resolvedTenantId: string | null,
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
        const tenantId = resolvedTenantId || tenantIdFromData || String(chatId);

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

    /**
     * Best-effort by default (interactive replies must never crash a run);
     * pass { strict: true } to surface failures to the caller (scheduled digests).
     */
    private async sendMessage(
        run: AgentOpsRun,
        chatId: number,
        text: string,
        replyMarkup?: Record<string, unknown>,
        opts?: { strict?: boolean },
    ): Promise<void> {
        const config = await this.loadConfig(run.tenantId);
        const botToken = config?.botToken || env.TELEGRAM_BOT_TOKEN || '';

        if (!botToken) {
            if (opts?.strict) throw new Error('No Telegram Bot Token configured — set it under Channels → Telegram');
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
                if (opts?.strict) {
                    throw new Error(`Telegram sendMessage failed (${res.status}): ${responseText.slice(0, 300)}`);
                }
                console.warn(`[TelegramAdapter] sendMessage failed (${res.status}):`, responseText);
            }
        } catch (err) {
            if (opts?.strict) throw err;
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
