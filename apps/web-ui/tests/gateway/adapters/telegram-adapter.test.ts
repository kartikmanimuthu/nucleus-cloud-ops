import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramAdapter } from '@/lib/gateway/adapters/telegram-adapter';
import { TenantConfigService } from '@/lib/tenant-config-service';
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

describe('TelegramAdapter', () => {
    let adapter: TelegramAdapter;

    beforeEach(() => {
        adapter = new TelegramAdapter();
        vi.restoreAllMocks();
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

    it('no-ops without a chatId', async () => {
        const noDest = { ...task, notification: { type: 'telegram' } } as unknown as ScheduledTask;
        await adapter.sendScheduledNotification!(noDest, run, 'result');
        expect(global.fetch).not.toHaveBeenCalled();
    });
});
