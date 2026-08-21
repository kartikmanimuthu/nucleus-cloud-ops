# ChatBotPersona Router + Real-Time Narration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persona/router step in front of Agent Ops run creation so small talk gets an instant reply without starting a background run, and narrate real Agent Ops runs as a plain-English checklist instead of raw event text.

**Architecture:** Three layers, built bottom-up. (1) `agent-executor.ts` starts emitting `run:event` on the gateway event bus at step boundaries — narration's missing foundation. (2) A new branch inside `GatewayService.handleInbound`, after the existing `replyContext` resume check and before `agentOpsService.createRun()`, reusing `triageChatMessage()` unchanged. (3) A pure template-map translator + keyed checklist renderer, wired into Telegram's and Slack's `sendStreamChunk`.

**Tech Stack:** TypeScript, Next.js App Router API routes, LangChain (`@langchain/core/messages`), Vitest.

## Global Constraints

- Every query/service call must go through existing repository/service patterns — no direct Prisma calls introduced by this plan.
- No new AWS Lambda, no DynamoDB — Postgres + in-process state only (new per-run state is in-memory `Map`s, same lifetime pattern as the existing `ackMessageIds` map).
- Classifier and model-resolution failures must fail open to the normal task path — never silently drop a user's message.
- **Direct replies are Telegram-only.** Slack slash commands and Discord interactions enforce a hard 3-second response window; the direct-reply path makes two sequential LLM calls. Do NOT implement `sendDirectReply` on any other adapter — the interface method is optional, and its absence makes the router safely fall through to today's behavior.
- **Known-red baseline:** `bunx vitest run tests/gateway` fails **5 pre-existing tests** before any of this work starts — `slack-adapter.test.ts` (3: "no-ops without a channelId", "no-ops without a botToken", "never throws when fetch rejects"), `telegram-adapter.test.ts` (1: "no-ops without a chatId"), `api-adapter.test.ts` (1: "parseInbound extracts task description and options"). These are unrelated to this work. Every "Expected: PASS" below means *the tests named in that step* pass — do not chase the baseline failures, and never treat a fully-green `tests/gateway` run as the bar.

---

## File Structure

**New files:**
- `lib/agent-ops/record-and-emit.ts` — `isStepBoundary()`, `recordAndEmit()`
- `lib/gateway/persona/persona-config.ts` — `chatbotPersonaEnabled(channelType)`
- `lib/gateway/persona/direct-reply.ts` — `generateDirectReply()`
- `lib/gateway/narration/translate-event.ts` — `translateEventTemplate()`, `translateEventWithFallback()`
- `lib/gateway/narration/checklist.ts` — pure checklist state/render
- `lib/gateway/narration/narration-session.ts` — `NarrationSessions`: per-run checklist, model cache, finished guard, send throttle (shared by all three narrating adapters, so Tasks 9-11 are transport only)
- Matching `*.test.ts` colocated with each of the above

**Modified files:**
- `lib/agent-ops/agent-executor.ts` — thread `eventBus` into `processLangGraphEvent`, emit `run:event`
- `lib/gateway/types.ts` — add optional `sendDirectReply` to `ChannelAdapter`
- `lib/gateway/gateway-service.ts` — wire the persona router branch
- `lib/gateway/notification-router.ts` — loosen the `sendStreamChunk` dispatch gate
- `lib/gateway/adapters/telegram-adapter.ts` — `sendDirectReply` + checklist narration
- `lib/gateway/adapters/slack-adapter.ts` — checklist narration only (no `sendDirectReply`)
- `lib/gateway/adapters/discord-adapter.ts` — checklist narration only (no `sendDirectReply`)
- `lib/agent/prompt-templates.ts` — gains `buildDirectSystemPrompt`
- `app/api/chat/direct-chat.ts` — imports `buildDirectSystemPrompt` instead of defining it
- Matching test files under `tests/gateway/`

---

## Task 1: Emit `run:event` at step boundaries

Narration's foundation does not exist today: `processLangGraphEvent` writes events to Postgres via `agentOpsService.recordEvent` but never emits to the `GatewayEventBus`. `notification-router.ts:21` is `run:event`'s only consumer, so `sendStreamChunk` has never run in production. Without this task, Tasks 6-9 are dead code.

**Files:**
- Create: `apps/web-ui/lib/agent-ops/record-and-emit.ts`
- Test: `apps/web-ui/lib/agent-ops/record-and-emit.test.ts`
- Modify: `apps/web-ui/lib/agent-ops/agent-executor.ts`

**Interfaces:**
- Consumes: `agentOpsService.recordEvent(params): Promise<void>` (`lib/agent-ops/agent-ops-service.ts:152`); `GatewayEventBus.emit(event: GatewayEvent): void` (`lib/gateway/event-bus.ts:12`).
- Produces: `isStepBoundary(eventType: AgentEventType): boolean` and `recordAndEmit(eventBus: GatewayEventBus | undefined, params: RecordEventParams): Promise<void>` — Task 8/9's narration depends on this emitting.

- [ ] **Step 1: Write the failing test**

Create `lib/agent-ops/record-and-emit.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/agent-ops/agent-ops-service', () => ({
    agentOpsService: { recordEvent: vi.fn().mockResolvedValue(undefined) },
}));

import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { isStepBoundary, recordAndEmit } from './record-and-emit';

const params = { runId: 'run-1', tenantId: 'tenant-1', eventType: 'tool_call' as const, node: 'agent', toolName: 'execute_command' };

describe('isStepBoundary', () => {
    it('accepts the four narratable event types', () => {
        expect(isStepBoundary('planning')).toBe(true);
        expect(isStepBoundary('tool_call')).toBe(true);
        expect(isStepBoundary('tool_result')).toBe(true);
        expect(isStepBoundary('reflection')).toBe(true);
    });

    it('rejects non-boundary event types', () => {
        expect(isStepBoundary('memory_save')).toBe(false);
        expect(isStepBoundary('evaluation')).toBe(false);
        expect(isStepBoundary('execution')).toBe(false);
    });
});

describe('recordAndEmit', () => {
    beforeEach(() => vi.clearAllMocks());

    it('always records, and emits run:event for a step boundary', async () => {
        const emit = vi.fn();
        await recordAndEmit({ emit } as any, params);

        expect(agentOpsService.recordEvent).toHaveBeenCalledWith(params);
        expect(emit).toHaveBeenCalledTimes(1);
        const emitted = emit.mock.calls[0][0];
        expect(emitted.type).toBe('run:event');
        expect(emitted.runId).toBe('run-1');
        expect(emitted.tenantId).toBe('tenant-1');
        expect(emitted.data.event.eventType).toBe('tool_call');
        expect(emitted.data.event.toolName).toBe('execute_command');
    });

    it('records but does not emit for a non-boundary event', async () => {
        const emit = vi.fn();
        await recordAndEmit({ emit } as any, { ...params, eventType: 'memory_save' });

        expect(agentOpsService.recordEvent).toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
    });

    it('records normally when no event bus is supplied', async () => {
        await recordAndEmit(undefined, params);
        expect(agentOpsService.recordEvent).toHaveBeenCalledWith(params);
    });

    it('never lets an emit failure escape', async () => {
        const emit = vi.fn(() => { throw new Error('bus exploded'); });
        await expect(recordAndEmit({ emit } as any, params)).resolves.toBeUndefined();
        expect(agentOpsService.recordEvent).toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/agent-ops/record-and-emit.test.ts`
Expected: FAIL — cannot find module `./record-and-emit`

- [ ] **Step 3: Create `record-and-emit.ts`**

Create `lib/agent-ops/record-and-emit.ts`:

```ts
// web-ui/lib/agent-ops/record-and-emit.ts
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import type { GatewayEventBus } from '@/lib/gateway/event-bus';
import type { AgentEventType, AgentOpsEvent } from './types';

export interface RecordEventParams {
    runId: string;
    tenantId: string;
    eventType: AgentEventType;
    node: string;
    content?: string;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    toolOutput?: string;
    metadata?: Record<string, unknown>;
}

/**
 * Event types worth narrating to a channel. Everything else (memory, evaluation,
 * raw execution text) is internal chatter that would only add noise to a chat
 * checklist — it still gets persisted, just not broadcast.
 */
const STEP_BOUNDARY_EVENT_TYPES = new Set<AgentEventType>([
    'planning',
    'tool_call',
    'tool_result',
    'reflection',
]);

export function isStepBoundary(eventType: AgentEventType): boolean {
    return STEP_BOUNDARY_EVENT_TYPES.has(eventType);
}

/**
 * Persist an agent-ops event and, for step boundaries, broadcast it on the
 * gateway bus so channel adapters can narrate progress live.
 *
 * The emitted AgentOpsEvent is synthesized from the same params rather than
 * re-read from Postgres: recordEvent returns void, and bus consumers only read
 * the semantic fields (eventType / node / toolName / content).
 */
export async function recordAndEmit(
    eventBus: GatewayEventBus | undefined,
    params: RecordEventParams,
): Promise<void> {
    await agentOpsService.recordEvent(params);
    if (!eventBus || !isStepBoundary(params.eventType)) return;

    try {
        eventBus.emit({
            type: 'run:event',
            runId: params.runId,
            tenantId: params.tenantId,
            timestamp: new Date(),
            data: {
                event: {
                    ...params,
                    PK: `RUN#${params.runId}`,
                    SK: '',
                    createdAt: new Date().toISOString(),
                    ttl: 0,
                } as AgentOpsEvent,
            },
        });
    } catch (err) {
        // Narration is best-effort — never let it disturb a run.
        console.error('[recordAndEmit] Failed to emit run:event (non-fatal):', err);
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run lib/agent-ops/record-and-emit.test.ts`
Expected: PASS

- [ ] **Step 5: Thread `eventBus` through `processLangGraphEvent`**

In `lib/agent-ops/agent-executor.ts`, add the import next to the other local imports:

```ts
import { recordAndEmit } from './record-and-emit';
```

Change the `processLangGraphEvent` signature at line 405 from:

```ts
async function processLangGraphEvent(
    runId: string,
    tenantId: string,
    event: any,
    toolsUsed: Set<string>
): Promise<EventProcessingResult> {
```

to:

```ts
async function processLangGraphEvent(
    runId: string,
    tenantId: string,
    event: any,
    toolsUsed: Set<string>,
    eventBus?: GatewayEventBus
): Promise<EventProcessingResult> {
```

Inside `processLangGraphEvent` **only**, replace every `await agentOpsService.recordEvent({` with `await recordAndEmit(eventBus, {`. There are **seven** such calls, at approximately lines 424, 432, 446, 453, 484, 523, and 545 — the reflection, planning, memory, evaluation, tool_call, model-text, and tool_result recorders respectively. `recordAndEmit` filters internally, so a uniform swap is correct and no per-call judgment is needed. Do **not** touch `recordEvent` calls elsewhere in the file — only those inside this function (the function spans lines 405-566).

Update both call sites to pass the bus. At line 197:

```ts
                const processed = await processLangGraphEvent(runId, tenantId, event, toolsUsed, eventBus);
```

At line 675 (inside `resumeApprovedRun`):

```ts
                const processed = await processLangGraphEvent(runId, tenantId, event, toolsUsed, eventBus);
```

`eventBus` is already a parameter of both `executeAgentRun` (line 83) and `resumeApprovedRun` (line 576), so it is in scope at both sites — no other plumbing needed.

- [ ] **Step 6: Verify the executor still type-checks**

Run: `cd apps/web-ui && bunx tsc --noEmit`
Expected: no new errors mentioning `agent-executor.ts` or `record-and-emit.ts`

- [ ] **Step 7: Commit**

```bash
git add apps/web-ui/lib/agent-ops/record-and-emit.ts apps/web-ui/lib/agent-ops/record-and-emit.test.ts apps/web-ui/lib/agent-ops/agent-executor.ts
git commit -m "feat(agent-ops): emit run:event on the gateway bus at step boundaries"
```

---

## Task 2: `sendDirectReply` on `ChannelAdapter` + Telegram

Telegram only — see the Global Constraints note on the 3-second Slack/Discord interaction window.

**Files:**
- Modify: `apps/web-ui/lib/gateway/types.ts`
- Modify: `apps/web-ui/lib/gateway/adapters/telegram-adapter.ts`
- Test: `apps/web-ui/tests/gateway/adapters/telegram-adapter.test.ts`

**Interfaces:**
- Produces: `ChannelAdapter.sendDirectReply?(req: NextRequest, text: string): Promise<Response>` — Task 5 checks for this exact optional method.

- [ ] **Step 1: Write the failing tests**

Add to `tests/gateway/adapters/telegram-adapter.test.ts`, inside the existing `describe('TelegramAdapter', ...)` block (the file's `TenantConfigService` and `getTelegramBotLinkRepository` mocks are already set up in its `beforeEach`):

```ts
describe('sendDirectReply', () => {
    it('posts the reply text via the bot API and acks the webhook', async () => {
        global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
        const req = new Request('http://localhost/api/v1/gateway/telegram', {
            method: 'POST',
            headers: { 'x-telegram-bot-api-secret-token': 'tg-secret', 'content-type': 'application/json' },
            body: JSON.stringify({ message: { text: 'hi', chat: { id: 555 } } }),
        });

        const res = await adapter.sendDirectReply!(req as any, 'Hey! What can I help with?');

        expect(res.status).toBe(200);
        expect(global.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = vi.mocked(global.fetch).mock.calls[0];
        expect(url).toContain('/sendMessage');
        const body = JSON.parse(init!.body as string);
        expect(body.chat_id).toBe(555);
        expect(body.text).toContain('Hey\\!');
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

        expect(res.status).toBe(200);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('acks without throwing when the chat id cannot be resolved', async () => {
        global.fetch = vi.fn();
        const req = new Request('http://localhost/api/v1/gateway/telegram', {
            method: 'POST',
            headers: { 'x-telegram-bot-api-secret-token': 'tg-secret', 'content-type': 'application/json' },
            body: 'not json',
        });

        const res = await adapter.sendDirectReply!(req as any, 'hi');

        expect(res.status).toBe(200);
        expect(global.fetch).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web-ui && bunx vitest run tests/gateway/adapters/telegram-adapter.test.ts -t "sendDirectReply"`
Expected: FAIL — `adapter.sendDirectReply is not a function`

- [ ] **Step 3: Add the interface method**

In `lib/gateway/types.ts`, add to the `ChannelAdapter` interface, immediately after `sendStreamChunk?`:

```ts
    /**
     * Send a one-shot conversational reply (small talk / capability question)
     * without creating an Agent Ops run.
     *
     * Optional, and deliberately unimplemented on Slack / Discord / Jira /
     * webhook / API: generating the reply costs two sequential LLM calls, which
     * blows Slack's and Discord's 3-second interaction deadline, and Jira's
     * webhook caller discards response bodies entirely. Absent implementation
     * means the persona router falls through to the normal task path.
     */
    sendDirectReply?(req: NextRequest, text: string): Promise<Response>;
```

- [ ] **Step 4: Implement in `TelegramAdapter`**

In `lib/gateway/adapters/telegram-adapter.ts`, add a constant next to `CONVERSATION_IDLE_MS`:

```ts
/** Raw reply cap. MarkdownV2 escaping can nearly double length; 1500 raw keeps
 *  the escaped result comfortably under Telegram's 4096-char message limit. */
const DIRECT_REPLY_MAX_CHARS = 1500;
```

Add this method next to `sendAck` (reuses the file's existing `readBody`, `resolveTenantId`, `loadConfig`, `escapeMarkdownV2`):

```ts
async sendDirectReply(req: NextRequest, text: string): Promise<Response> {
    const ack = new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });

    const trimmed = text.trim();
    if (!trimmed) return ack;

    const body = await readBody(req);
    let chatId: number | undefined;
    try {
        chatId = JSON.parse(body).message?.chat?.id;
    } catch { /* ignore */ }
    if (!chatId) return ack;

    try {
        const secretHeader = req.headers.get('x-telegram-bot-api-secret-token') || '';
        const tenantId = (await resolveTenantId(req, secretHeader)) || String(chatId);
        const config = await this.loadConfig(tenantId);
        const botToken = config?.botToken || env.TELEGRAM_BOT_TOKEN || '';
        if (botToken) {
            await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: escapeMarkdownV2(trimmed.slice(0, DIRECT_REPLY_MAX_CHARS)),
                    parse_mode: 'MarkdownV2',
                }),
            });
        }
    } catch (err) {
        console.error('[TelegramAdapter] sendDirectReply error:', err);
    }

    return ack;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/web-ui && bunx vitest run tests/gateway/adapters/telegram-adapter.test.ts -t "sendDirectReply"`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add apps/web-ui/lib/gateway/types.ts apps/web-ui/lib/gateway/adapters/telegram-adapter.ts apps/web-ui/tests/gateway/adapters/telegram-adapter.test.ts
git commit -m "feat(gateway): add optional sendDirectReply to ChannelAdapter, implement for Telegram"
```

---

## Task 3: Direct-reply text generator

**Files:**
- Modify: `apps/web-ui/lib/agent/prompt-templates.ts`
- Modify: `apps/web-ui/app/api/chat/direct-chat.ts`
- Create: `apps/web-ui/lib/gateway/persona/direct-reply.ts`
- Test: `apps/web-ui/lib/gateway/persona/direct-reply.test.ts`

**Interfaces:**
- Consumes: `createAgentModels(config: ResolvedModelConfig): AgentModels` (`lib/agent/model-factory.ts:81`, returns `{main, reflector}`); `contentToText(content: unknown): string` and `ResolvedModelConfig` from `lib/agent/agent-shared.ts`.
- Produces: `buildDirectSystemPrompt(): string` (in `prompt-templates.ts`) and `generateDirectReply(params: { message: string; model: ResolvedModelConfig }): Promise<string>` — Task 5 calls the latter.

- [ ] **Step 1: Write the failing test**

Create `lib/gateway/persona/direct-reply.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/agent/model-factory', () => ({ createAgentModels: vi.fn() }));

import { createAgentModels } from '@/lib/agent/model-factory';
import { generateDirectReply } from './direct-reply';

describe('generateDirectReply', () => {
    beforeEach(() => vi.clearAllMocks());

    it('invokes the main model with the direct system prompt and returns the text', async () => {
        const invoke = vi.fn().mockResolvedValue({ content: 'Hey! What can I help with?' });
        vi.mocked(createAgentModels).mockReturnValue({ main: { invoke } as any, reflector: {} as any });

        const result = await generateDirectReply({ message: 'hi', model: {} as any });

        expect(result).toBe('Hey! What can I help with?');
        const [messages] = invoke.mock.calls[0];
        expect(messages[0]._getType()).toBe('system');
        expect(messages[1]._getType()).toBe('human');
        expect(messages[1].content).toBe('hi');
    });

    it('truncates very long input to 4000 characters before invoking the model', async () => {
        const invoke = vi.fn().mockResolvedValue({ content: 'ok' });
        vi.mocked(createAgentModels).mockReturnValue({ main: { invoke } as any, reflector: {} as any });

        await generateDirectReply({ message: 'x'.repeat(5000), model: {} as any });

        const [messages] = invoke.mock.calls[0];
        expect(messages[1].content.length).toBe(4000);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/gateway/persona/direct-reply.test.ts`
Expected: FAIL — cannot find module `./direct-reply`

- [ ] **Step 3: Move `buildDirectSystemPrompt` into `prompt-templates.ts`**

In `lib/agent/prompt-templates.ts`, add (matching the file's existing `buildBaseIdentity` / `buildAwsCliStandards` string-returning style):

```ts
export function buildDirectSystemPrompt(): string {
    return `${buildBaseIdentity()}

## Conversational Reply Mode

The user's message is conversational — a greeting, thanks, a question about your capabilities, or something answerable from the conversation itself. Reply naturally and briefly. No tools are available in this mode, and none are needed.

- Be warm and direct; a greeting gets a short greeting back, not a paragraph.
- If asked what you can do: you operate AWS across the tenant's connected accounts — inventory and health checks, incident triage, cost analysis and right-sizing, resource scheduling, log/metric investigation, and recurring scheduled tasks. Invite the user to describe a task in plain language.
- If the message references earlier findings in this conversation, answer from that visible history only — never invent data, resource IDs, or metrics.
- If the request actually needs live data or an action, say you're ready to run it as a task and ask them to confirm or elaborate — do not fabricate results.`;
}
```

In `app/api/chat/direct-chat.ts`:
1. Delete the local `buildDirectSystemPrompt` function (lines 46-57) entirely.
2. Remove the now-unused `buildBaseIdentity` import (line 5) and replace it with:

```ts
import { buildDirectSystemPrompt } from '@/lib/agent/prompt-templates';
```

3. Change the call site at line 75 from:

```ts
const lcInput = [buildDirectSystemPrompt(), ...history];
```

to:

```ts
const lcInput = [new SystemMessage(buildDirectSystemPrompt()), ...history];
```

The moved function returns a plain string like every other `prompt-templates.ts` builder, so the `SystemMessage` wrap now happens at the call site. `SystemMessage` is already imported in `direct-chat.ts` (line 1).

- [ ] **Step 4: Create `direct-reply.ts`**

Create `lib/gateway/persona/direct-reply.ts`:

```ts
// web-ui/lib/gateway/persona/direct-reply.ts
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { createAgentModels } from '@/lib/agent/model-factory';
import { buildDirectSystemPrompt } from '@/lib/agent/prompt-templates';
import { contentToText, type ResolvedModelConfig } from '@/lib/agent/agent-shared';

/**
 * One-shot conversational reply for gateway channels: no tools, no memory
 * recall, no graph — a single plain model call. Mirrors the web chat's
 * direct-chat responder, minus the AI SDK streaming wrapper channels can't use.
 *
 * No conversation history is passed, and none is needed: on the gateway path a
 * message arriving during an active conversation is already routed to
 * handleResume by parseInbound, so anything reaching here is a fresh turn.
 */
export async function generateDirectReply(params: {
    message: string;
    model: ResolvedModelConfig;
}): Promise<string> {
    const { main } = createAgentModels(params.model);
    const resp = await main.invoke([
        new SystemMessage(buildDirectSystemPrompt()),
        new HumanMessage(params.message.slice(0, 4000)),
    ]);
    return contentToText(resp.content);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run lib/gateway/persona/direct-reply.test.ts`
Expected: PASS

- [ ] **Step 6: Verify the direct-chat refactor type-checks**

Run: `cd apps/web-ui && bunx tsc --noEmit`
Expected: no new errors mentioning `direct-chat.ts` or `prompt-templates.ts`
(Note: there is no unit test covering `respondDirect`, so `tsc` is the real check here.)

- [ ] **Step 7: Commit**

```bash
git add apps/web-ui/lib/agent/prompt-templates.ts apps/web-ui/app/api/chat/direct-chat.ts apps/web-ui/lib/gateway/persona/direct-reply.ts apps/web-ui/lib/gateway/persona/direct-reply.test.ts
git commit -m "feat(gateway): extract buildDirectSystemPrompt, add generateDirectReply for channel small talk"
```

---

## Task 4: Persona rollout feature flag

**Files:**
- Create: `apps/web-ui/lib/gateway/persona/persona-config.ts`
- Test: `apps/web-ui/lib/gateway/persona/persona-config.test.ts`

**Interfaces:**
- Produces: `chatbotPersonaEnabled(channelType: ChannelType): boolean` — Task 5 calls this.

- [ ] **Step 1: Write the failing test**

Create `lib/gateway/persona/persona-config.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { chatbotPersonaEnabled } from './persona-config';

afterEach(() => {
    delete process.env.CHATBOT_PERSONA_ENABLED;
    delete process.env.CHATBOT_PERSONA_CHANNELS;
});

describe('chatbotPersonaEnabled', () => {
    it('defaults to disabled for every channel (opt-in rollout)', () => {
        expect(chatbotPersonaEnabled('telegram')).toBe(false);
        expect(chatbotPersonaEnabled('slack')).toBe(false);
    });

    it('defaults to Telegram only when the global flag is on with no allowlist', () => {
        process.env.CHATBOT_PERSONA_ENABLED = 'true';
        expect(chatbotPersonaEnabled('telegram')).toBe(true);
        expect(chatbotPersonaEnabled('slack')).toBe(false);
        expect(chatbotPersonaEnabled('discord')).toBe(false);
        expect(chatbotPersonaEnabled('jira')).toBe(false);
    });

    it('honours an explicit allowlist', () => {
        process.env.CHATBOT_PERSONA_ENABLED = 'true';
        process.env.CHATBOT_PERSONA_CHANNELS = 'telegram,discord';
        expect(chatbotPersonaEnabled('telegram')).toBe(true);
        expect(chatbotPersonaEnabled('discord')).toBe(true);
        expect(chatbotPersonaEnabled('slack')).toBe(false);
    });

    it('stays disabled when the global flag is explicitly false, even with an allowlist', () => {
        process.env.CHATBOT_PERSONA_ENABLED = 'false';
        process.env.CHATBOT_PERSONA_CHANNELS = 'telegram';
        expect(chatbotPersonaEnabled('telegram')).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/gateway/persona/persona-config.test.ts`
Expected: FAIL — cannot find module `./persona-config`

- [ ] **Step 3: Implement**

Create `lib/gateway/persona/persona-config.ts`:

```ts
// web-ui/lib/gateway/persona/persona-config.ts
import type { ChannelType } from '@/lib/gateway/types';

/**
 * Only Telegram is safe by default: the direct-reply path makes two sequential
 * LLM calls before responding, and Slack slash commands / Discord interactions
 * both hard-fail at 3 seconds. Telegram's webhook has no such deadline.
 * CHATBOT_PERSONA_CHANNELS can widen this once an ack-then-deliver design lands.
 */
const DEFAULT_CHANNELS: ChannelType[] = ['telegram'];

/**
 * Default OFF (opt-in), unlike CHAT_TRIAGE_ENABLED's default-on kill-switch —
 * this is new and untested on live channels, so it dark-launches per channel.
 */
export function chatbotPersonaEnabled(channelType: ChannelType): boolean {
    const globalFlag = process.env.CHATBOT_PERSONA_ENABLED?.toLowerCase();
    if (globalFlag !== 'true' && globalFlag !== '1') return false;

    const configured = process.env.CHATBOT_PERSONA_CHANNELS
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const allowlist = configured?.length ? configured : DEFAULT_CHANNELS;
    return allowlist.includes(channelType);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run lib/gateway/persona/persona-config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/gateway/persona/persona-config.ts apps/web-ui/lib/gateway/persona/persona-config.test.ts
git commit -m "feat(gateway): add CHATBOT_PERSONA_ENABLED rollout flag (Telegram by default)"
```

---

## Task 5: Wire the persona router into `GatewayService.handleInbound`

**Files:**
- Modify: `apps/web-ui/lib/gateway/gateway-service.ts`
- Test: `apps/web-ui/tests/gateway/gateway-service.test.ts`

**Interfaces:**
- Consumes: `triageChatMessage({tenantId, message, model, skillAlreadySelected?}): Promise<TriageResult>` and `chatTriageEnabled(): boolean` (`lib/agent/triage.ts:26,60`); `resolveModelConfig(modelString, tenantId)` / `resolveDefaultModelConfig(tenantId)` (`lib/agent/model-resolver.ts:87,126`); `generateDirectReply` (Task 3); `chatbotPersonaEnabled` (Task 4); `ChannelAdapter.sendDirectReply?` (Task 2).

- [ ] **Step 1: Write the failing tests**

In `tests/gateway/gateway-service.test.ts`, add three `vi.mock` calls alongside the file's existing ones:

```ts
vi.mock('@/lib/agent/triage', () => ({
    triageChatMessage: vi.fn(),
    chatTriageEnabled: vi.fn().mockReturnValue(true),
}));
vi.mock('@/lib/agent/model-resolver', () => ({
    resolveModelConfig: vi.fn().mockResolvedValue({ provider: 'bedrock', modelId: 'test-model' }),
    resolveDefaultModelConfig: vi.fn().mockResolvedValue({ provider: 'bedrock', modelId: 'test-model' }),
}));
vi.mock('@/lib/gateway/persona/direct-reply', () => ({ generateDirectReply: vi.fn() }));
```

Change `function makeMockAdapter(): ChannelAdapter` to accept overrides (matching the pattern already in `notification-router.test.ts:15`) — keep every existing property, adding only the parameter and spread:

```ts
function makeMockAdapter(overrides: Partial<ChannelAdapter> = {}): ChannelAdapter {
    return {
        channelType: 'slack',
        deliveryMode: 'callback',
        hilCapabilities: { clarification: true, approvalButtons: true, threadedReplies: true },
        validateRequest: vi.fn().mockResolvedValue(true),
        parseInbound: vi.fn().mockResolvedValue({
            channelType: 'slack',
            tenantId: 'tenant-1',
            taskDescription: 'test task',
            channelMeta: { userId: 'U123', channelId: 'C456', responseUrl: 'https://hooks.slack.com/test' },
        }),
        sendAck: vi.fn().mockResolvedValue(new Response(JSON.stringify({ response_type: 'ephemeral', text: 'ok' }), { status: 200 })),
        sendResult: vi.fn().mockResolvedValue(undefined),
        sendError: vi.fn().mockResolvedValue(undefined),
        sendClarification: vi.fn().mockResolvedValue(undefined),
        sendApprovalRequest: vi.fn().mockResolvedValue(undefined),
        sendSessionReset: vi.fn().mockResolvedValue(undefined),
        getConfig: vi.fn().mockResolvedValue({}),
        ...overrides,
    } as any;
}
```

Then add a new top-level `describe` block. Note it registers the mock adapter under `channelType: 'telegram'`, because the flag defaults to Telegram only:

```ts
describe('GatewayService persona routing', () => {
    let service: GatewayService;
    let adapter: ChannelAdapter;
    let bus: GatewayEventBus;

    beforeEach(async () => {
        vi.clearAllMocks();
        process.env.CHATBOT_PERSONA_ENABLED = 'true';

        const { triageChatMessage, chatTriageEnabled } = await import('@/lib/agent/triage');
        const { resolveDefaultModelConfig } = await import('@/lib/agent/model-resolver');
        const { agentOpsService } = await import('@/lib/agent-ops/agent-ops-service');
        // clearAllMocks wipes implementations set at declaration time — restore them.
        vi.mocked(chatTriageEnabled).mockReturnValue(true);
        vi.mocked(resolveDefaultModelConfig).mockResolvedValue({ provider: 'bedrock', modelId: 'test-model' } as any);
        vi.mocked(triageChatMessage).mockResolvedValue({ route: 'task', skillId: null, reasoning: '' });
        vi.mocked(agentOpsService.createRun).mockResolvedValue({
            runId: 'run-1', tenantId: 'tenant-1', source: 'telegram',
            taskDescription: 'test', threadId: 'thread-1', trigger: {},
        } as any);

        bus = new GatewayEventBus();
        const registry = new AdapterRegistry();
        adapter = makeMockAdapter({
            channelType: 'telegram',
            deliveryMode: 'streaming',
            sendDirectReply: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
        });
        registry.register(adapter);
        service = new GatewayService(registry, bus, new NotificationRouter(bus, registry));
    });

    afterEach(() => {
        delete process.env.CHATBOT_PERSONA_ENABLED;
    });

    it('replies directly and never creates a run when triage classifies "direct"', async () => {
        const { triageChatMessage } = await import('@/lib/agent/triage');
        const { generateDirectReply } = await import('@/lib/gateway/persona/direct-reply');
        const { agentOpsService } = await import('@/lib/agent-ops/agent-ops-service');
        vi.mocked(triageChatMessage).mockResolvedValue({ route: 'direct', skillId: null, reasoning: 'greeting' });
        vi.mocked(generateDirectReply).mockResolvedValue('Hey! What can I help with?');

        const req = new Request('http://localhost/api/v1/gateway/telegram', { method: 'POST', body: '{}' });
        const res = await service.handleInbound('telegram', req as any);

        expect(adapter.sendDirectReply).toHaveBeenCalledWith(expect.anything(), 'Hey! What can I help with?');
        expect(agentOpsService.createRun).not.toHaveBeenCalled();
        expect(res.status).toBe(200);
    });

    it('falls through to the normal task path when triage classifies "task"', async () => {
        const { agentOpsService } = await import('@/lib/agent-ops/agent-ops-service');
        const req = new Request('http://localhost/api/v1/gateway/telegram', { method: 'POST', body: '{}' });
        const res = await service.handleInbound('telegram', req as any);

        expect(adapter.sendDirectReply).not.toHaveBeenCalled();
        expect(agentOpsService.createRun).toHaveBeenCalled();
        expect(res.status).toBe(200);
    });

    it('does not classify at all when the persona flag is off', async () => {
        delete process.env.CHATBOT_PERSONA_ENABLED;
        const { triageChatMessage } = await import('@/lib/agent/triage');
        const { agentOpsService } = await import('@/lib/agent-ops/agent-ops-service');

        const req = new Request('http://localhost/api/v1/gateway/telegram', { method: 'POST', body: '{}' });
        await service.handleInbound('telegram', req as any);

        expect(triageChatMessage).not.toHaveBeenCalled();
        expect(agentOpsService.createRun).toHaveBeenCalled();
    });

    it('does not classify when chat triage is globally disabled', async () => {
        const { triageChatMessage, chatTriageEnabled } = await import('@/lib/agent/triage');
        const { agentOpsService } = await import('@/lib/agent-ops/agent-ops-service');
        vi.mocked(chatTriageEnabled).mockReturnValue(false);

        const req = new Request('http://localhost/api/v1/gateway/telegram', { method: 'POST', body: '{}' });
        await service.handleInbound('telegram', req as any);

        expect(triageChatMessage).not.toHaveBeenCalled();
        expect(agentOpsService.createRun).toHaveBeenCalled();
    });

    it('does not classify for a channel outside the allowlist', async () => {
        const { triageChatMessage } = await import('@/lib/agent/triage');
        const { agentOpsService } = await import('@/lib/agent-ops/agent-ops-service');
        const registry = new AdapterRegistry();
        const slackAdapter = makeMockAdapter({
            sendDirectReply: vi.fn().mockResolvedValue(new Response('{}', { status: 200 })),
        });
        registry.register(slackAdapter);
        service = new GatewayService(registry, bus, new NotificationRouter(bus, registry));

        const req = new Request('http://localhost/api/v1/gateway/slack', { method: 'POST', body: 'text=hi' });
        await service.handleInbound('slack', req as any);

        expect(triageChatMessage).not.toHaveBeenCalled();
        expect(agentOpsService.createRun).toHaveBeenCalled();
    });

    it('falls through to the task path when the adapter lacks sendDirectReply', async () => {
        const { triageChatMessage } = await import('@/lib/agent/triage');
        const { agentOpsService } = await import('@/lib/agent-ops/agent-ops-service');
        vi.mocked(triageChatMessage).mockResolvedValue({ route: 'direct', skillId: null, reasoning: 'greeting' });

        const registry = new AdapterRegistry();
        registry.register(makeMockAdapter({ channelType: 'telegram', deliveryMode: 'streaming' }));
        service = new GatewayService(registry, bus, new NotificationRouter(bus, registry));

        const req = new Request('http://localhost/api/v1/gateway/telegram', { method: 'POST', body: '{}' });
        await service.handleInbound('telegram', req as any);

        expect(agentOpsService.createRun).toHaveBeenCalled();
    });

    it('fails open to the task path when model resolution throws', async () => {
        const { resolveDefaultModelConfig } = await import('@/lib/agent/model-resolver');
        const { triageChatMessage } = await import('@/lib/agent/triage');
        const { agentOpsService } = await import('@/lib/agent-ops/agent-ops-service');
        vi.mocked(resolveDefaultModelConfig).mockRejectedValue(new Error('no provider configured'));

        const req = new Request('http://localhost/api/v1/gateway/telegram', { method: 'POST', body: '{}' });
        const res = await service.handleInbound('telegram', req as any);

        expect(triageChatMessage).not.toHaveBeenCalled();
        expect(agentOpsService.createRun).toHaveBeenCalled();
        expect(res.status).toBe(200);
    });

    it('fails open to the task path when the classifier throws', async () => {
        const { triageChatMessage } = await import('@/lib/agent/triage');
        const { agentOpsService } = await import('@/lib/agent-ops/agent-ops-service');
        vi.mocked(triageChatMessage).mockRejectedValue(new Error('throttled'));

        const req = new Request('http://localhost/api/v1/gateway/telegram', { method: 'POST', body: '{}' });
        await service.handleInbound('telegram', req as any);

        expect(agentOpsService.createRun).toHaveBeenCalled();
    });

    it('still routes an awaiting-clarification reply to handleResume, never to the classifier', async () => {
        const { triageChatMessage } = await import('@/lib/agent/triage');
        const { agentOpsService } = await import('@/lib/agent-ops/agent-ops-service');
        vi.mocked(agentOpsService.getRun).mockResolvedValue({
            runId: 'run-1', tenantId: 'tenant-1', source: 'telegram',
            status: 'awaiting_input', taskDescription: 'test', trigger: {},
        } as any);
        (adapter.parseInbound as any).mockResolvedValue({
            channelType: 'telegram', tenantId: 'tenant-1', taskDescription: 'hi', channelMeta: {},
            replyContext: { runId: 'run-1', action: 'clarification_response', content: 'hi', tenantId: 'tenant-1' },
        });

        const req = new Request('http://localhost/api/v1/gateway/telegram', { method: 'POST', body: '{}' });
        const res = await service.handleInbound('telegram', req as any);

        expect(triageChatMessage).not.toHaveBeenCalled();
        expect(res.status).toBe(200);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web-ui && bunx vitest run tests/gateway/gateway-service.test.ts -t "persona routing"`
Expected: FAIL — `handleInbound` always calls `createRun`, so the direct-reply expectations fail

- [ ] **Step 3: Implement the router branch**

In `lib/gateway/gateway-service.ts`, add these imports (do **not** add a separate `ChannelAdapter` import — extend the existing `import type { ChannelType, GatewayMessage } from './types';` on line 11 instead):

```ts
import type { ChannelType, GatewayMessage, ChannelAdapter } from './types';
import type { NextRequest } from 'next/server';
import { triageChatMessage, chatTriageEnabled } from '@/lib/agent/triage';
import { resolveModelConfig, resolveDefaultModelConfig } from '@/lib/agent/model-resolver';
import { generateDirectReply } from '@/lib/gateway/persona/direct-reply';
import { chatbotPersonaEnabled } from '@/lib/gateway/persona/persona-config';
```

(`NextRequest` is already imported as a type on line 10 — merge rather than duplicate.)

Insert the new branch in `handleInbound` immediately after the empty-`taskDescription` check that ends at line 60, and immediately before the `// 5. Create run via agentOpsService` comment at line 62:

```ts
        // 4.5. Persona router: small talk gets an instant reply and never
        // touches Agent Ops. Any failure inside (model resolution, the
        // classifier itself) falls through to the normal task path below —
        // never silently drop a real request.
        if (
            chatbotPersonaEnabled(channelType) &&
            chatTriageEnabled() &&
            adapter.sendDirectReply
        ) {
            const directReply = await this.tryDirectReply(message, req, adapter);
            if (directReply) return directReply;
        }

        // 5. Create run via agentOpsService
```

Add this private method at the end of the class, before the closing brace:

```ts
    /**
     * Returns a direct-reply Response when triage classifies the message as
     * small talk, or null to fall through to the normal Agent Ops path.
     * Fails open (returns null) on any error — a wasted run is cheaper than
     * silently dropping a real request.
     */
    private async tryDirectReply(
        message: GatewayMessage,
        req: NextRequest,
        adapter: ChannelAdapter,
    ): Promise<Response | null> {
        try {
            const model = message.model
                ? await resolveModelConfig(message.model, message.tenantId)
                : await resolveDefaultModelConfig(message.tenantId);

            const triage = await triageChatMessage({
                tenantId: message.tenantId,
                message: message.taskDescription,
                model,
            });
            if (triage.route !== 'direct') return null;

            const text = await generateDirectReply({ message: message.taskDescription, model });
            return await adapter.sendDirectReply!(req, text);
        } catch (err) {
            console.warn(`[GatewayService] Persona routing failed (non-fatal, falling through to task): ${err}`);
            return null;
        }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web-ui && bunx vitest run tests/gateway/gateway-service.test.ts`
Expected: PASS — all 9 new persona tests plus all 7 pre-existing tests in this file (this file is green at baseline)

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/gateway/gateway-service.ts apps/web-ui/tests/gateway/gateway-service.test.ts
git commit -m "feat(gateway): route small talk to a direct reply before creating an Agent Ops run"
```

---

## Task 6: Narration translator (template map + LLM fallback)

**Files:**
- Create: `apps/web-ui/lib/gateway/narration/translate-event.ts`
- Test: `apps/web-ui/lib/gateway/narration/translate-event.test.ts`

**Interfaces:**
- Consumes: `AgentOpsEvent` (`lib/agent-ops/types.ts:143`); `createAgentModels`, `contentToText`, `ResolvedModelConfig` (as Task 3).
- Produces: `translateEventTemplate(event: AgentOpsEvent): string | null` and `translateEventWithFallback(event: AgentOpsEvent, model: ResolvedModelConfig): Promise<string>` — Tasks 8/9 call the latter.

**Vocabulary note (verified against the codebase — do not substitute invented names):** the real tool catalog is `execute_command`, `ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `web_search`, `write_file_to_s3`, `get_file_from_s3`, `ask_user`, `get_aws_credentials`, `list_aws_accounts`, `get_right_sizing_recommendations`, `search_knowledge_base`, `load_skill` (plus per-tenant MCP tools). There are no per-service AWS tools — AWS work runs through `execute_command` invoking the AWS CLI. Real `event.node` values are LangGraph node names: `__start__`, `planner`, `generate`, `agent`, `reflect`, `revise`, `evaluator`, `memory_recall`, `memory_save`, `final`, `clarification`, `approval_gate`.

- [ ] **Step 1: Write the failing test**

Create `lib/gateway/narration/translate-event.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/agent/model-factory', () => ({ createAgentModels: vi.fn() }));

import { createAgentModels } from '@/lib/agent/model-factory';
import { translateEventTemplate, translateEventWithFallback } from './translate-event';
import type { AgentOpsEvent } from '@/lib/agent-ops/types';

function makeEvent(overrides: Partial<AgentOpsEvent> = {}): AgentOpsEvent {
    return { PK: '', SK: '', runId: 'run-1', eventType: 'tool_call', node: 'agent', createdAt: '', ttl: 0, ...overrides };
}

describe('translateEventTemplate', () => {
    it('maps a known tool name to a friendly phrase', () => {
        expect(translateEventTemplate(makeEvent({ toolName: 'execute_command' })))
            .toBe('Running an AWS CLI command...');
    });

    it('maps another known tool name', () => {
        expect(translateEventTemplate(makeEvent({ toolName: 'search_knowledge_base' })))
            .toBe('Searching the knowledge base...');
    });

    it('falls back to a known LangGraph node phrase when there is no tool name', () => {
        expect(translateEventTemplate(makeEvent({ toolName: undefined, node: 'planner' })))
            .toBe('Planning the approach...');
    });

    it('returns null for an unmapped tool and unmapped node', () => {
        expect(translateEventTemplate(makeEvent({ toolName: 'mcp_custom_thing', node: 'mystery_node' })))
            .toBeNull();
    });
});

describe('translateEventWithFallback', () => {
    beforeEach(() => vi.clearAllMocks());

    it('uses the template phrase without calling the model when one exists', async () => {
        const invoke = vi.fn();
        vi.mocked(createAgentModels).mockReturnValue({ reflector: { invoke } as any, main: {} as any });

        const result = await translateEventWithFallback(makeEvent({ toolName: 'execute_command' }), {} as any);

        expect(result).toBe('Running an AWS CLI command...');
        expect(invoke).not.toHaveBeenCalled();
    });

    it('calls the reflector model for an unmapped tool on an unmapped node', async () => {
        const invoke = vi.fn().mockResolvedValue({ content: 'Running a custom check...' });
        vi.mocked(createAgentModels).mockReturnValue({ reflector: { invoke } as any, main: {} as any });

        const result = await translateEventWithFallback(makeEvent({ toolName: 'mcp_custom_thing', node: 'mystery_node' }), {} as any);

        expect(result).toBe('Running a custom check...');
        expect(invoke).toHaveBeenCalledTimes(1);
    });

    it('falls back to a generic phrase when the model call throws', async () => {
        const invoke = vi.fn().mockRejectedValue(new Error('throttled'));
        vi.mocked(createAgentModels).mockReturnValue({ reflector: { invoke } as any, main: {} as any });

        const result = await translateEventWithFallback(makeEvent({ toolName: 'mcp_custom_thing', node: 'mystery_node' }), {} as any);

        expect(result).toBe('Working on the task...');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/gateway/narration/translate-event.test.ts`
Expected: FAIL — cannot find module `./translate-event`

- [ ] **Step 3: Implement**

Create `lib/gateway/narration/translate-event.ts`:

```ts
// web-ui/lib/gateway/narration/translate-event.ts
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { createAgentModels } from '@/lib/agent/model-factory';
import { contentToText, type ResolvedModelConfig } from '@/lib/agent/agent-shared';
import type { AgentOpsEvent } from '@/lib/agent-ops/types';

/**
 * The agent's real tool catalog (lib/agent/tools.ts). Deliberately generic —
 * AWS work happens via execute_command running the AWS CLI, so there are no
 * per-service tools to name. Anything outside this map (notably per-tenant MCP
 * tools) falls back to a cheap model call rather than leaking a raw tool name.
 */
const TOOL_PHRASES: Record<string, string> = {
    execute_command: 'Running an AWS CLI command...',
    ls: 'Listing files...',
    read_file: 'Reading a file...',
    write_file: 'Writing a file...',
    edit_file: 'Editing a file...',
    glob: 'Searching for files...',
    grep: 'Searching file contents...',
    web_search: 'Searching the web...',
    write_file_to_s3: 'Uploading the report to S3...',
    get_file_from_s3: 'Fetching a file from S3...',
    ask_user: 'Waiting on your input...',
    get_aws_credentials: 'Connecting to the AWS account...',
    list_aws_accounts: 'Listing connected AWS accounts...',
    get_right_sizing_recommendations: 'Reviewing right-sizing recommendations...',
    search_knowledge_base: 'Searching the knowledge base...',
    load_skill: 'Loading a specialized skill...',
};

/** Real LangGraph node names (see agent-executor.ts mapNodeToEventType). */
const NODE_PHRASES: Record<string, string> = {
    planner: 'Planning the approach...',
    generate: 'Working on it...',
    agent: 'Working on it...',
    reflect: 'Double-checking the results...',
    revise: 'Refining the approach...',
    evaluator: 'Assessing the request...',
    final: 'Wrapping up...',
    approval_gate: 'Waiting for your approval...',
    clarification: 'Waiting on your answer...',
};

export function translateEventTemplate(event: AgentOpsEvent): string | null {
    if (event.toolName && TOOL_PHRASES[event.toolName]) return TOOL_PHRASES[event.toolName];
    if (NODE_PHRASES[event.node]) return NODE_PHRASES[event.node];
    return null;
}

export async function translateEventWithFallback(
    event: AgentOpsEvent,
    model: ResolvedModelConfig,
): Promise<string> {
    const templated = translateEventTemplate(event);
    if (templated) return templated;

    try {
        const { reflector } = createAgentModels(model);
        const resp = await reflector.invoke([
            new SystemMessage('Rewrite this internal agent step as one short, friendly sentence for a non-technical user. No jargon, no code, no tool names. Max 12 words.'),
            new HumanMessage(`tool: ${event.toolName ?? 'none'}, node: ${event.node}, detail: ${(event.content ?? '').slice(0, 500)}`),
        ]);
        const text = contentToText(resp.content).trim();
        return text || 'Working on the task...';
    } catch {
        return 'Working on the task...';
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run lib/gateway/narration/translate-event.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/gateway/narration/translate-event.ts apps/web-ui/lib/gateway/narration/translate-event.test.ts
git commit -m "feat(gateway): add template+LLM-fallback translator for run-event narration"
```

---

## Task 7: Checklist state + rendering (keyed correlation)

Steps must be completed by **key** (`toolName`), not by position: the executor records one `tool_call` per tool in a loop (`agent-executor.ts:482-491`), so a parallel-tool turn produces N `tool_call`s followed by N `tool_result`s. Completing "the last step" would re-complete a single step N times and strand the rest at ⏳ forever.

**Files:**
- Create: `apps/web-ui/lib/gateway/narration/checklist.ts`
- Test: `apps/web-ui/lib/gateway/narration/checklist.test.ts`

**Interfaces:**
- Produces: `ChecklistState`, `createChecklist()`, `addStep(state, label, opts?)`, `completeStep(state, key?)`, `renderChecklist(state)` — Tasks 8/9 call all of these.

- [ ] **Step 1: Write the failing test**

Create `lib/gateway/narration/checklist.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createChecklist, addStep, completeStep, renderChecklist } from './checklist';

describe('checklist', () => {
    it('renders a placeholder before any step exists', () => {
        expect(renderChecklist(createChecklist())).toBe('Getting started...');
    });

    it('renders pending then completed steps', () => {
        let state = createChecklist();
        state = addStep(state, 'Reading a file...', { key: 'read_file' });
        expect(renderChecklist(state)).toBe('⏳ Reading a file...');

        state = completeStep(state, 'read_file');
        expect(renderChecklist(state)).toBe('✅ Reading a file...');
    });

    it('adds milestone steps already complete', () => {
        const state = addStep(createChecklist(), 'Planning the approach...', { done: true });
        expect(renderChecklist(state)).toBe('✅ Planning the approach...');
    });

    it('completes the matching key under interleaved parallel tool calls', () => {
        let state = createChecklist();
        state = addStep(state, 'Running an AWS CLI command...', { key: 'execute_command' });
        state = addStep(state, 'Reading a file...', { key: 'read_file' });
        state = addStep(state, 'Searching file contents...', { key: 'grep' });

        // Results arrive out of order — each must complete its own step.
        state = completeStep(state, 'read_file');
        state = completeStep(state, 'execute_command');

        const lines = renderChecklist(state).split('\n');
        expect(lines[0]).toBe('✅ Running an AWS CLI command...');
        expect(lines[1]).toBe('✅ Reading a file...');
        expect(lines[2]).toBe('⏳ Searching file contents...');
    });

    it('completes the OLDEST pending step when the same tool runs twice', () => {
        let state = createChecklist();
        state = addStep(state, 'Running an AWS CLI command...', { key: 'execute_command' });
        state = addStep(state, 'Running an AWS CLI command...', { key: 'execute_command' });

        state = completeStep(state, 'execute_command');

        const lines = renderChecklist(state).split('\n');
        expect(lines[0]).toBe('✅ Running an AWS CLI command...');
        expect(lines[1]).toBe('⏳ Running an AWS CLI command...');
    });

    it('is a no-op when no pending step matches the key', () => {
        const state = completeStep(addStep(createChecklist(), 'Reading a file...', { key: 'read_file' }), 'grep');
        expect(renderChecklist(state)).toBe('⏳ Reading a file...');
    });

    it('is a no-op on an empty checklist', () => {
        expect(renderChecklist(completeStep(createChecklist(), 'grep'))).toBe('Getting started...');
    });

    it('collapses steps older than the last 6 into a summary line', () => {
        let state = createChecklist();
        for (let i = 1; i <= 8; i++) {
            state = addStep(state, `Step ${i}`, { done: true });
        }
        state = addStep(state, 'Step 9', { key: 'grep' });

        const lines = renderChecklist(state).split('\n');
        expect(lines[0]).toBe('✅ 3 earlier steps completed');
        expect(lines).toContain('✅ Step 4');
        expect(lines).toContain('✅ Step 8');
        expect(lines).toContain('⏳ Step 9');
        expect(lines).not.toContain('✅ Step 1');
    });

    it('does not mutate the input state (pure functions)', () => {
        const original = createChecklist();
        const next = addStep(original, 'Step 1');
        expect(original.steps.length).toBe(0);
        expect(next.steps.length).toBe(1);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/gateway/narration/checklist.test.ts`
Expected: FAIL — cannot find module `./checklist`

- [ ] **Step 3: Implement**

Create `lib/gateway/narration/checklist.ts`:

```ts
// web-ui/lib/gateway/narration/checklist.ts

export interface ChecklistStep {
    label: string;
    /** Correlation key — the tool name for tool steps; absent for milestones. */
    key?: string;
    done: boolean;
}

export interface ChecklistState {
    steps: ChecklistStep[];
}

/** Keep the message well under Telegram's 4096-char cap. */
const EXPANDED_WINDOW = 6;

export function createChecklist(): ChecklistState {
    return { steps: [] };
}

export function addStep(
    state: ChecklistState,
    label: string,
    opts: { key?: string; done?: boolean } = {},
): ChecklistState {
    return { steps: [...state.steps, { label, key: opts.key, done: opts.done ?? false }] };
}

/**
 * Complete the OLDEST pending step matching `key` (FIFO — tool results come back
 * in roughly call order, and matching oldest-first keeps repeated calls to the
 * same tool from collapsing onto one step). With no key, completes the oldest
 * pending step of any kind. A no-op when nothing matches.
 */
export function completeStep(state: ChecklistState, key?: string): ChecklistState {
    const index = state.steps.findIndex(
        (s) => !s.done && (key === undefined || s.key === key),
    );
    if (index === -1) return state;

    const steps = [...state.steps];
    steps[index] = { ...steps[index], done: true };
    return { steps };
}

export function renderChecklist(state: ChecklistState): string {
    const total = state.steps.length;
    if (total === 0) return 'Getting started...';

    const collapseCount = Math.max(0, total - EXPANDED_WINDOW);
    const collapsedDone = state.steps.slice(0, collapseCount).filter((s) => s.done).length;
    const visible = state.steps.slice(collapseCount);

    const lines: string[] = [];
    if (collapseCount > 0) {
        lines.push(`✅ ${collapsedDone} earlier step${collapsedDone === 1 ? '' : 's'} completed`);
    }
    for (const step of visible) {
        lines.push(`${step.done ? '✅' : '⏳'} ${step.label}`);
    }
    return lines.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run lib/gateway/narration/checklist.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/gateway/narration/checklist.ts apps/web-ui/lib/gateway/narration/checklist.test.ts
git commit -m "feat(gateway): add keyed checklist state/render for run narration"
```

---
## Task 8: Shared narration session

All three narrating adapters (Telegram, Slack, Discord) need identical per-run bookkeeping: a checklist, a resolved-model cache, a finished-run guard, and a send throttle. Owning that once here keeps Tasks 9-11 to pure transport — each adapter only decides *how* to put text on the wire.

**Files:**
- Create: `apps/web-ui/lib/gateway/narration/narration-session.ts`
- Test: `apps/web-ui/lib/gateway/narration/narration-session.test.ts`

**Interfaces:**
- Consumes: `isStepBoundary` (Task 1); `translateEventWithFallback` (Task 6); `createChecklist`/`addStep`/`completeStep`/`renderChecklist` (Task 7); `resolveModelConfig`/`resolveDefaultModelConfig` (`lib/agent/model-resolver.ts:87,126`); `ChannelRateLimiter` (`lib/gateway/utils/rate-limiter.ts`).
- Produces: `class NarrationSessions` with `constructor(minIntervalMs?: number)`, `applyEvent(run: AgentOpsRun, event: AgentOpsEvent): Promise<string | null>`, `finish(runId: string): void`, `isFinished(runId: string): boolean` — Tasks 9, 10, and 11 each hold one instance.

- [ ] **Step 1: Write the failing test**

Create `lib/gateway/narration/narration-session.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/agent/model-resolver', () => ({
    resolveModelConfig: vi.fn().mockResolvedValue({ provider: 'bedrock', modelId: 'test-model' }),
    resolveDefaultModelConfig: vi.fn().mockResolvedValue({ provider: 'bedrock', modelId: 'test-model' }),
}));
vi.mock('@/lib/gateway/narration/translate-event', () => ({
    translateEventWithFallback: vi.fn(async (e: any) => {
        if (e.eventType === 'planning') return 'Planning the approach...';
        return e.toolName === 'read_file' ? 'Reading a file...' : 'Running an AWS CLI command...';
    }),
}));

import { resolveDefaultModelConfig } from '@/lib/agent/model-resolver';
import { NarrationSessions } from './narration-session';

const run = { runId: 'run-1', tenantId: 'tenant-1', trigger: {} } as any;
const evt = (eventType: string, toolName?: string) => ({ eventType, node: 'agent', toolName }) as any;

describe('NarrationSessions', () => {
    let sessions: NarrationSessions;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(resolveDefaultModelConfig).mockResolvedValue({ provider: 'bedrock', modelId: 'test-model' } as any);
        sessions = new NarrationSessions(0); // no throttling in tests
    });

    it('returns null for a non-boundary event', async () => {
        expect(await sessions.applyEvent(run, evt('memory_save'))).toBeNull();
    });

    it('renders a pending step for tool_call', async () => {
        const text = await sessions.applyEvent(run, evt('tool_call', 'execute_command'));
        expect(text).toBe('⏳ Running an AWS CLI command...');
    });

    it('completes the matching step on tool_result', async () => {
        await sessions.applyEvent(run, evt('tool_call', 'execute_command'));
        const text = await sessions.applyEvent(run, evt('tool_result', 'execute_command'));
        expect(text).toBe('✅ Running an AWS CLI command...');
    });

    it('correlates parallel tool calls by tool name', async () => {
        await sessions.applyEvent(run, evt('tool_call', 'execute_command'));
        await sessions.applyEvent(run, evt('tool_call', 'read_file'));
        const text = await sessions.applyEvent(run, evt('tool_result', 'read_file'));

        const lines = text!.split('\n');
        expect(lines[0]).toBe('⏳ Running an AWS CLI command...');
        expect(lines[1]).toBe('✅ Reading a file...');
    });

    it('adds milestone events already complete', async () => {
        const text = await sessions.applyEvent(run, evt('planning'));
        expect(text).toBe('✅ Planning the approach...');
    });

    it('keeps state per run', async () => {
        await sessions.applyEvent(run, evt('tool_call', 'execute_command'));
        const other = await sessions.applyEvent({ ...run, runId: 'run-2' }, evt('tool_call', 'read_file'));
        expect(other).toBe('⏳ Reading a file...');
    });

    it('resolves the model once per run and caches it', async () => {
        await sessions.applyEvent(run, evt('tool_call', 'execute_command'));
        await sessions.applyEvent(run, evt('tool_call', 'read_file'));
        expect(resolveDefaultModelConfig).toHaveBeenCalledTimes(1);
    });

    it('returns null and stops narrating once finished', async () => {
        await sessions.applyEvent(run, evt('tool_call', 'execute_command'));
        sessions.finish('run-1');

        expect(sessions.isFinished('run-1')).toBe(true);
        expect(await sessions.applyEvent(run, evt('tool_call', 'read_file'))).toBeNull();
    });

    it('throttles sends but keeps checklist state current', async () => {
        const throttled = new NarrationSessions(60_000);

        expect(await throttled.applyEvent(run, evt('tool_call', 'execute_command'))).toBe('⏳ Running an AWS CLI command...');
        // Suppressed by the throttle...
        expect(await throttled.applyEvent(run, evt('tool_call', 'read_file'))).toBeNull();
        // ...but the state still advanced: finishing and re-reading shows both steps.
        throttled.finish('run-1');
        const fresh = new NarrationSessions(0);
        expect(await fresh.applyEvent(run, evt('tool_call', 'execute_command'))).toBe('⏳ Running an AWS CLI command...');
    });

    it('never throws when model resolution fails', async () => {
        vi.mocked(resolveDefaultModelConfig).mockRejectedValue(new Error('no provider'));
        await expect(sessions.applyEvent(run, evt('tool_call', 'execute_command'))).resolves.toBeNull();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-ui && bunx vitest run lib/gateway/narration/narration-session.test.ts`
Expected: FAIL — cannot find module `./narration-session`

- [ ] **Step 3: Implement**

Create `lib/gateway/narration/narration-session.ts`:

```ts
// web-ui/lib/gateway/narration/narration-session.ts
import { resolveModelConfig, resolveDefaultModelConfig } from '@/lib/agent/model-resolver';
import type { ResolvedModelConfig } from '@/lib/agent/agent-shared';
import { isStepBoundary } from '@/lib/agent-ops/record-and-emit';
import { translateEventWithFallback } from '@/lib/gateway/narration/translate-event';
import { ChannelRateLimiter } from '@/lib/gateway/utils/rate-limiter';
import {
    createChecklist,
    addStep,
    completeStep,
    renderChecklist,
    type ChecklistState,
} from './checklist';
import type { AgentOpsRun, AgentOpsEvent } from '@/lib/agent-ops/types';

const DEFAULT_MIN_INTERVAL_MS = 2000;

/**
 * Per-run narration bookkeeping shared by every narrating channel adapter.
 * Owns the checklist, the resolved-model cache, the finished-run guard, and
 * the send throttle; adapters own only their transport.
 */
export class NarrationSessions {
    private checklists = new Map<string, ChecklistState>();
    private modelCache = new Map<string, ResolvedModelConfig>();
    private finishedRuns = new Set<string>();
    private rateLimiter: ChannelRateLimiter;

    constructor(minIntervalMs: number = DEFAULT_MIN_INTERVAL_MS) {
        this.rateLimiter = new ChannelRateLimiter(minIntervalMs);
    }

    /**
     * Fold an event into the run's checklist and return the text to render, or
     * null when nothing should go out: a non-boundary event, a run that already
     * delivered its result, a throttled send, or a narration failure.
     *
     * A throttled call still advances checklist state, so a suppressed update is
     * never lost — it folds into the next send.
     */
    async applyEvent(run: AgentOpsRun, event: AgentOpsEvent): Promise<string | null> {
        if (!isStepBoundary(event.eventType)) return null;
        // GatewayEventBus.emit doesn't await subscribers, so a narration update
        // can still be in flight when the final result lands. Never overwrite it.
        if (this.finishedRuns.has(run.runId)) return null;

        try {
            let checklist = this.checklists.get(run.runId) ?? createChecklist();

            if (event.eventType === 'tool_result') {
                checklist = completeStep(checklist, event.toolName);
            } else {
                const label = await this.translate(run, event);
                checklist = event.eventType === 'tool_call'
                    ? addStep(checklist, label, { key: event.toolName })
                    // planning / reflection are finished milestones, not work in flight.
                    : addStep(checklist, label, { done: true });
            }

            this.checklists.set(run.runId, checklist);

            if (!this.rateLimiter.shouldSend(run.runId)) return null;
            return renderChecklist(checklist);
        } catch (err) {
            console.warn('[NarrationSessions] Narration failed (non-fatal):', err);
            return null;
        }
    }

    /** Mark a run finished and drop its state. Idempotent. */
    finish(runId: string): void {
        this.finishedRuns.add(runId);
        this.checklists.delete(runId);
        this.modelCache.delete(runId);
        this.rateLimiter.reset(runId);
    }

    isFinished(runId: string): boolean {
        return this.finishedRuns.has(runId);
    }

    private async translate(run: AgentOpsRun, event: AgentOpsEvent): Promise<string> {
        return translateEventWithFallback(event, await this.resolveRunModel(run));
    }

    private async resolveRunModel(run: AgentOpsRun): Promise<ResolvedModelConfig> {
        const cached = this.modelCache.get(run.runId);
        if (cached) return cached;
        const config = run.model
            ? await resolveModelConfig(run.model, run.tenantId)
            : await resolveDefaultModelConfig(run.tenantId);
        this.modelCache.set(run.runId, config);
        return config;
    }
}
```

`finishedRuns` is intentionally never pruned per-run — a small string set bounded by process lifetime, and re-adding a completed runId is harmless.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-ui && bunx vitest run lib/gateway/narration/narration-session.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/gateway/narration/narration-session.ts apps/web-ui/lib/gateway/narration/narration-session.test.ts
git commit -m "feat(gateway): add shared NarrationSessions for per-run checklist state"
```

---

## Task 9: Telegram checklist narration

Pure transport: `NarrationSessions` (Task 8) owns all state; this task only edits the ack message.

**Files:**
- Modify: `apps/web-ui/lib/gateway/adapters/telegram-adapter.ts`
- Test: `apps/web-ui/tests/gateway/adapters/telegram-adapter.test.ts`

**Interfaces:**
- Consumes: `NarrationSessions` (Task 8).

- [ ] **Step 1: Write the failing tests**

Add this mock near the file's other `vi.mock` calls in `tests/gateway/adapters/telegram-adapter.test.ts`:

```ts
vi.mock('@/lib/agent/model-resolver', () => ({
    resolveModelConfig: vi.fn().mockResolvedValue({ provider: 'bedrock', modelId: 'test-model' }),
    resolveDefaultModelConfig: vi.fn().mockResolvedValue({ provider: 'bedrock', modelId: 'test-model' }),
}));
vi.mock('@/lib/gateway/narration/translate-event', () => ({
    translateEventWithFallback: vi.fn(async (e: any) => (e.toolName === 'read_file' ? 'Reading a file...' : 'Running an AWS CLI command...')),
}));
```

Add this import at the top of the file:

```ts
import { NarrationSessions } from '@/lib/gateway/narration/narration-session';
```

Then add this `describe` block. It swaps in a zero-throttle session so consecutive sends inside one test aren't suppressed:

```ts
describe('sendStreamChunk narration', () => {
    const run = {
        runId: 'run-1', tenantId: 'tenant-1', source: 'telegram',
        taskDescription: 'test', trigger: { chatId: 555, userId: 1 },
    } as any;

    beforeEach(async () => {
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

    it('does nothing when there is no ack message id for the run', async () => {
        await adapter.sendStreamChunk!(
            { ...run, runId: 'run-never-acked' },
            { eventType: 'tool_call', node: 'agent', toolName: 'execute_command' } as any,
        );
        expect(global.fetch).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web-ui && bunx vitest run tests/gateway/adapters/telegram-adapter.test.ts -t "sendStreamChunk narration"`
Expected: FAIL — today's `sendStreamChunk` emits raw `[eventType] toolName` text with no checklist markers

- [ ] **Step 3: Implement**

In `lib/gateway/adapters/telegram-adapter.ts`, add the import:

```ts
import { NarrationSessions } from '@/lib/gateway/narration/narration-session';
```

Replace the existing `private rateLimiter = new ChannelRateLimiter(2000);` field (line 103) with:

```ts
    private narration = new NarrationSessions();
```

The `ChannelRateLimiter` import becomes unused once that field is gone — remove it. (`sendStreamChunk` was its only consumer; verify with a search before deleting.)

Replace the entire existing `sendStreamChunk` method with:

```ts
    async sendStreamChunk(run: AgentOpsRun, event: AgentOpsEvent): Promise<void> {
        const ackMsgId = this.ackMessageIds.get(run.runId);
        if (!ackMsgId) return;

        const text = await this.narration.applyEvent(run, event);
        if (text === null) return;

        const trigger = run.trigger as TelegramTriggerMeta;
        await this.editMessage(run, trigger.chatId, ackMsgId, escapeMarkdownV2(text));
    }
```

In `sendResult`, mark the run finished **before** the final edit, and clear the ack id on both branches. Replace the method's existing tail (the `if (ackMsgId) { ... } else { ... }` block at lines ~230-238) with:

```ts
        this.narration.finish(run.runId);
        const ackMsgId = this.ackMessageIds.get(run.runId);
        if (ackMsgId) {
            await this.editMessage(run, trigger.chatId, ackMsgId, lines.join('\n'));
        } else {
            await this.sendMessage(run, trigger.chatId, lines.join('\n'));
        }
        this.ackMessageIds.delete(run.runId);
```

(The existing code deleted `ackMessageIds` only inside the `if` branch, leaking it on the no-ack path — this fixes that too.)

In `sendError`, add the same guard as its first statement and clear the ack id at the end:

```ts
    async sendError(run: AgentOpsRun, error: string): Promise<void> {
        this.narration.finish(run.runId);
        const trigger = run.trigger as TelegramTriggerMeta;
        const text = `*Agent Ops Failed*\n\n${escapeMarkdownV2(error)}`;
        await this.sendMessage(run, trigger.chatId, text);
        this.ackMessageIds.delete(run.runId);
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web-ui && bunx vitest run tests/gateway/adapters/telegram-adapter.test.ts -t "sendStreamChunk narration"`
Expected: PASS (5 tests)

- [ ] **Step 5: Confirm no new failures in the file**

Run: `cd apps/web-ui && bunx vitest run tests/gateway/adapters/telegram-adapter.test.ts`
Expected: only the 1 known-red baseline failure ("no-ops without a chatId"); everything else passes

- [ ] **Step 6: Commit**

```bash
git add apps/web-ui/lib/gateway/adapters/telegram-adapter.ts apps/web-ui/tests/gateway/adapters/telegram-adapter.test.ts
git commit -m "feat(gateway): narrate Telegram Agent Ops runs as a running checklist"
```

---

## Task 10: Slack narration + notification-router gate

**Files:**
- Modify: `apps/web-ui/lib/gateway/notification-router.ts`
- Modify: `apps/web-ui/lib/gateway/adapters/slack-adapter.ts`
- Test: `apps/web-ui/tests/gateway/notification-router.test.ts`
- Test: `apps/web-ui/tests/gateway/adapters/slack-adapter.test.ts`

**Interfaces:**
- Consumes: `NarrationSessions` (Task 8).

- [ ] **Step 1: Write the failing tests**

Add to `tests/gateway/notification-router.test.ts`, **inside** the existing `describe('NotificationRouter', ...)` block (it depends on that block's `bus`/`registry`/`router` bindings and `makeRun`):

```ts
    it('dispatches run:event to a callback-mode adapter that implements sendStreamChunk', async () => {
        const callbackAdapter = makeMockAdapter({
            deliveryMode: 'callback',
            sendStreamChunk: vi.fn().mockResolvedValue(undefined),
        });
        registry = new AdapterRegistry();
        registry.register(callbackAdapter);
        router = new NotificationRouter(bus, registry);

        router.attachToRun(makeRun());
        bus.emit({ type: 'run:event', runId: 'run-1', tenantId: 'tenant-1', timestamp: new Date(), data: { event: { eventType: 'tool_call' } as any } });
        await new Promise((r) => setTimeout(r, 50));

        expect(callbackAdapter.sendStreamChunk).toHaveBeenCalled();
    });
```

Add to `tests/gateway/adapters/slack-adapter.test.ts` — first these mocks near the file's existing ones:

```ts
vi.mock('@/lib/agent/model-resolver', () => ({
    resolveModelConfig: vi.fn().mockResolvedValue({ provider: 'bedrock', modelId: 'test-model' }),
    resolveDefaultModelConfig: vi.fn().mockResolvedValue({ provider: 'bedrock', modelId: 'test-model' }),
}));
vi.mock('@/lib/gateway/narration/translate-event', () => ({
    translateEventWithFallback: vi.fn().mockResolvedValue('Running an AWS CLI command...'),
}));
```

Add this import at the top of the file:

```ts
import { NarrationSessions } from '@/lib/gateway/narration/narration-session';
```

Then this `describe` block:

```ts
describe('sendStreamChunk narration', () => {
    const run = {
        runId: 'run-1', tenantId: 'tenant-1', source: 'slack', taskDescription: 'test',
        trigger: { channelId: 'C456', userId: 'U123', responseUrl: 'https://hooks.slack.com/test' },
    } as any;

    beforeEach(() => {
        (adapter as any).narration = new NarrationSessions(0);
        global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, channel: 'C456', ts: '111.222' }) });
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ botToken: 'slack-bot-token', signingSecret: 'secret' } as any);
    });

    it('does nothing when the tenant has no Slack bot token configured', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null as any);
        await adapter.sendStreamChunk!(run, { eventType: 'tool_call', node: 'agent', toolName: 'execute_command' } as any);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('ignores event types that are not step boundaries', async () => {
        await adapter.sendStreamChunk!(run, { eventType: 'memory_save', node: 'memory_save' } as any);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('posts a new message on the first step, then updates it on later steps', async () => {
        await adapter.sendStreamChunk!(run, { eventType: 'tool_call', node: 'agent', toolName: 'execute_command' } as any);
        expect(vi.mocked(global.fetch).mock.calls[0][0]).toBe('https://slack.com/api/chat.postMessage');

        vi.mocked(global.fetch).mockClear();

        await adapter.sendStreamChunk!(run, { eventType: 'tool_result', node: 'agent', toolName: 'execute_command' } as any);
        const [url, init] = vi.mocked(global.fetch).mock.calls[0];
        expect(url).toBe('https://slack.com/api/chat.update');
        const body = JSON.parse(init!.body as string);
        expect(body.ts).toBe('111.222');
        expect(body.text).toContain('✅');
    });

    it('retries a fresh postMessage when the first post was rejected by Slack', async () => {
        vi.mocked(global.fetch).mockResolvedValue({ ok: true, json: async () => ({ ok: false, error: 'not_in_channel' }) } as any);
        await adapter.sendStreamChunk!(run, { eventType: 'tool_call', node: 'agent', toolName: 'execute_command' } as any);
        vi.mocked(global.fetch).mockClear();

        await adapter.sendStreamChunk!(run, { eventType: 'tool_call', node: 'agent', toolName: 'read_file' } as any);
        expect(vi.mocked(global.fetch).mock.calls[0][0]).toBe('https://slack.com/api/chat.postMessage');
    });

    it('stops narrating once the run has delivered its result', async () => {
        await adapter.sendStreamChunk!(run, { eventType: 'tool_call', node: 'agent', toolName: 'execute_command' } as any);
        await adapter.sendResult({ ...run, result: { summary: 'done' } } as any, []);
        vi.mocked(global.fetch).mockClear();

        await adapter.sendStreamChunk!(run, { eventType: 'tool_call', node: 'agent', toolName: 'read_file' } as any);
        expect(global.fetch).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web-ui && bunx vitest run tests/gateway/notification-router.test.ts tests/gateway/adapters/slack-adapter.test.ts -t "sendStreamChunk narration"`
Expected: FAIL — `SlackAdapter.sendStreamChunk` doesn't exist

Run: `cd apps/web-ui && bunx vitest run tests/gateway/notification-router.test.ts -t "callback-mode"`
Expected: FAIL — `run:event` isn't dispatched to callback adapters

- [ ] **Step 3: Loosen the `NotificationRouter` gate**

In `lib/gateway/notification-router.ts`, change the `run:event` case (lines 21-25) from:

```ts
                    case 'run:event':
                        if (adapter.sendStreamChunk && adapter.deliveryMode === 'streaming') {
                            await adapter.sendStreamChunk(run, event.data.event!);
                        }
                        break;
```

to:

```ts
                    case 'run:event':
                        // Narration is now purely a function of implementing
                        // sendStreamChunk — Slack is callback-mode but narrates via
                        // chat.update, and gates itself internally on a bot token.
                        if (adapter.sendStreamChunk) {
                            await adapter.sendStreamChunk(run, event.data.event!);
                        }
                        break;
```

- [ ] **Step 4: Implement `sendStreamChunk` in `SlackAdapter`**

In `lib/gateway/adapters/slack-adapter.ts`, add the import:

```ts
import { NarrationSessions } from '@/lib/gateway/narration/narration-session';
```

Add private fields on the class:

```ts
    private narration = new NarrationSessions();
    private streamMessages = new Map<string, { channel: string; ts: string }>();
```

Add `sendStreamChunk` next to `sendResult`:

```ts
    async sendStreamChunk(run: AgentOpsRun, event: AgentOpsEvent): Promise<void> {
        const trigger = run.trigger as SlackTriggerMeta;
        if (!trigger?.channelId) return;

        const text = await this.narration.applyEvent(run, event);
        if (text === null) return;

        // Narration edits a channel message in place, which needs chat.update and
        // therefore a bot token. Without one, skip silently — that's today's
        // behavior (no narration at all), not a regression.
        const config = await this.loadConfig(run.tenantId);
        if (!config?.botToken) return;

        const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${config.botToken}` };
        const existing = this.streamMessages.get(run.runId);

        try {
            if (existing) {
                await fetch('https://slack.com/api/chat.update', {
                    method: 'POST',
                    headers: auth,
                    body: JSON.stringify({ channel: existing.channel, ts: existing.ts, text }),
                });
                return;
            }

            const res = await fetch('https://slack.com/api/chat.postMessage', {
                method: 'POST',
                headers: auth,
                body: JSON.stringify({ channel: trigger.channelId, thread_ts: trigger.threadTs, text }),
            });
            const data = await res.json();
            if (data.ok) {
                this.streamMessages.set(run.runId, { channel: data.channel, ts: data.ts });
            } else {
                // e.g. not_in_channel — leave streamMessages unset so the next
                // boundary retries a fresh post rather than updating nothing.
                console.warn('[SlackAdapter] Narration post failed:', data.error);
            }
        } catch (err) {
            console.error('[SlackAdapter] sendStreamChunk error:', err);
        }
    }
```

Add as the **first statement** of both `sendResult` and `sendError`:

```ts
        this.narration.finish(run.runId);
```

...and as the last statement of each:

```ts
        this.streamMessages.delete(run.runId);
```

Note the ordering inside `sendStreamChunk`: the bot-token lookup happens *after* `applyEvent` so non-boundary events cost no config read; but `trigger.channelId` is checked first because without it there is no destination at all.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/web-ui && bunx vitest run tests/gateway/notification-router.test.ts tests/gateway/adapters/slack-adapter.test.ts -t "sendStreamChunk narration"`
Expected: PASS

Run: `cd apps/web-ui && bunx vitest run tests/gateway/notification-router.test.ts`
Expected: PASS — this file is fully green at baseline

- [ ] **Step 6: Confirm no new failures in the Slack file**

Run: `cd apps/web-ui && bunx vitest run tests/gateway/adapters/slack-adapter.test.ts`
Expected: only the 3 known-red baseline failures; everything else passes

- [ ] **Step 7: Commit**

```bash
git add apps/web-ui/lib/gateway/adapters/slack-adapter.ts apps/web-ui/lib/gateway/notification-router.ts apps/web-ui/tests/gateway/adapters/slack-adapter.test.ts apps/web-ui/tests/gateway/notification-router.test.ts
git commit -m "feat(gateway): narrate Slack Agent Ops runs as a running checklist"
```

---

## Task 11: Discord checklist narration

Discord's `sendStreamChunk` already exists but has never run (nothing emitted `run:event` until Task 1) and renders raw internal text. Once Task 1 lands it becomes live, so it needs the same checklist treatment rather than suddenly emitting `[tool_call] execute_command` to users. Discord is `deliveryMode: 'streaming'`, so it already passes the notification-router gate — this task is independent of Task 10.

**Files:**
- Modify: `apps/web-ui/lib/gateway/adapters/discord-adapter.ts`
- Test: `apps/web-ui/tests/gateway/adapters/discord-adapter.test.ts`

**Interfaces:**
- Consumes: `NarrationSessions` (Task 8).

- [ ] **Step 1: Write the failing tests**

Add these mocks near the file's existing `vi.mock` call in `tests/gateway/adapters/discord-adapter.test.ts`:

```ts
vi.mock('@/lib/agent/model-resolver', () => ({
    resolveModelConfig: vi.fn().mockResolvedValue({ provider: 'bedrock', modelId: 'test-model' }),
    resolveDefaultModelConfig: vi.fn().mockResolvedValue({ provider: 'bedrock', modelId: 'test-model' }),
}));
vi.mock('@/lib/gateway/narration/translate-event', () => ({
    translateEventWithFallback: vi.fn(async (e: any) => (e.toolName === 'read_file' ? 'Reading a file...' : 'Running an AWS CLI command...')),
}));
```

Add this import at the top of the file:

```ts
import { NarrationSessions } from '@/lib/gateway/narration/narration-session';
```

Then add this `describe` block:

```ts
describe('sendStreamChunk narration', () => {
    const run = {
        runId: 'run-1', tenantId: 'tenant-1', source: 'discord', taskDescription: 'test',
        trigger: { channelId: 'C1', userId: 'U1', interactionId: 'i1', interactionToken: 'tok-1' },
    } as any;

    beforeEach(() => {
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
        ).mockResolvedValueOnce('x'.repeat(2500));

        await adapter.sendStreamChunk!(run, { eventType: 'tool_call', node: 'agent', toolName: 'execute_command' } as any);

        const [, init] = vi.mocked(global.fetch).mock.calls[0];
        const body = JSON.parse(init!.body as string);
        expect(body.content.length).toBe(2000);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web-ui && bunx vitest run tests/gateway/adapters/discord-adapter.test.ts -t "sendStreamChunk narration"`
Expected: FAIL — today's implementation emits raw `[eventType] toolName` text with no checklist markers and no step-boundary filter

- [ ] **Step 3: Implement**

In `lib/gateway/adapters/discord-adapter.ts`, add the import:

```ts
import { NarrationSessions } from '@/lib/gateway/narration/narration-session';
```

Add a constant next to the other Discord constants:

```ts
const DISCORD_MESSAGE_MAX_CHARS = 2000;
```

Replace the existing `private rateLimiter = new ChannelRateLimiter(2000);` field with:

```ts
    private narration = new NarrationSessions();
```

The `ChannelRateLimiter` import becomes unused once that field is gone — remove it. (`sendStreamChunk` was its only consumer; verify with a search before deleting.)

Replace the entire existing `sendStreamChunk` method (lines 263-272) with:

```ts
    async sendStreamChunk(run: AgentOpsRun, event: AgentOpsEvent): Promise<void> {
        const text = await this.narration.applyEvent(run, event);
        if (text === null) return;

        const trigger = run.trigger as DiscordTriggerMeta;
        await this.patchOriginalMessage(run, trigger, {
            content: text.slice(0, DISCORD_MESSAGE_MAX_CHARS),
        });
    }
```

Add `this.narration.finish(run.runId);` as the **first statement** of both `sendResult` and `sendError`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web-ui && bunx vitest run tests/gateway/adapters/discord-adapter.test.ts -t "sendStreamChunk narration"`
Expected: PASS (5 tests)

- [ ] **Step 5: Confirm no new failures in the file**

Run: `cd apps/web-ui && bunx vitest run tests/gateway/adapters/discord-adapter.test.ts`
Expected: PASS — this file is fully green at baseline, so any failure here is a real regression

- [ ] **Step 6: Full suite check**

Run: `cd apps/web-ui && bunx vitest run tests/gateway lib/gateway lib/agent-ops/record-and-emit.test.ts lib/agent/triage.test.ts`
Expected: PASS except the **5 known-red baseline failures** listed in Global Constraints. Any *other* failure is a real regression from this work — fix it before finishing.

- [ ] **Step 7: Commit**

```bash
git add apps/web-ui/lib/gateway/adapters/discord-adapter.ts apps/web-ui/tests/gateway/adapters/discord-adapter.test.ts
git commit -m "feat(gateway): narrate Discord Agent Ops runs as a running checklist"
```

---


## Manual verification (after all tasks land)

1. Set `CHATBOT_PERSONA_ENABLED=true` in the local `.env` (leave `CHATBOT_PERSONA_CHANNELS` unset — it defaults to Telegram).
2. `docker compose up -d postgres`, then `cd apps/web-ui && bun run dev`.
3. Message a connected Telegram bot with "hi" — confirm an immediate reply arrives and **no** new row appears in `AgentOpsRun` (check Prisma Studio or the Agent Ops dashboard).
4. Message it with a real task (e.g. "list my EC2 instances in us-east-1") — confirm the ack message edits in place into a `⏳`/`✅` checklist in plain English, that steps complete individually rather than all-but-one stranding at ⏳, that older steps collapse past 6, and that the final "Agent Ops Complete" summary is **not** subsequently overwritten by a stale checklist edit.
5. Reply "hi" while the run is asking a clarification question — confirm it is treated as an answer to that question (routed to `handleResume`), not as small talk.
6. With a Slack workspace connected and a bot token configured, run a task via slash command and confirm the same checklist behavior via `chat.update`. Slash commands themselves must still ack within Slack's 3s window (direct replies are intentionally not enabled for Slack).
7. With a Discord bot connected, run a task via slash command and confirm the deferred interaction message updates in place into the same checklist — and specifically that it never shows raw text like `[tool_call] execute_command`.
8. On Slack and Discord, send a greeting — it must still start a normal Agent Ops run (direct replies are Telegram-only by design; nothing should short-circuit there).
