// web-ui/tests/gateway/adapters/discord-adapter.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiscordAdapter } from '@/lib/gateway/adapters/discord-adapter';

vi.mock('@/lib/tenant-config-service', () => ({
    TenantConfigService: {
        getConfig: vi.fn().mockResolvedValue({
            applicationId: 'app-123',
            publicKey: 'abc123publickey',
            botToken: 'discord-bot-token',
            enabled: true,
        }),
    },
}));

describe('DiscordAdapter', () => {
    let adapter: DiscordAdapter;

    beforeEach(() => {
        adapter = new DiscordAdapter();
    });

    it('has correct channel metadata', () => {
        expect(adapter.channelType).toBe('discord');
        expect(adapter.deliveryMode).toBe('streaming');
        expect(adapter.hilCapabilities).toEqual({
            clarification: true,
            approvalButtons: true,
            threadedReplies: true,
        });
    });

    it('rejects requests with missing signature headers', async () => {
        const req = new Request('http://localhost/api/v1/gateway/discord', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 1 }),
        });
        const result = await adapter.validateRequest(req as any);
        expect(result).toBe(false);
    });

    it('parseInbound extracts slash command interaction', async () => {
        const payload = {
            type: 2,
            data: { name: 'cloudops', options: [{ name: 'task', type: 3, value: 'Check Lambda configs' }] },
            member: { user: { id: 'user-123' } },
            channel_id: 'ch-456',
            guild_id: 'guild-789',
            id: 'interaction-1',
            token: 'interaction-token-abc',
        };
        const req = new Request('http://localhost/api/v1/gateway/discord', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const msg = await adapter.parseInbound(req as any);
        expect(msg.channelType).toBe('discord');
        expect(msg.taskDescription).toBe('Check Lambda configs');
        expect(msg.channelMeta).toMatchObject({
            userId: 'user-123',
            channelId: 'ch-456',
            interactionId: 'interaction-1',
            interactionToken: 'interaction-token-abc',
        });
    });

    it('parseInbound detects button interaction as ReplyContext', async () => {
        const payload = {
            type: 3,
            data: { custom_id: 'approve:run-1:tenant-1' },
            member: { user: { id: 'user-123' } },
            channel_id: 'ch-456',
            id: 'interaction-2',
            token: 'interaction-token-def',
        };
        const req = new Request('http://localhost/api/v1/gateway/discord', {
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

    it('sendAck returns deferred response (type 5)', async () => {
        const req = new Request('http://localhost', { method: 'POST' });
        const res = await adapter.sendAck(req as any, 'run-1');
        const json = await res.json();
        expect(json.type).toBe(5);
    });

    it('parseInbound handles PING (type 1)', async () => {
        const payload = { type: 1 };
        const req = new Request('http://localhost/api/v1/gateway/discord', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const msg = await adapter.parseInbound(req as any);
        expect(msg.taskDescription).toBe('');
        expect(msg.channelMeta).toMatchObject({ ping: true });
    });
});
