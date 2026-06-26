import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramAdapter } from '@/lib/gateway/adapters/telegram-adapter';

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
