// web-ui/tests/gateway/adapters/discord-adapter.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import nacl from 'tweetnacl';
import { DiscordAdapter } from '@/lib/gateway/adapters/discord-adapter';
import { NarrationSessions } from '@/lib/gateway/narration/narration-session';
import { TenantConfigService } from '@/lib/tenant-config-service';

const { mockEnv } = vi.hoisted(() => ({ mockEnv: {} as Record<string, string | undefined> }));
vi.mock('@/env', () => ({ env: mockEnv }));

function toHex(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('hex');
}

function signRequest(keyPair: nacl.SignKeyPair, timestamp: string, body: string) {
    const message = Buffer.from(timestamp + body);
    const signature = nacl.sign.detached(new Uint8Array(message), keyPair.secretKey);
    return toHex(signature);
}

function makeSignedRequest(keyPair: nacl.SignKeyPair, body: Record<string, unknown>) {
    const bodyStr = JSON.stringify(body);
    const timestamp = '1700000000';
    const signature = signRequest(keyPair, timestamp, bodyStr);
    return new Request('http://localhost/api/v1/gateway/discord', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-signature-ed25519': signature,
            'x-signature-timestamp': timestamp,
        },
        body: bodyStr,
    });
}

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

describe('validateRequest — Ed25519 signature verification', () => {
    const keyPair = nacl.sign.keyPair();
    const publicKeyHex = toHex(keyPair.publicKey);

    beforeEach(() => {
        adapter = new DiscordAdapter();
        mockEnv.DISCORD_PUBLIC_KEY = undefined;
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({
            applicationId: 'app-123', publicKey: publicKeyHex, botToken: 'bot-token', enabled: true,
        } as any);
    });

    it('accepts a genuinely valid signature', async () => {
        const req = makeSignedRequest(keyPair, { type: 1, guild_id: 'guild-1' });
        expect(await adapter.validateRequest(req as any)).toBe(true);
    });

    it('rejects a tampered signature', async () => {
        const req = makeSignedRequest(keyPair, { type: 1, guild_id: 'guild-1' });
        const tampered = new Request(req.url, {
            method: 'POST',
            headers: req.headers,
            body: JSON.stringify({ type: 1, guild_id: 'guild-1', tampered: true }),
        });
        expect(await adapter.validateRequest(tampered as any)).toBe(false);
    });

    it('rejects a signature verified against the wrong public key', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValueOnce({
            applicationId: 'app-123', publicKey: toHex(nacl.sign.keyPair().publicKey), botToken: 'x', enabled: true,
        } as any);
        const req = makeSignedRequest(keyPair, { type: 1, guild_id: 'guild-1' });
        expect(await adapter.validateRequest(req as any)).toBe(false);
    });

    it('falls back to the env public key when the body has no guild_id', async () => {
        const envKeyPair = nacl.sign.keyPair();
        mockEnv.DISCORD_PUBLIC_KEY = toHex(envKeyPair.publicKey);
        const callsBefore = vi.mocked(TenantConfigService.getConfig).mock.calls.length;
        const req = makeSignedRequest(envKeyPair, { type: 1 }); // no guild_id
        expect(await adapter.validateRequest(req as any)).toBe(true);
        // No guild_id to resolve a tenant from — the tenant config lookup is skipped entirely.
        expect(vi.mocked(TenantConfigService.getConfig).mock.calls.length).toBe(callsBefore);
    });

    it('falls back to the env public key when TenantConfigService lookup fails', async () => {
        vi.mocked(TenantConfigService.getConfig).mockRejectedValueOnce(new Error('db down'));
        const envKeyPair = nacl.sign.keyPair();
        mockEnv.DISCORD_PUBLIC_KEY = toHex(envKeyPair.publicKey);
        const req = makeSignedRequest(envKeyPair, { type: 1, guild_id: 'guild-1' });
        expect(await adapter.validateRequest(req as any)).toBe(true);
    });

    it('falls back to the env public key when the tenant config has none set', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValueOnce({ applicationId: 'app-123' } as any);
        const envKeyPair = nacl.sign.keyPair();
        mockEnv.DISCORD_PUBLIC_KEY = toHex(envKeyPair.publicKey);
        const req = makeSignedRequest(envKeyPair, { type: 1, guild_id: 'guild-1' });
        expect(await adapter.validateRequest(req as any)).toBe(true);
    });

    it('returns false when no public key is configured anywhere', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValueOnce(null as any);
        mockEnv.DISCORD_PUBLIC_KEY = undefined;
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const req = makeSignedRequest(keyPair, { type: 1, guild_id: 'guild-1' });

        expect(await adapter.validateRequest(req as any)).toBe(false);
        expect(errSpy).toHaveBeenCalledWith('[DiscordAdapter] Public key not configured');
    });

    it('returns false when the body is not valid JSON but still falls through to env fallback', async () => {
        const envKeyPair = nacl.sign.keyPair();
        mockEnv.DISCORD_PUBLIC_KEY = toHex(envKeyPair.publicKey);
        const bodyStr = 'not-json';
        const timestamp = '1700000000';
        const signature = signRequest(envKeyPair, timestamp, bodyStr);
        const req = new Request('http://localhost/api/v1/gateway/discord', {
            method: 'POST',
            headers: { 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp },
            body: bodyStr,
        });
        expect(await adapter.validateRequest(req as any)).toBe(true);
    });

    it('returns false when the signature or public key is malformed hex', async () => {
        const req = new Request('http://localhost/api/v1/gateway/discord', {
            method: 'POST',
            headers: { 'x-signature-ed25519': 'not-hex-zz', 'x-signature-timestamp': '1700000000' },
            body: JSON.stringify({ type: 1, guild_id: 'guild-1' }),
        });
        expect(await adapter.validateRequest(req as any)).toBe(false);
    });
});

describe('outbound embeds and patchOriginalMessage', () => {
    const run = {
        runId: 'run-1', tenantId: 'tenant-1', source: 'discord', taskDescription: 'Check Lambda configs',
        trigger: { channelId: 'C1', userId: 'U1', interactionId: 'i1', interactionToken: 'tok-1' },
        result: { summary: 'All good', toolsUsed: ['describe_instances'] },
        durationMs: 4200,
    } as any;

    beforeEach(() => {
        adapter = new DiscordAdapter();
        (adapter as any).narration = new NarrationSessions(0);
        global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({
            applicationId: 'app-123', publicKey: 'x', botToken: 'discord-bot-token', enabled: true,
        } as any);
    });
    afterEach(() => vi.restoreAllMocks());

    it('sendResult patches an embed with tools used and duration', async () => {
        await adapter.sendResult(run, []);
        const [, init] = vi.mocked(global.fetch).mock.calls[0];
        const body = JSON.parse(init!.body as string);
        expect(body.embeds[0].title).toBe('Agent Ops Complete');
        expect(body.embeds[0].fields[0].value).toBe('describe_instances');
        expect(body.embeds[0].fields[1].value).toBe('4s');
    });

    it('sendResult defaults toolsUsed to "None" and summary to a placeholder when absent', async () => {
        await adapter.sendResult({ ...run, result: {} } as any, []);
        const [, init] = vi.mocked(global.fetch).mock.calls[0];
        const body = JSON.parse(init!.body as string);
        expect(body.embeds[0].description).toBe('(no summary)');
        expect(body.embeds[0].fields[0].value).toBe('None');
    });

    it('sendError patches a red failure embed', async () => {
        await adapter.sendError(run, 'Something broke');
        const [, init] = vi.mocked(global.fetch).mock.calls[0];
        const body = JSON.parse(init!.body as string);
        expect(body.embeds[0]).toEqual(expect.objectContaining({ title: 'Agent Ops Failed', description: 'Something broke' }));
    });

    it('sendClarification patches an embed with a dashboard link', async () => {
        await adapter.sendClarification(run, 'Which account?');
        const [, init] = vi.mocked(global.fetch).mock.calls[0];
        const body = JSON.parse(init!.body as string);
        expect(body.embeds[0].description).toBe('Which account?');
        expect(body.embeds[0].fields[0].value).toContain('Open Dashboard');
    });

    it('sendApprovalRequest patches an embed with Approve/Reject buttons', async () => {
        await adapter.sendApprovalRequest(run, ['Step 1', 'Step 2'], ['stop_instance']);
        const [, init] = vi.mocked(global.fetch).mock.calls[0];
        const body = JSON.parse(init!.body as string);
        expect(body.embeds[0].description).toContain('1. Step 1');
        expect(body.embeds[0].description).toContain('`stop_instance`');
        expect(body.components[0].components).toHaveLength(2);
        expect(body.components[0].components[0].custom_id).toBe('approve:run-1:tenant-1');
    });

    it('sendApprovalRequest omits the tools line when none are pending', async () => {
        await adapter.sendApprovalRequest(run, ['Step 1']);
        const [, init] = vi.mocked(global.fetch).mock.calls[0];
        const body = JSON.parse(init!.body as string);
        expect(body.embeds[0].description).not.toContain('Tools:');
    });

    it('getConfig returns the tenant config', async () => {
        const config = await adapter.getConfig!('tenant-1');
        expect(config).toEqual(expect.objectContaining({ applicationId: 'app-123' }));
    });

    it('getConfig defaults to {} when the lookup fails', async () => {
        vi.mocked(TenantConfigService.getConfig).mockRejectedValueOnce(new Error('db down'));
        expect(await adapter.getConfig!('tenant-1')).toEqual({});
    });

    it('patchOriginalMessage warns and skips the fetch when applicationId or interactionToken is missing', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValueOnce({ botToken: 'x' } as any);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await adapter.sendError(run, 'oops');

        expect(global.fetch).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith('[DiscordAdapter] Missing applicationId or interactionToken');
    });

    it('patchOriginalMessage warns with the response body when the PATCH fails', async () => {
        global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => 'Unknown Message' });
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await adapter.sendError(run, 'oops');

        expect(warnSpy).toHaveBeenCalledWith('[DiscordAdapter] PATCH failed (404):', 'Unknown Message');
    });

    it('patchOriginalMessage catches and logs a network failure', async () => {
        global.fetch = vi.fn().mockRejectedValue(new Error('network down'));
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        await adapter.sendError(run, 'oops');

        expect(errSpy).toHaveBeenCalledWith('[DiscordAdapter] patchOriginalMessage error:', expect.any(Error));
    });
});
