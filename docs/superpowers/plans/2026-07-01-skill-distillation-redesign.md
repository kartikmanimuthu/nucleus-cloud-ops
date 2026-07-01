# Skill Distillation Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ground "convert chat to skill" distillation in the real tool calls made during a conversation, make the distillation prompt domain-agnostic instead of AWS/CloudOps-locked, and remove the hard 24k-character transcript truncation.

**Architecture:** A new pure function (`buildChatTranscript`) replaces the inline transcript-building code in the chat UI, now interleaving text and tool-invocation parts (capping only oversized individual tool *results*, never chat text). The `/api/skills/distill` route drops its character-slice truncation in favor of a pre-flight size guard that fails fast with a clear error, and its prompt is rewritten to infer domain/tools from the transcript instead of assuming AWS.

**Tech Stack:** Next.js 15 App Router API route, React 19 client component, TypeScript, Vitest (`apps/web-ui` test suite, `environment: 'node'`, `globals: true`, `@/*` alias to `apps/web-ui/`).

## Global Constraints

- No Prisma schema changes, no new UI fields — output contract stays `{ name, description, tier, content }`.
- The `tier` enum (`"read-only" | "mutation" | "approval-gated"`) is unchanged — it is also hardcoded as a Zod enum in `apps/web-ui/components/skills/skill-form-dialog.tsx:23`, so do not touch that file.
- `TOOL_RESULT_CHAR_CAP = 4000` — caps only individual tool *result* payloads; tool *args* and all chat text are never capped.
- `MAX_TRANSCRIPT_CHARS = 600_000` — server-side pre-flight guard in the distill route; returns HTTP 413 before any LLM call.
- Follow existing test conventions exactly: see `apps/web-ui/app/api/skills/route.test.ts` for the `next/server` mock pattern and `makeRequest` helper style used throughout `apps/web-ui/app/api/**/*.test.ts`.
- Design spec: `docs/superpowers/specs/2026-07-01-skill-distillation-redesign-design.md`.

---

### Task 1: `buildChatTranscript` pure function

**Files:**
- Create: `apps/web-ui/lib/agent/build-chat-transcript.ts`
- Test: `apps/web-ui/lib/agent/build-chat-transcript.test.ts`

**Interfaces:**
- Produces: `TOOL_RESULT_CHAR_CAP: number`, `ChatMessagePart` interface, `ChatMessageLike` interface, `buildChatTranscript(messages: ChatMessageLike[]): string` — all exported from `apps/web-ui/lib/agent/build-chat-transcript.ts`. Task 2 imports and calls `buildChatTranscript`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web-ui/lib/agent/build-chat-transcript.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildChatTranscript, TOOL_RESULT_CHAR_CAP, type ChatMessageLike } from './build-chat-transcript';

describe('buildChatTranscript', () => {
    it('includes text parts verbatim and untruncated', () => {
        const longText = 'a'.repeat(50_000);
        const messages: ChatMessageLike[] = [
            { role: 'user', parts: [{ type: 'text', text: longText }] },
        ];
        const result = buildChatTranscript(messages);
        expect(result).toBe(`USER: ${longText}`);
    });

    it('serializes a tool-invocation part with name, args, and result', () => {
        const messages: ChatMessageLike[] = [
            {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool-invocation',
                        toolCallId: 'call_1',
                        toolName: 'execute_command',
                        args: { command: 'aws ce get-cost-and-usage' },
                        result: 'ok',
                    },
                ],
            },
        ];
        const result = buildChatTranscript(messages);
        expect(result).toBe(
            'ASSISTANT: TOOL_CALL: execute_command({"command":"aws ce get-cost-and-usage"})\nTOOL_RESULT: ok',
        );
    });

    it('caps a large tool result but keeps args in full', () => {
        const bigArgValue = 'x'.repeat(4_500);
        const bigResult = 'y'.repeat(5_000);
        const messages: ChatMessageLike[] = [
            {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool-invocation',
                        toolCallId: 'call_2',
                        toolName: 'list_instances',
                        args: { note: bigArgValue },
                        result: bigResult,
                    },
                ],
            },
        ];
        const result = buildChatTranscript(messages);
        // args untouched, full length present
        expect(result).toContain(JSON.stringify({ note: bigArgValue }));
        // result capped at TOOL_RESULT_CHAR_CAP with a truncation marker
        expect(result).toContain('y'.repeat(TOOL_RESULT_CHAR_CAP));
        expect(result).not.toContain('y'.repeat(TOOL_RESULT_CHAR_CAP + 1));
        expect(result).toContain('[...truncated 1000 more chars]');
    });

    it('leaves a small tool result untouched', () => {
        const messages: ChatMessageLike[] = [
            {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool-invocation',
                        toolCallId: 'call_3',
                        toolName: 'get_status',
                        args: {},
                        result: 'all good',
                    },
                ],
            },
        ];
        const result = buildChatTranscript(messages);
        expect(result).toContain('TOOL_RESULT: all good');
        expect(result).not.toContain('truncated');
    });

    it('interleaves text and tool parts in original order', () => {
        const messages: ChatMessageLike[] = [
            {
                role: 'assistant',
                parts: [
                    { type: 'text', text: 'Checking costs now.' },
                    {
                        type: 'tool-invocation',
                        toolCallId: 'call_4',
                        toolName: 'get_cost',
                        args: {},
                        result: '$100',
                    },
                    { type: 'text', text: 'Total spend is $100.' },
                ],
            },
        ];
        const result = buildChatTranscript(messages);
        const idxA = result.indexOf('Checking costs now.');
        const idxTool = result.indexOf('TOOL_CALL: get_cost');
        const idxB = result.indexOf('Total spend is $100.');
        expect(idxA).toBeGreaterThanOrEqual(0);
        expect(idxTool).toBeGreaterThan(idxA);
        expect(idxB).toBeGreaterThan(idxTool);
    });

    it('falls back to message.content when parts is empty or absent', () => {
        const messages: ChatMessageLike[] = [{ role: 'user', content: 'hello there' }];
        const result = buildChatTranscript(messages);
        expect(result).toBe('USER: hello there');
    });

    it('derives tool name from a "tool-<name>" part type when toolName/name are absent', () => {
        const messages: ChatMessageLike[] = [
            {
                role: 'assistant',
                parts: [
                    {
                        type: 'tool-execute_command',
                        toolCallId: 'call_5',
                        args: { command: 'ls' },
                        result: 'file.txt',
                    },
                ],
            },
        ];
        const result = buildChatTranscript(messages);
        expect(result).toContain('TOOL_CALL: execute command({"command":"ls"})');
    });

    it('joins multiple messages with a blank line between them', () => {
        const messages: ChatMessageLike[] = [
            { role: 'user', parts: [{ type: 'text', text: 'Hi' }] },
            { role: 'assistant', parts: [{ type: 'text', text: 'Hello' }] },
        ];
        const result = buildChatTranscript(messages);
        expect(result).toBe('USER: Hi\n\nASSISTANT: Hello');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web-ui && bunx vitest run lib/agent/build-chat-transcript.test.ts`
Expected: FAIL — `Cannot find module './build-chat-transcript'` (file does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `apps/web-ui/lib/agent/build-chat-transcript.ts`:

```typescript
/**
 * build-chat-transcript.ts
 *
 * Pure function that flattens chat messages (text + tool-invocation parts) into
 * a single transcript string for skill distillation. Text is never truncated;
 * only oversized individual tool *results* are capped (args and all prose are
 * kept in full — see docs/superpowers/specs/2026-07-01-skill-distillation-redesign-design.md).
 */

/** Cap for a single tool result payload, in characters. Never applied to args or chat text. */
export const TOOL_RESULT_CHAR_CAP = 4000;

export interface ChatMessagePart {
    type: string;
    text?: string;
    toolName?: string;
    name?: string;
    toolCallId?: string;
    args?: unknown;
    input?: unknown;
    result?: unknown;
    output?: unknown;
}

export interface ChatMessageLike {
    role: string;
    parts?: ChatMessagePart[];
    content?: unknown;
}

function isToolPart(part: ChatMessagePart): boolean {
    return part.type === 'tool-invocation' || Boolean(part.toolCallId);
}

function stringifyValue(value: unknown): string {
    return typeof value === 'string' ? value : JSON.stringify(value);
}

function serializeToolPart(part: ChatMessagePart): string {
    let toolName = part.toolName || part.name;
    if (!toolName && part.type?.startsWith('tool-')) {
        toolName = part.type.replace('tool-', '').replace(/_/g, ' ');
    }
    toolName = toolName || 'tool';

    const args = part.args || part.input;
    const result = part.result || part.output;

    const argsStr = args === undefined ? '' : stringifyValue(args);
    let block = `TOOL_CALL: ${toolName}(${argsStr})`;

    if (result !== undefined) {
        let resultStr = stringifyValue(result);
        if (resultStr.length > TOOL_RESULT_CHAR_CAP) {
            const truncatedCount = resultStr.length - TOOL_RESULT_CHAR_CAP;
            resultStr = `${resultStr.slice(0, TOOL_RESULT_CHAR_CAP)}  [...truncated ${truncatedCount} more chars]`;
        }
        block += `\nTOOL_RESULT: ${resultStr}`;
    }

    return block;
}

/** Flattens messages into "ROLE: body" blocks joined by blank lines, preserving part order. */
export function buildChatTranscript(messages: ChatMessageLike[]): string {
    return messages
        .map((m) => {
            const segments: string[] = [];
            for (const part of m.parts ?? []) {
                if (part.type === 'text') {
                    if (part.text && part.text.trim().length > 0) {
                        segments.push(part.text);
                    }
                } else if (isToolPart(part)) {
                    segments.push(serializeToolPart(part));
                }
            }
            const body =
                segments.length > 0 ? segments.join('\n') : typeof m.content === 'string' ? m.content : '';
            return `${m.role.toUpperCase()}: ${body}`;
        })
        .join('\n\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web-ui && bunx vitest run lib/agent/build-chat-transcript.test.ts`
Expected: PASS — all 8 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/lib/agent/build-chat-transcript.ts apps/web-ui/lib/agent/build-chat-transcript.test.ts
git commit -m "$(cat <<'EOF'
feat(skills): add buildChatTranscript with tool-call grounding

Pure function replacing the text-only transcript builder used for skill
distillation. Interleaves text and tool-invocation parts in original order
so distillation sees real tool calls/results, not just narration. Only
oversized individual tool results are capped (4000 chars) — chat text and
tool args are never truncated.
EOF
)"
```

---

### Task 2: Wire `buildChatTranscript` into `handleSaveAsSkill`

**Files:**
- Modify: `apps/web-ui/components/agent/chat-interface.tsx:784-800`

**Interfaces:**
- Consumes: `buildChatTranscript(messages: ChatMessageLike[]): string` from `apps/web-ui/lib/agent/build-chat-transcript.ts` (Task 1).

- [ ] **Step 1: Add the import**

In `apps/web-ui/components/agent/chat-interface.tsx`, near the other `@/lib` imports (e.g. alongside the existing `import { cn } from "@/lib/utils";` at the top of the file), add:

```typescript
import { buildChatTranscript } from "@/lib/agent/build-chat-transcript";
```

- [ ] **Step 2: Replace the inline transcript-building code**

Find the current `handleSaveAsSkill` function:

```typescript
  const handleSaveAsSkill = async () => {
    if (messages.length === 0) return;
    const transcript = messages.map((m: any) => {
      const text = (m.parts ?? [])
        .filter((p: { type: string }) => p.type === "text")
        .map((p: { text?: string }) => p.text ?? "")
        .join("\n") || (typeof m.content === "string" ? m.content : "");
      return `${m.role.toUpperCase()}: ${text}`;
    }).join("\n\n");
    try {
      const draft = await distillSkill.mutateAsync({ threadId, transcript });
      setSkillDraft(draft);
      setSkillDialogOpen(true);
    } catch (e) {
      toast.error("Could not create skill from chat", { description: e instanceof Error ? e.message : "Try again" });
    }
  };
```

Replace it with:

```typescript
  const handleSaveAsSkill = async () => {
    if (messages.length === 0) return;
    const transcript = buildChatTranscript(messages as any);
    try {
      const draft = await distillSkill.mutateAsync({ threadId, transcript });
      setSkillDraft(draft);
      setSkillDialogOpen(true);
    } catch (e) {
      toast.error("Could not create skill from chat", { description: e instanceof Error ? e.message : "Try again" });
    }
  };
```

(`messages` from `useChat` is untyped as `any` throughout this file already — the `as any` cast matches the existing style at this call site and avoids fighting the AI SDK's message type here; `buildChatTranscript`'s own parameter and internals are fully typed.)

- [ ] **Step 3: Type-check**

Run: `cd apps/web-ui && bunx tsc --noEmit`
Expected: no new errors introduced by this file.

- [ ] **Step 4: Confirm no test regressions**

Run: `cd apps/web-ui && bun run test`
Expected: PASS — this file has no dedicated test suite today, so there are no direct tests to update; this step just confirms the change didn't break anything else (e.g. the `build-chat-transcript.test.ts` from Task 1 still passes).

- [ ] **Step 5: Commit**

```bash
git add apps/web-ui/components/agent/chat-interface.tsx
git commit -m "$(cat <<'EOF'
refactor(skills): use buildChatTranscript in handleSaveAsSkill

Replaces the inline text-only transcript builder with the shared pure
function so tool calls/results are included in skill distillation input.
EOF
)"
```

---

### Task 3: Domain-agnostic prompt, remove truncation, add size guard

**Files:**
- Modify: `apps/web-ui/app/api/skills/distill/route.ts`
- Create: `apps/web-ui/app/api/skills/distill/route.test.ts`

**Interfaces:**
- Consumes: `resolveDefaultModelConfig(tenantId: string): Promise<ResolvedModelConfig>` from `@/lib/agent/model-resolver`; `createAgentModels(config: ResolvedModelConfig): AgentModels` (where `AgentModels = { main: BaseChatModel; reflector: BaseChatModel }`) from `@/lib/agent/model-factory`; `isProviderConfigError(err: unknown): boolean` and `ProviderConfigError` from `@/lib/agent/provider-errors`.
- Produces: unchanged route contract — `POST` handler at `apps/web-ui/app/api/skills/distill/route.ts`, response shape `{ success: true, data: { name, description, tier, content } }` or `{ success: false, error }`. New behavior: 413 response when `transcript.length > MAX_TRANSCRIPT_CHARS`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web-ui/app/api/skills/distill/route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/server', () => ({
    NextRequest: vi.fn(),
    NextResponse: {
        json: vi.fn((data: unknown, init?: { status?: number }) => ({
            _data: data,
            _status: init?.status ?? 200,
            status: init?.status ?? 200,
            json: async () => data,
        })),
    },
}));

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/agent/model-resolver', () => ({ resolveDefaultModelConfig: vi.fn() }));
vi.mock('@/lib/agent/model-factory', () => ({ createAgentModels: vi.fn() }));

import { POST } from './route';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { resolveDefaultModelConfig } from '@/lib/agent/model-resolver';
import { createAgentModels } from '@/lib/agent/model-factory';
import { ProviderConfigError } from '@/lib/agent/provider-errors';

const makeRequest = (body?: unknown) => ({ json: vi.fn().mockResolvedValue(body ?? {}) }) as any;

const validDraftJson = JSON.stringify({
    name: 'Review Cost Trends',
    description: 'Use when asked to review AWS cost trends.',
    tier: 'read-only',
    content: '# Review Cost Trends\n1. Run `aws ce get-cost-and-usage`.',
});

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authorize).mockResolvedValue(null);
    vi.mocked(getSessionTenantId).mockResolvedValue('t1');
    vi.mocked(resolveDefaultModelConfig).mockResolvedValue({ provider: 'anthropic', modelId: 'm1' } as any);
});

describe('POST /api/skills/distill', () => {
    it('403s when authorize denies', async () => {
        vi.mocked(authorize).mockResolvedValue({ status: 403, _data: { error: 'Forbidden' }, _status: 403 } as any);
        const res = await POST(makeRequest({ transcript: 'USER: hi' }));
        expect(res).toEqual({ status: 403, _data: { error: 'Forbidden' }, _status: 403 });
    });

    it('400s on missing transcript', async () => {
        const res = await POST(makeRequest({}));
        expect((res as any)._status).toBe(400);
        expect((res as any)._data.success).toBe(false);
    });

    it('413s when transcript exceeds the size guard, without calling the model', async () => {
        const hugeTranscript = 'a'.repeat(600_001);
        const invoke = vi.fn();
        vi.mocked(createAgentModels).mockReturnValue({ main: { invoke }, reflector: {} } as any);
        const res = await POST(makeRequest({ transcript: hugeTranscript }));
        expect((res as any)._status).toBe(413);
        expect((res as any)._data.success).toBe(false);
        expect(invoke).not.toHaveBeenCalled();
    });

    it('sends the full transcript to the model with no truncation', async () => {
        const longTranscript = `USER: ${'b'.repeat(100_000)}`;
        const invoke = vi.fn().mockResolvedValue({ content: validDraftJson });
        vi.mocked(createAgentModels).mockReturnValue({ main: { invoke }, reflector: {} } as any);
        await POST(makeRequest({ transcript: longTranscript }));
        expect(invoke).toHaveBeenCalledOnce();
        const promptSent = invoke.mock.calls[0][0] as string;
        expect(promptSent).toContain(longTranscript);
    });

    it('returns the parsed draft on success', async () => {
        const invoke = vi.fn().mockResolvedValue({ content: validDraftJson });
        vi.mocked(createAgentModels).mockReturnValue({ main: { invoke }, reflector: {} } as any);
        const res = await POST(makeRequest({ transcript: 'USER: check my costs' }));
        expect((res as any)._status).toBe(200);
        expect((res as any)._data).toEqual({
            success: true,
            data: {
                name: 'Review Cost Trends',
                description: 'Use when asked to review AWS cost trends.',
                tier: 'read-only',
                content: '# Review Cost Trends\n1. Run `aws ce get-cost-and-usage`.',
            },
        });
    });

    it('502s when the model does not return valid JSON', async () => {
        const invoke = vi.fn().mockResolvedValue({ content: 'not json' });
        vi.mocked(createAgentModels).mockReturnValue({ main: { invoke }, reflector: {} } as any);
        const res = await POST(makeRequest({ transcript: 'USER: hi' }));
        expect((res as any)._status).toBe(502);
        expect((res as any)._data.success).toBe(false);
    });

    it('falls back to read-only when the model returns an invalid tier', async () => {
        const invoke = vi.fn().mockResolvedValue({
            content: JSON.stringify({ name: 'X', description: 'd', tier: 'nonsense', content: 'c' }),
        });
        vi.mocked(createAgentModels).mockReturnValue({ main: { invoke }, reflector: {} } as any);
        const res = await POST(makeRequest({ transcript: 'USER: hi' }));
        expect((res as any)._data.data.tier).toBe('read-only');
    });

    it('400s with the provider message when no default provider is configured', async () => {
        vi.mocked(resolveDefaultModelConfig).mockRejectedValue(new ProviderConfigError('No LLM provider is configured.'));
        const res = await POST(makeRequest({ transcript: 'USER: hi' }));
        expect((res as any)._status).toBe(400);
        expect((res as any)._data.error).toBe('No LLM provider is configured.');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web-ui && bunx vitest run app/api/skills/distill/route.test.ts`
Expected: FAIL — the 413 guard test and the no-truncation test fail against the current implementation (current code truncates to 24,000 chars and has no size guard), e.g. `expected 200 to be 413` and `expected [Function] to have been called with arguments matching ...`.

- [ ] **Step 3: Update the route implementation**

Replace the full contents of `apps/web-ui/app/api/skills/distill/route.ts` with:

```typescript
/**
 * POST /api/skills/distill — distil a chat transcript into a reusable skill draft (no persistence)
 */

import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { resolveDefaultModelConfig } from '@/lib/agent/model-resolver';
import { createAgentModels } from '@/lib/agent/model-factory';
import { isProviderConfigError } from '@/lib/agent/provider-errors';

/**
 * No per-model context-window figure is tracked anywhere in this codebase (the
 * `maxTokens` field on provider records is the output completion cap, not input
 * size). This is a conservative, provider-agnostic backstop against pathological
 * input (~150k tokens at ~4 chars/token) — comfortably under mainstream
 * 128k-200k-token context windows — not a routine limiter.
 */
const MAX_TRANSCRIPT_CHARS = 600_000;

const DISTILL_PROMPT = `You are distilling an AI agent's chat transcript into a reusable "skill" — a
generalized procedure the same agent can follow again for similar future requests.

The transcript may include TOOL_CALL / TOOL_RESULT blocks showing the exact
tools, commands, or API calls the agent actually used (AWS CLI, AWS SDK calls,
Slack/Jira/other MCP tool calls, file operations, etc.) — this platform is not
limited to any one domain. Infer the actual domain and tools from the
transcript itself; do not assume AWS or any other specific system.

Return ONLY a JSON object (no markdown fences) with keys:
- "name": short Title Case name (max 5 words)
- "description": one sentence describing when to use this skill
- "tier": one of "read-only" | "mutation" | "approval-gated" — pick based on
  what the actual tool calls did:
  - "read-only": every tool call only queried/read/listed state, nothing was
    changed anywhere
  - "mutation": at least one tool call created, updated, deleted, sent, or
    posted something in any external system (cloud resources, tickets,
    messages, files, etc.)
  - "approval-gated": the transcript shows a destructive/irreversible action,
    or the agent explicitly asked for human confirmation before proceeding
- "content": a markdown SKILL body with a one-line intro and a numbered,
  generalized step-by-step procedure GROUNDED in the actual tool calls made
  (name the real commands/API calls/tool names used, not generic UI
  navigation). Strip one-off identifiers (specific account/resource IDs,
  ticket numbers, usernames) and replace with placeholders — describe the
  repeatable method, not the one-off answer.

Transcript:
`;

export async function POST(request: NextRequest) {
    const authError = await authorize('create', 'Skill');
    if (authError) return authError;
    try {
        const tenantId = await getSessionTenantId();
        const body = await request.json();
        const { transcript } = body;
        if (!transcript || typeof transcript !== 'string') {
            return NextResponse.json(
                { success: false, error: 'Missing transcript' },
                { status: 400 }
            );
        }
        if (transcript.length > MAX_TRANSCRIPT_CHARS) {
            return NextResponse.json(
                {
                    success: false,
                    error: `This conversation is too long to distill in a single pass (~${Math.round(transcript.length / 1000)}k chars, limit ~${Math.round(MAX_TRANSCRIPT_CHARS / 1000)}k). Try a shorter portion of the chat, or configure a larger-context model as your tenant default.`,
                },
                { status: 413 }
            );
        }
        const modelConfig = await resolveDefaultModelConfig(tenantId);
        const { main } = createAgentModels(modelConfig);
        const resp = await main.invoke(`${DISTILL_PROMPT}\n${transcript}`);
        const raw = typeof resp.content === 'string' ? resp.content : JSON.stringify(resp.content);
        const jsonText = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
        let draft: { name?: string; description?: string; tier?: string; content?: string };
        try {
            draft = JSON.parse(jsonText);
        } catch {
            return NextResponse.json(
                { success: false, error: 'Model did not return valid JSON' },
                { status: 502 }
            );
        }
        const validTiers = ['read-only', 'mutation', 'approval-gated'];
        const tier = validTiers.includes(draft.tier ?? '') ? draft.tier : 'read-only';
        return NextResponse.json({
            success: true,
            data: {
                name: draft.name ?? 'Untitled Skill',
                description: draft.description ?? '',
                tier,
                content: draft.content ?? '',
            },
        });
    } catch (error) {
        if (isProviderConfigError(error)) {
            return NextResponse.json(
                { success: false, error: (error as Error).message },
                { status: 400 }
            );
        }
        console.error('[SkillsAPI] distill error:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to distill' },
            { status: 500 }
        );
    }
}
```

(Only three things changed from the original: `DISTILL_PROMPT`'s text, the removal of `.slice(0, 24000)` in the `main.invoke` call, and the new `MAX_TRANSCRIPT_CHARS` guard block. Everything else — imports, auth, JSON parsing, tier fallback, error handling — is untouched.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web-ui && bunx vitest run app/api/skills/distill/route.test.ts`
Expected: PASS — all 8 tests green.

- [ ] **Step 5: Run the full web-ui test suite**

Run: `cd apps/web-ui && bun run test`
Expected: PASS — no regressions in `app/api/skills/route.test.ts`, `app/api/skills/[id]/route.test.ts`, or elsewhere.

- [ ] **Step 6: Type-check**

Run: `cd apps/web-ui && bunx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web-ui/app/api/skills/distill/route.ts apps/web-ui/app/api/skills/distill/route.test.ts
git commit -m "$(cat <<'EOF'
feat(skills): make distillation domain-agnostic, drop hard truncation

- DISTILL_PROMPT no longer assumes AWS/CloudOps; it infers domain and
  tools from the transcript's TOOL_CALL/TOOL_RESULT blocks (AWS, Slack,
  Jira, or any MCP tool).
- Removes transcript.slice(0, 24000) — the full transcript is sent to
  the model, so a long conversation's resolution is no longer silently
  dropped.
- Adds a MAX_TRANSCRIPT_CHARS=600_000 pre-flight guard returning HTTP
  413 before any LLM call, since no per-model context-window figure is
  tracked in this codebase.
EOF
)"
```

---

## Post-Implementation Verification

- [ ] Run `cd apps/web-ui && bun run test` once more from a clean state — full suite green.
- [ ] Run `cd apps/web-ui && bun run lint` — no new lint errors in the three touched/created files.
- [ ] Manually exercise the flow: open a chat with at least one tool call (e.g. an `execute_command` AWS CLI call), click the Sparkles "Save as skill" button, and confirm the resulting draft's `content` references the actual command/tool used rather than generic console navigation.
