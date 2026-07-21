import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramAdapter } from '@/lib/gateway/adapters/telegram-adapter';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { getTelegramBotLinkRepository } from '@/lib/db/repository-factory';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import type { ScheduledTask, AgentOpsRun } from '@/lib/agent-ops/types';

vi.mock('@/lib/tenant-config-service', () => ({
    TenantConfigService: {
        getConfig: vi.fn().mockResolvedValue({
            botToken: 'tg-bot-token',
            secretToken: 'tg-secret',
            enabled: true,
        }),
    },
}));

vi.mock('@/lib/agent-ops/agent-ops-service', () => ({
    agentOpsService: {
        findResumableTelegramRun: vi.fn().mockResolvedValue(null),
        closeTelegramSession: vi.fn().mockResolvedValue(undefined),
    },
}));

// chat.id is Telegram's own bookkeeping, never our tenantId — it must be
// translated via TelegramBotLink (the secret token is the only tenant-identifying
// value Telegram ever sends back), so every test needs this mocked.
vi.mock('@/lib/db/repository-factory', () => ({
    getTelegramBotLinkRepository: vi.fn().mockReturnValue({
        findTenantIdBySecretToken: vi.fn().mockResolvedValue('tenant-1'),
        upsertLink: vi.fn().mockResolvedValue(undefined),
        getLinkForTenant: vi.fn().mockResolvedValue(null),
        deleteLinkForTenant: vi.fn().mockResolvedValue(0),
    }),
}));

describe('TelegramAdapter', () => {
    let adapter: TelegramAdapter;

    beforeEach(() => {
        adapter = new TelegramAdapter();
        vi.restoreAllMocks();
        vi.mocked(getTelegramBotLinkRepository).mockReturnValue({
            findTenantIdBySecretToken: vi.fn().mockResolvedValue('tenant-1'),
            upsertLink: vi.fn().mockResolvedValue(undefined),
            getLinkForTenant: vi.fn().mockResolvedValue(null),
            deleteLinkForTenant: vi.fn().mockResolvedValue(0),
        } as any);
        vi.mocked(agentOpsService.findResumableTelegramRun).mockResolvedValue(null);
        vi.mocked(agentOpsService.closeTelegramSession).mockResolvedValue(undefined);
    });

    it('has correct channel metadata', () => {
        expect(adapter.channelType).toBe('telegram');
        expect(adapter.deliveryMode).toBe('streaming');
        expect(adapter.hilCapabilities).toEqual({
            clarification: true,
            approvalButtons: true,
            threadedReplies: true,
        });
    });

    it('validates secret token header', async () => {
        const req = new Request('http://localhost/api/v1/gateway/telegram', {
            method: 'POST',
            headers: { 'x-telegram-bot-api-secret-token': 'tg-secret', 'content-type': 'application/json' },
            body: JSON.stringify({ message: { text: '/cloudops test', chat: { id: 123 } } }),
        });
        const result = await adapter.validateRequest(req as any);
        expect(result).toBe(true);
    });

    it('rejects invalid secret token', async () => {
        const req = new Request('http://localhost/api/v1/gateway/telegram', {
            method: 'POST',
            headers: { 'x-telegram-bot-api-secret-token': 'wrong', 'content-type': 'application/json' },
            body: JSON.stringify({ message: { text: '/cloudops test', chat: { id: 123 } } }),
        });
        const result = await adapter.validateRequest(req as any);
        expect(result).toBe(false);
    });

    it('parseInbound extracts bot command', async () => {
        const payload = {
            message: {
                message_id: 100,
                from: { id: 12345 },
                chat: { id: 67890 },
                text: '/cloudops Check Lambda configs',
                entities: [{ type: 'bot_command', offset: 0, length: 10 }],
            },
        };
        const req = new Request('http://localhost/api/v1/gateway/telegram', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const msg = await adapter.parseInbound(req as any);
        expect(msg.channelType).toBe('telegram');
        expect(msg.taskDescription).toBe('Check Lambda configs');
        expect(msg.channelMeta).toMatchObject({ userId: 12345, chatId: 67890 });
    });

    it('parseInbound resolves tenantId from the secret token link, not chat.id', async () => {
        const payload = {
            message: {
                message_id: 100,
                from: { id: 12345 },
                chat: { id: 67890 }, // Telegram's own id — must NOT leak through as tenantId
                text: 'hello',
            },
        };
        const req = new Request('http://localhost/api/v1/gateway/telegram', {
            method: 'POST',
            headers: { 'x-telegram-bot-api-secret-token': 'tg-secret', 'content-type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const msg = await adapter.parseInbound(req as any);
        expect(msg.tenantId).toBe('tenant-1');
        expect(msg.tenantId).not.toBe(String(payload.message.chat.id));
    });

    it('parseInbound falls back to raw chat.id when no bot link exists', async () => {
        vi.mocked(getTelegramBotLinkRepository).mockReturnValue({
            findTenantIdBySecretToken: vi.fn().mockResolvedValue(null),
            upsertLink: vi.fn().mockResolvedValue(undefined),
            getLinkForTenant: vi.fn().mockResolvedValue(null),
            deleteLinkForTenant: vi.fn().mockResolvedValue(0),
        } as any);
        const payload = { message: { message_id: 1, from: { id: 1 }, chat: { id: 67890 }, text: 'hello' } };
        const req = new Request('http://localhost/api/v1/gateway/telegram', {
            method: 'POST',
            headers: { 'x-telegram-bot-api-secret-token': 'tg-secret', 'content-type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const msg = await adapter.parseInbound(req as any);
        expect(msg.tenantId).toBe('67890');
    });

    it('parseInbound detects callback query as ReplyContext', async () => {
        const payload = {
            callback_query: {
                id: 'cbq-1',
                from: { id: 12345 },
                message: { chat: { id: 67890 }, message_id: 101 },
                data: 'approve:run-1:tenant-1',
            },
        };
        const req = new Request('http://localhost/api/v1/gateway/telegram', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const msg = await adapter.parseInbound(req as any);
        expect(msg.replyContext).toEqual({
            runId: 'run-1',
            action: 'approve',
            tenantId: 'tenant-1',
        });
    });

    const plainMessageReq = (text: string, chatId = 67890) => {
        const payload = { message: { message_id: 100, from: { id: 12345 }, chat: { id: chatId }, text } };
        return new Request('http://localhost/api/v1/gateway/telegram', {
            method: 'POST',
            headers: { 'x-telegram-bot-api-secret-token': 'tg-secret', 'content-type': 'application/json' },
            body: JSON.stringify(payload),
        });
    };

    const commandReq = (text: string, commandLen: number) => {
        const payload = {
            message: {
                message_id: 100, from: { id: 12345 }, chat: { id: 67890 }, text,
                entities: [{ type: 'bot_command', offset: 0, length: commandLen }],
            },
        };
        return new Request('http://localhost/api/v1/gateway/telegram', {
            method: 'POST',
            headers: { 'x-telegram-bot-api-secret-token': 'tg-secret', 'content-type': 'application/json' },
            body: JSON.stringify(payload),
        });
    };

    it('answers the pending clarification when a run is awaiting the user input', async () => {
        vi.mocked(agentOpsService.findResumableTelegramRun).mockResolvedValue({
            runId: 'run-9', tenantId: 'tenant-1', status: 'awaiting_input',
        } as unknown as AgentOpsRun);
        const msg = await adapter.parseInbound(plainMessageReq('use ap-south-1') as any);
        expect(vi.mocked(agentOpsService.findResumableTelegramRun)).toHaveBeenCalledWith(67890, expect.any(Date));
        expect(msg.replyContext).toEqual({
            runId: 'run-9',
            action: 'clarification_response',
            content: 'use ap-south-1',
            tenantId: 'tenant-1',
        });
    });

    it('starts a new run when nothing is awaiting input (finished/no conversation)', async () => {
        vi.mocked(agentOpsService.findResumableTelegramRun).mockResolvedValue(null);
        const msg = await adapter.parseInbound(plainMessageReq('now show me the RDS databases') as any);
        expect(msg.replyContext).toBeUndefined();
        expect(msg.taskDescription).toBe('now show me the RDS databases');
    });

    it('"/new" with no text resets the session, referencing the current run', async () => {
        vi.mocked(agentOpsService.findResumableTelegramRun).mockResolvedValue({
            runId: 'run-9', tenantId: 'tenant-1', status: 'completed',
        } as unknown as AgentOpsRun);
        const msg = await adapter.parseInbound(commandReq('/new', 4) as any);
        expect(msg.replyContext).toEqual({ runId: 'run-9', action: 'reset', tenantId: 'tenant-1' });
        expect(msg.taskDescription).toBe('');
    });

    it('"/new <text>" starts a fresh task without continuing the old run', async () => {
        vi.mocked(agentOpsService.findResumableTelegramRun).mockResolvedValue({
            runId: 'run-9', tenantId: 'tenant-1', status: 'completed',
        } as unknown as AgentOpsRun);
        const msg = await adapter.parseInbound(commandReq('/new list RDS databases', 4) as any);
        expect(msg.replyContext).toBeUndefined();
        expect(msg.taskDescription).toBe('list RDS databases');
    });

    it('bot command "/cloudops ..." starts a new task even with an active session', async () => {
        vi.mocked(agentOpsService.findResumableTelegramRun).mockResolvedValue({
            runId: 'run-9', tenantId: 'tenant-1', status: 'completed',
        } as unknown as AgentOpsRun);
        const msg = await adapter.parseInbound(commandReq('/cloudops Check Lambda configs', 9) as any);
        expect(msg.replyContext).toBeUndefined();
        expect(msg.taskDescription).toBe('Check Lambda configs');
    });

    it('sendAck returns 200', async () => {
        global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, result: { message_id: 200 } }) });
        const req = new Request('http://localhost', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ message: { chat: { id: 123 } } }),
        });
        const res = await adapter.sendAck(req as any, 'run-1');
        expect(res.status).toBe(200);
    });
});

describe('TelegramAdapter.sendScheduledNotification', () => {
    let adapter: TelegramAdapter;

    const task = {
        taskId: 'task-1',
        tenantId: 'tenant-1',
        name: 'Daily Cost Review',
        notification: { type: 'telegram', chatId: '-1001234567890' },
    } as unknown as ScheduledTask;

    const run = {
        runId: 'run-1',
        tenantId: 'tenant-1',
        source: 'scheduled',
        status: 'completed',
        durationMs: 42000,
        trigger: { taskId: 'task-1', taskName: 'Daily Cost Review', scheduledAt: '2026-07-05T00:00:00Z' },
        result: { summary: 'No anomalies found', toolsUsed: ['execute_command'], iterations: 2 },
    } as unknown as AgentOpsRun;

    beforeEach(() => {
        adapter = new TelegramAdapter();
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({
            botToken: 'tg-bot-token',
            secretToken: 'tg-secret',
            enabled: true,
        });
        global.fetch = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ ok: true }), { status: 200 }),
        ) as unknown as typeof fetch;
    });

    it('sends a result digest to the configured chat with the tenant botToken', async () => {
        await adapter.sendScheduledNotification!(task, run, 'result');

        expect(global.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = vi.mocked(global.fetch).mock.calls[0];
        expect(url).toBe('https://api.telegram.org/bottg-bot-token/sendMessage');
        const body = JSON.parse(init!.body as string);
        expect(body.chat_id).toBe(-1001234567890);
        expect(body.parse_mode).toBe('MarkdownV2');
        expect(body.text).toContain('No anomalies found');
    });

    it('sends a failure digest containing the error', async () => {
        const failed = { ...run, status: 'failed', error: 'permission denied' } as unknown as AgentOpsRun;
        await adapter.sendScheduledNotification!(task, failed, 'failure');
        const body = JSON.parse(vi.mocked(global.fetch).mock.calls[0][1]!.body as string);
        expect(body.text).toContain('permission denied');
    });

    it('sends an attention digest with a dashboard link', async () => {
        const parked = {
            ...run, status: 'awaiting_input',
            clarification: { question: 'Which region?', missingInfo: 'region' },
        } as unknown as AgentOpsRun;
        await adapter.sendScheduledNotification!(task, parked, 'attention');
        const body = JSON.parse(vi.mocked(global.fetch).mock.calls[0][1]!.body as string);
        expect(body.text).toContain('Which region');
        expect(body.text).toContain('run\\-1');
    });

    it('caps the sent text at 4096 chars for an oversized summary', async () => {
        const huge = { ...run, result: { ...run.result, summary: 'x'.repeat(10_000) } } as unknown as AgentOpsRun;
        await adapter.sendScheduledNotification!(task, huge, 'result');
        const body = JSON.parse(vi.mocked(global.fetch).mock.calls[0][1]!.body as string);
        expect(body.text.length).toBeLessThanOrEqual(4096);
    });

    it('no-ops without a chatId', async () => {
        const noDest = { ...task, notification: { type: 'telegram' } } as unknown as ScheduledTask;
        await adapter.sendScheduledNotification!(noDest, run, 'result');
        expect(global.fetch).not.toHaveBeenCalled();
    });
});
