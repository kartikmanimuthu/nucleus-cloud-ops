import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramAdapter } from '@/lib/gateway/adapters/telegram-adapter';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { getTelegramBotLinkRepository } from '@/lib/db/repository-factory';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { NarrationSessions } from '@/lib/gateway/narration/narration-session';
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
vi.mock('@/lib/agent/model-resolver', () => ({
    resolveModelConfig: vi.fn().mockResolvedValue({ provider: 'bedrock', modelId: 'test-model' }),
    resolveDefaultModelConfig: vi.fn().mockResolvedValue({ provider: 'bedrock', modelId: 'test-model' }),
}));
vi.mock('@/lib/gateway/narration/translate-event', () => ({
    translateEventWithFallback: vi.fn(async (e: any) => (e.toolName === 'read_file'
        ? { active: 'Reading a file...', done: 'Read a file' }
        : { active: 'Running an AWS CLI command...', done: 'Ran an AWS CLI command' })),
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

    describe('sendDirectReply', () => {
        it('posts the reply text via the bot API and acks the webhook', async () => {
            global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
            const req = new Request('http://localhost/api/v1/gateway/telegram', {
                method: 'POST',
                headers: { 'x-telegram-bot-api-secret-token': 'tg-secret', 'content-type': 'application/json' },
                body: JSON.stringify({ message: { text: 'hi', chat: { id: 555 } } }),
            });

            const res = await adapter.sendDirectReply!(req as any, 'Hey! What can I help with?');

            expect(res).not.toBeNull();
            expect(res!.status).toBe(200);
            expect(global.fetch).toHaveBeenCalledTimes(1);
            const [url, init] = vi.mocked(global.fetch).mock.calls[0];
            expect(url).toContain('/sendMessage');
            const body = JSON.parse(init!.body as string);
            expect(body.chat_id).toBe(555);
            expect(body.text).toContain('Hey\\!');
            // Without MarkdownV2 the escapes above render literally as "Hey\!".
            expect(body.parse_mode).toBe('MarkdownV2');
        });

        it('truncates a very long reply so the escaped text stays under Telegram 4096 cap', async () => {
            global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
            const req = new Request('http://localhost/api/v1/gateway/telegram', {
                method: 'POST',
                headers: { 'x-telegram-bot-api-secret-token': 'tg-secret', 'content-type': 'application/json' },
                body: JSON.stringify({ message: { text: 'hi', chat: { id: 555 } } }),
            });

            await adapter.sendDirectReply!(req as any, '!'.repeat(5000));

            const [, init] = vi.mocked(global.fetch).mock.calls[0];
            const body = JSON.parse(init!.body as string);
            expect(body.text.length).toBeLessThan(4096);
        });

        it('skips the API call and still acks when the model returned nothing', async () => {
            global.fetch = vi.fn();
            const req = new Request('http://localhost/api/v1/gateway/telegram', {
                method: 'POST',
                headers: { 'x-telegram-bot-api-secret-token': 'tg-secret', 'content-type': 'application/json' },
                body: JSON.stringify({ message: { text: 'hi', chat: { id: 555 } } }),
            });

            const res = await adapter.sendDirectReply!(req as any, '   ');

            expect(res!.status).toBe(200);
            expect(global.fetch).not.toHaveBeenCalled();
        });

        // Returning null (not an ack) is what makes the gateway fall through to
        // a real Agent Ops run instead of silently dropping the user's message.
        it('returns null without throwing when the chat id cannot be resolved', async () => {
            global.fetch = vi.fn();
            const req = new Request('http://localhost/api/v1/gateway/telegram', {
                method: 'POST',
                headers: { 'x-telegram-bot-api-secret-token': 'tg-secret', 'content-type': 'application/json' },
                body: 'not json',
            });

            const res = await adapter.sendDirectReply!(req as any, 'hi');

            expect(res).toBeNull();
            expect(global.fetch).not.toHaveBeenCalled();
        });

        it('returns null when no bot token is configured', async () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            vi.mocked(TenantConfigService.getConfig).mockResolvedValueOnce({
                botToken: '',
                secretToken: 'tg-secret',
                enabled: true,
            } as any);
            global.fetch = vi.fn();
            const req = new Request('http://localhost/api/v1/gateway/telegram', {
                method: 'POST',
                headers: { 'x-telegram-bot-api-secret-token': 'tg-secret', 'content-type': 'application/json' },
                body: JSON.stringify({ message: { text: 'hi', chat: { id: 555 } } }),
            });

            const res = await adapter.sendDirectReply!(req as any, 'hi there');

            expect(res).toBeNull();
            expect(global.fetch).not.toHaveBeenCalled();
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('bot token not configured'));
        });

        it('returns null without throwing when the Telegram API call rejects', async () => {
            const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            global.fetch = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
            const req = new Request('http://localhost/api/v1/gateway/telegram', {
                method: 'POST',
                headers: { 'x-telegram-bot-api-secret-token': 'tg-secret', 'content-type': 'application/json' },
                body: JSON.stringify({ message: { text: 'hi', chat: { id: 555 } } }),
            });

            const res = await adapter.sendDirectReply!(req as any, 'hi there');

            expect(res).toBeNull();
            expect(global.fetch).toHaveBeenCalledTimes(1);
            expect(errSpy).toHaveBeenCalled();
        });

        it('returns null and warns with the status and body when Telegram rejects the message', async () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            global.fetch = vi.fn().mockResolvedValue({
                ok: false,
                status: 400,
                text: async () => "Bad Request: can't parse entities",
            });
            const req = new Request('http://localhost/api/v1/gateway/telegram', {
                method: 'POST',
                headers: { 'x-telegram-bot-api-secret-token': 'tg-secret', 'content-type': 'application/json' },
                body: JSON.stringify({ message: { text: 'hi', chat: { id: 555 } } }),
            });

            const res = await adapter.sendDirectReply!(req as any, 'hi there');

            expect(res).toBeNull();
            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining('400'),
                expect.stringContaining('parse entities'),
            );
        });
    });
});

describe('sendStreamChunk narration', () => {
    let adapter: TelegramAdapter;
    const run = {
        runId: 'run-1', tenantId: 'tenant-1', source: 'telegram',
        taskDescription: 'test', trigger: { chatId: 555, userId: 1 },
    } as any;

    beforeEach(async () => {
        adapter = new TelegramAdapter();
        (adapter as any).narration = new NarrationSessions(0);
        global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, result: { message_id: 200 } }) });
        // A real run always acks first, which registers the message id
        // sendStreamChunk edits.
        const ackReq = new Request('http://localhost/api/v1/gateway/telegram', {
            method: 'POST',
            headers: { 'x-telegram-bot-api-secret-token': 'tg-secret', 'content-type': 'application/json' },
            body: JSON.stringify({ message: { text: 'do a task', chat: { id: 555 } } }),
        });
        await adapter.sendAck(ackReq as any, 'run-1');
        vi.mocked(global.fetch).mockClear();
    });

    it('ignores event types that are not step boundaries', async () => {
        await adapter.sendStreamChunk!(run, { eventType: 'memory_save', node: 'memory_save' } as any);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('edits the ack message with a pending checklist step on tool_call', async () => {
        await adapter.sendStreamChunk!(run, { eventType: 'tool_call', node: 'agent', toolName: 'execute_command' } as any);

        expect(global.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = vi.mocked(global.fetch).mock.calls[0];
        expect(url).toContain('/editMessageText');
        const body = JSON.parse(init!.body as string);
        expect(body.text).toContain('⏳');
        expect(body.text).toContain('Running an AWS CLI command');
    });

    it('completes the matching step on tool_result', async () => {
        await adapter.sendStreamChunk!(run, { eventType: 'tool_call', node: 'agent', toolName: 'execute_command' } as any);
        vi.mocked(global.fetch).mockClear();

        await adapter.sendStreamChunk!(run, { eventType: 'tool_result', node: 'agent', toolName: 'execute_command' } as any);

        const [, init] = vi.mocked(global.fetch).mock.calls[0];
        const body = JSON.parse(init!.body as string);
        expect(body.text).toContain('✅');
        expect(body.text).not.toContain('⏳');
    });

    it('stops narrating once the run has delivered its result', async () => {
        await adapter.sendStreamChunk!(run, { eventType: 'tool_call', node: 'agent', toolName: 'execute_command' } as any);
        await adapter.sendResult({ ...run, result: { summary: 'done' } } as any, []);
        vi.mocked(global.fetch).mockClear();

        await adapter.sendStreamChunk!(run, { eventType: 'tool_call', node: 'agent', toolName: 'read_file' } as any);

        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('delivers the final result as a new message so the narration stays visible', async () => {
        await adapter.sendStreamChunk!(run, { eventType: 'tool_call', node: 'agent', toolName: 'execute_command' } as any);
        vi.mocked(global.fetch).mockClear();

        await adapter.sendResult({ ...run, result: { summary: 'done' } } as any, []);

        const urls = vi.mocked(global.fetch).mock.calls.map(([url]) => String(url));
        expect(urls.some(u => u.includes('/sendMessage'))).toBe(true);
        expect(urls.some(u => u.includes('/editMessageText'))).toBe(false);
    });

    it('does nothing when there is no ack message id for the run', async () => {
        await adapter.sendStreamChunk!(
            { ...run, runId: 'run-never-acked' },
            { eventType: 'tool_call', node: 'agent', toolName: 'execute_command' } as any,
        );
        expect(global.fetch).not.toHaveBeenCalled();
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

    // sendScheduledNotification THROWS on missing config (mirrors SlackAdapter —
    // see its adapter test for the full rationale); notifyScheduledRunResult()
    // catches it and records the message as a failure event on the run.
    it('throws a descriptive error without a chatId', async () => {
        const noDest = { ...task, notification: { type: 'telegram' } } as unknown as ScheduledTask;
        await expect(adapter.sendScheduledNotification!(noDest, run, 'result')).rejects.toThrow(
            'No Telegram chatId configured on the task notification'
        );
        expect(global.fetch).not.toHaveBeenCalled();
    });
});

describe('TelegramAdapter delivery resilience', () => {
    const run = {
        runId: 'run-1', tenantId: 'tenant-1', source: 'telegram',
        taskDescription: 'test', trigger: { chatId: 555, userId: 1 },
        result: { summary: 'done', toolsUsed: ['execute_command'] }, durationMs: 1000,
    } as any;

    const netError = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    const okResponse = { ok: true, json: async () => ({ ok: true, result: { message_id: 200 } }) };
    const sendCalls = () =>
        vi.mocked(global.fetch).mock.calls.filter(([url]) => String(url).includes('/sendMessage'));
    const bodyOf = (call: any) => JSON.parse(call[1].body as string);

    let adapter: TelegramAdapter;
    beforeEach(() => {
        adapter = new TelegramAdapter(0); // no backoff delay in tests
    });

    it('retries a reset connection and delivers on the second attempt', async () => {
        global.fetch = vi.fn()
            .mockRejectedValueOnce(netError())
            .mockResolvedValueOnce(okResponse);

        await adapter.sendResult(run, []);

        expect(sendCalls()).toHaveLength(2);
        expect(bodyOf(sendCalls()[1]).text).toContain('Agent Ops Complete');
    });

    // A 400 (MESSAGE_TOO_LONG, invalid_auth, chat not found) fails identically on
    // every attempt — retrying only delays the same outcome.
    it('does not retry a 4xx from Telegram', async () => {
        global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'MESSAGE_TOO_LONG' });

        await adapter.sendResult(run, []);

        // One attempt for the result, one for the fallback notice — no retries.
        expect(sendCalls()).toHaveLength(2);
    });

    it('retries a 429 rather than giving up', async () => {
        global.fetch = vi.fn()
            .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'Too Many Requests' })
            .mockResolvedValueOnce(okResponse);

        await adapter.sendResult(run, []);

        expect(sendCalls()).toHaveLength(2);
    });

    it('tells the user where to find the result when delivery fails for good', async () => {
        global.fetch = vi.fn().mockRejectedValue(netError());

        await adapter.sendResult(run, []);

        const fallback = bodyOf(sendCalls().at(-1)!);
        expect(fallback.text).toContain('could not be posted');
        expect(fallback.text).toContain('run-1');
        // Plain text: MarkdownV2 escaping must not be able to fail the last resort.
        expect(fallback.parse_mode).toBeUndefined();
    });

    it('posts no fallback notice when the result was delivered', async () => {
        global.fetch = vi.fn().mockResolvedValue(okResponse);

        await adapter.sendResult(run, []);

        expect(sendCalls()).toHaveLength(1);
    });
});

describe('TelegramAdapter dashboard links', () => {
    const run = { runId: 'run-1', tenantId: 'tenant-1', source: 'telegram', trigger: { chatId: 555 } } as any;

    /** Destination of the first MarkdownV2 inline link in the sent text. */
    const linkDestination = () => {
        const body = JSON.parse(vi.mocked(global.fetch).mock.calls[0][1]!.body as string);
        return { text: body.text as string, dest: (body.text as string).match(/\]\((.+?)\)/)?.[1] };
    };

    beforeEach(() => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({
            botToken: 'tg-bot-token', secretToken: 'tg-secret', enabled: true,
        });
        global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) });
    });

    // MarkdownV2 permits escaping only ')' and '\' inside a link destination.
    // Running the URL through the text escaper put \- and \. in it, which left
    // Telegram rendering a dead label instead of a link.
    it('leaves the clarification link destination unescaped', async () => {
        await new TelegramAdapter(0).sendClarification(run, 'Which account?');

        const { dest } = linkDestination();
        expect(dest).not.toContain('\\');
        expect(dest).toMatch(/\/app\/agent-ops\/run-1\/respond$/);
    });

    it('shows the URL itself so the user can see where it goes', async () => {
        await new TelegramAdapter(0).sendClarification(run, 'Which account?');

        const { text } = linkDestination();
        // Visible label, escaped as ordinary text.
        expect(text).toContain('[http');
        expect(text).toContain('agent\\-ops');
        expect(text).toContain('Reply here to continue');
    });

    it('leaves the scheduled-digest link destination unescaped too', async () => {
        const task = {
            taskId: 'task-1', tenantId: 'tenant-1', name: 'Daily Cost Review',
            notification: { type: 'telegram', chatId: '-1001234567890' },
        } as unknown as ScheduledTask;
        const digestRun = {
            runId: 'run-1', tenantId: 'tenant-1', source: 'scheduled', status: 'completed',
            durationMs: 42000, result: { summary: 'No anomalies found', toolsUsed: [] },
        } as unknown as AgentOpsRun;

        await new TelegramAdapter(0).sendScheduledNotification(task, digestRun, 'result');

        const { dest } = linkDestination();
        expect(dest).not.toContain('\\');
        expect(dest).toMatch(/\/app\/agent-ops\/run-1$/);
    });
});

describe('validateRequest — secret resolution edge cases', () => {
    let adapter: TelegramAdapter;
    beforeEach(() => { adapter = new TelegramAdapter(0); });

    const makeReq = (secretHeader: string, body = { message: { text: '/x', chat: { id: 1 } } }) =>
        new Request('http://localhost/api/v1/gateway/telegram', {
            method: 'POST',
            headers: { 'x-telegram-bot-api-secret-token': secretHeader, 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });

    it('returns false when the signing-config lookup throws and no env fallback exists', async () => {
        vi.mocked(TenantConfigService.getConfig).mockRejectedValueOnce(new Error('db down'));
        expect(await adapter.validateRequest(makeReq('tg-secret') as any)).toBe(false);
    });

    it('returns false when no secret is configured anywhere', async () => {
        // .mockReturnValueOnce — self-resetting, so it can't leak into later tests
        // the way a persistent .mockReturnValue would (bit us once already: it left
        // findTenantIdBySecretToken resolving null for every test declared after this one).
        vi.mocked(getTelegramBotLinkRepository).mockReturnValueOnce({
            findTenantIdBySecretToken: vi.fn().mockResolvedValue(null),
            upsertLink: vi.fn().mockResolvedValue(undefined),
            getLinkForTenant: vi.fn().mockResolvedValue(null),
            deleteLinkForTenant: vi.fn().mockResolvedValue(0),
        } as any);
        // tenantId resolves to null here, so validateRequest's `if (tenantId)` branch is
        // skipped entirely — TenantConfigService.getConfig is never reached, so it must
        // NOT be stubbed with a *Once value here (an unconsumed Once leaks into whichever
        // later test calls getConfig next).
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        expect(await adapter.validateRequest(makeReq('anything') as any)).toBe(false);
        expect(errSpy).toHaveBeenCalledWith('[TelegramAdapter] Secret token not configured');
    });

    it('rejects the request when the resolved tenant config has enabled: false, even with a matching secret', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValueOnce({ secretToken: 'tg-secret', enabled: false } as any);
        expect(await adapter.validateRequest(makeReq('tg-secret') as any)).toBe(false);
    });
});

describe('parseInbound — unsupported update type', () => {
    it('returns an empty task description for an update with neither a message nor a callback_query', async () => {
        const adapter = new TelegramAdapter(0);
        const req = new Request('http://localhost/api/v1/gateway/telegram', {
            method: 'POST',
            headers: { 'x-telegram-bot-api-secret-token': 'tg-secret', 'content-type': 'application/json' },
            body: JSON.stringify({ edited_message: { text: 'edited' } }),
        });
        const msg = await adapter.parseInbound(req as any);
        expect(msg.taskDescription).toBe('');
        expect(msg.tenantId).toBe('tenant-1');
        expect(msg.channelMeta).toEqual({});
    });
});

describe('sendError / sendApprovalRequest / getConfig / sendSessionReset', () => {
    let adapter: TelegramAdapter;
    const run = {
        runId: 'run-1', tenantId: 'tenant-1', source: 'telegram', taskDescription: 'Stop the idle instance',
        trigger: { chatId: 555, userId: 1 },
    } as any;

    beforeEach(() => {
        adapter = new TelegramAdapter(0);
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ botToken: 'tg-bot-token', secretToken: 'tg-secret', enabled: true } as any);
        global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) });
    });

    it('sendError posts the escaped, truncated error and clears the ack tracking', async () => {
        await adapter.sendError(run, 'Access denied: cannot stop i-123');

        const [, init] = vi.mocked(global.fetch).mock.calls[0];
        const body = JSON.parse(init!.body as string);
        expect(body.text).toContain('Agent Ops Failed');
        expect(body.text).toContain('Access denied');
    });

    it('truncates a long error at the nearest newline before the raw-text cap', async () => {
        const longError = `${'A'.repeat(3400)}\n${'B'.repeat(200)}`;
        await adapter.sendError(run, longError);

        const body = JSON.parse(vi.mocked(global.fetch).mock.calls[0][1]!.body as string);
        expect(body.text).toContain('…');
        expect(body.text).not.toContain('B'.repeat(200));
    });

    it('truncates a long, unbroken error (no newline or space) at the hard raw-text cap', async () => {
        const longError = 'A'.repeat(4000);
        await adapter.sendError(run, longError);

        const body = JSON.parse(vi.mocked(global.fetch).mock.calls[0][1]!.body as string);
        expect(body.text).toContain('…');
        expect(body.text.length).toBeLessThan(4000);
    });

    it('sendApprovalRequest posts the plan, pending tools, and an approve/reject inline keyboard', async () => {
        await adapter.sendApprovalRequest(run, ['Stop the instance'], ['stop_instance']);

        const [, init] = vi.mocked(global.fetch).mock.calls[0];
        const body = JSON.parse(init!.body as string);
        expect(body.text).toContain('Approval Required');
        expect(body.text).toContain('stop\\_instance');
        expect(body.reply_markup.inline_keyboard[0]).toHaveLength(2);
        expect(body.reply_markup.inline_keyboard[0][0].callback_data).toBe('approve:run-1:tenant-1');
        expect(body.reply_markup.inline_keyboard[0][1].callback_data).toBe('reject:run-1:tenant-1');
    });

    it('getConfig returns the raw tenant config', async () => {
        const config = await adapter.getConfig!('tenant-1');
        expect(config).toMatchObject({ botToken: 'tg-bot-token' });
    });

    it('getConfig defaults to {} when the lookup fails', async () => {
        vi.mocked(TenantConfigService.getConfig).mockRejectedValueOnce(new Error('db down'));
        expect(await adapter.getConfig!('tenant-1')).toEqual({});
    });

    it('sendSessionReset posts a confirmation message', async () => {
        await adapter.sendSessionReset('tenant-1', 555);

        expect(global.fetch).toHaveBeenCalledTimes(1);
        const [, init] = vi.mocked(global.fetch).mock.calls[0];
        const body = JSON.parse(init!.body as string);
        expect(body.chat_id).toBe(555);
        expect(body.text).toContain('New conversation started');
    });

    it('sendSessionReset does nothing when no bot token is configured', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValueOnce({ botToken: '', enabled: true } as any);
        await adapter.sendSessionReset('tenant-1', 555);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('sendSessionReset catches and logs a network failure', async () => {
        global.fetch = vi.fn().mockRejectedValue(new Error('network down'));
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        await adapter.sendSessionReset('tenant-1', 555);

        expect(errSpy).toHaveBeenCalledWith('[TelegramAdapter] sendSessionReset error:', expect.any(Error));
    });
});

describe('sendMessage / editMessage — missing bot token branches', () => {
    let adapter: TelegramAdapter;
    const run = {
        runId: 'run-1', tenantId: 'tenant-1', source: 'telegram', taskDescription: 'x',
        trigger: { chatId: 555, userId: 1 },
    } as any;

    beforeEach(() => {
        adapter = new TelegramAdapter(0);
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ botToken: '', enabled: true } as any);
        global.fetch = vi.fn();
    });

    it('sendResult (best-effort) warns and skips the call when no bot token is configured', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await adapter.sendResult(run, []);
        expect(global.fetch).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith('[TelegramAdapter] Bot token not configured');
    });

    it('sendScheduledNotification (strict) throws when no bot token is configured', async () => {
        const task = {
            taskId: 'task-1', tenantId: 'tenant-1', name: 'x',
            notification: { type: 'telegram', chatId: '555' },
        } as unknown as ScheduledTask;
        await expect(adapter.sendScheduledNotification!(task, run, 'result')).rejects.toThrow(
            'No Telegram Bot Token configured — set it under Channels → Telegram'
        );
    });

    it('editMessage (via sendStreamChunk) warns and returns without calling the API when no bot token is configured', async () => {
        (adapter as any).ackMessageIds.set('run-1', 42);
        (adapter as any).narration = new NarrationSessions(0);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await adapter.sendStreamChunk!(run, { eventType: 'tool_call', node: 'agent', toolName: 'execute_command' } as any);

        expect(global.fetch).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith('[TelegramAdapter] Bot token not configured');
    });

    it('editMessage truncates escaped text over the 4096-char edit limit before sending', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ botToken: 'tg-bot-token', enabled: true } as any);
        global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
        (adapter as any).ackMessageIds.set('run-1', 42);
        const longText = 'x'.repeat(5000);
        const ok = await (adapter as any).editMessage(run, 555, 42, longText);

        expect(ok).toBe(true);
        const body = JSON.parse(vi.mocked(global.fetch).mock.calls[0][1]!.body as string);
        expect(body.text.length).toBeLessThan(5000);
        expect(body.text).toContain('…');
    });

    it('editMessage logs an error once retries are exhausted', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ botToken: 'tg-bot-token', enabled: true } as any);
        global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'chat not found' });
        (adapter as any).ackMessageIds.set('run-1', 42);
        (adapter as any).narration = new NarrationSessions(0);
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        await adapter.sendStreamChunk!(run, { eventType: 'tool_call', node: 'agent', toolName: 'execute_command' } as any);

        expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('editMessageText gave up'));
    });
});
