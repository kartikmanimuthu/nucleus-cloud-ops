// web-ui/tests/gateway/adapters/discord-adapter.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiscordAdapter } from '@/lib/gateway/adapters/discord-adapter';
import { NarrationSessions } from '@/lib/gateway/narration/narration-session';

vi.mock('@/lib/agent/model-resolver', () => ({
    resolveModelConfig: vi.fn().mockResolvedValue({ provider: 'bedrock', modelId: 'test-model' }),
    resolveDefaultModelConfig: vi.fn().mockResolvedValue({ provider: 'bedrock', modelId: 'test-model' }),
}));
vi.mock('@/lib/gateway/narration/translate-event', () => ({
    translateEventWithFallback: vi.fn(async (e: any) => (e.toolName === 'read_file'
        ? { active: 'Reading a file...', done: 'Read a file' }
        : { active: 'Running an AWS CLI command...', done: 'Ran an AWS CLI command' })),
}));

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

let adapter: DiscordAdapter;

describe('DiscordAdapter', () => {
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

describe('sendStreamChunk narration', () => {
    const run = {
        runId: 'run-1', tenantId: 'tenant-1', source: 'discord', taskDescription: 'test',
        trigger: { channelId: 'C1', userId: 'U1', interactionId: 'i1', interactionToken: 'tok-1' },
    } as any;

    beforeEach(() => {
        adapter = new DiscordAdapter();
        (adapter as any).narration = new NarrationSessions(0);
        global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    });

    it('ignores event types that are not step boundaries', async () => {
        await adapter.sendStreamChunk!(run, { eventType: 'memory_save', node: 'memory_save' } as any);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('patches the original message with a pending checklist step on tool_call', async () => {
        await adapter.sendStreamChunk!(run, { eventType: 'tool_call', node: 'agent', toolName: 'execute_command' } as any);

        expect(global.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = vi.mocked(global.fetch).mock.calls[0];
        expect(url).toContain('/messages/@original');
        expect(init!.method).toBe('PATCH');
        const body = JSON.parse(init!.body as string);
        expect(body.content).toContain('⏳');
        expect(body.content).toContain('Running an AWS CLI command');
    });

    it('completes the matching step on tool_result', async () => {
        await adapter.sendStreamChunk!(run, { eventType: 'tool_call', node: 'agent', toolName: 'execute_command' } as any);
        vi.mocked(global.fetch).mockClear();

        await adapter.sendStreamChunk!(run, { eventType: 'tool_result', node: 'agent', toolName: 'execute_command' } as any);

        const [, init] = vi.mocked(global.fetch).mock.calls[0];
        const body = JSON.parse(init!.body as string);
        expect(body.content).toContain('✅');
        expect(body.content).not.toContain('⏳');
    });

    it('stops narrating once the run has delivered its result', async () => {
        await adapter.sendStreamChunk!(run, { eventType: 'tool_call', node: 'agent', toolName: 'execute_command' } as any);
        await adapter.sendResult({ ...run, result: { summary: 'done' } } as any, []);
        vi.mocked(global.fetch).mockClear();

        await adapter.sendStreamChunk!(run, { eventType: 'tool_call', node: 'agent', toolName: 'read_file' } as any);

        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('truncates the checklist to Discord 2000-char message limit', async () => {
        vi.mocked(
            (await import('@/lib/gateway/narration/translate-event')).translateEventWithFallback,
        ).mockResolvedValueOnce({ active: 'x'.repeat(2500), done: 'x'.repeat(2500) });

        await adapter.sendStreamChunk!(run, { eventType: 'tool_call', node: 'agent', toolName: 'execute_command' } as any);

        const [, init] = vi.mocked(global.fetch).mock.calls[0];
        const body = JSON.parse(init!.body as string);
        expect(body.content.length).toBe(2000);
    });
});
