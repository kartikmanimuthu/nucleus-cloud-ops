import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionUserId: vi.fn(), getSessionTenantId: vi.fn() }));
vi.mock('@/lib/store/thread-store', () => ({ threadStore: { createThread: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@/lib/agent/model-resolver', () => ({ resolveModelConfig: vi.fn(), resolveDefaultModelConfig: vi.fn() }));
vi.mock('@/lib/agent/triage', () => ({ triageChatMessage: vi.fn() }));
vi.mock('./direct-chat', () => ({ respondDirect: vi.fn() }));
vi.mock('@/lib/agent/auto-kb-select', () => ({ resolveKnowledgeBaseIds: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/agent/thread-lock', () => ({
    acquireThreadLock: vi.fn(), releaseThreadLock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/agent/graph-factory', () => ({
    createReflectionGraph: vi.fn(), createFastGraph: vi.fn(), createDeepGraph: vi.fn(),
}));
vi.mock('@/lib/agent/langfuse-config', () => ({ getLangfuseCallbackHandler: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/db/repository-factory', () => ({
    getSubagentRunRepository: vi.fn().mockReturnValue({ save: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock('./decisions', () => ({ buildDecisionToolMessages: vi.fn() }));
vi.mock('@/lib/agent/guard', () => ({ pendingToolCallsOf: vi.fn().mockReturnValue([]) }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logAgentEvent: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@/lib/agent/persistence', () => ({
    getChatHistory: vi.fn().mockResolvedValue({ addMessages: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock('./deep-stream', () => ({ processDeepStream: vi.fn() }));
vi.mock('@/lib/agent/deep/hitl', () => ({
    hasPendingInterrupt: vi.fn(),
    pendingActions: vi.fn(),
    toResumeMap: vi.fn(),
    syntheticOutput: vi.fn(),
}));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionUserId, getSessionTenantId } from '@/lib/auth-session';
import { resolveModelConfig, resolveDefaultModelConfig } from '@/lib/agent/model-resolver';
import { triageChatMessage } from '@/lib/agent/triage';
import { respondDirect } from './direct-chat';
import { acquireThreadLock, releaseThreadLock } from '@/lib/agent/thread-lock';
import { createReflectionGraph, createFastGraph, createDeepGraph } from '@/lib/agent/graph-factory';
import { buildDecisionToolMessages } from './decisions';
import { pendingToolCallsOf } from '@/lib/agent/guard';
import { processDeepStream } from './deep-stream';
import { hasPendingInterrupt, pendingActions, toResumeMap, syntheticOutput } from '@/lib/agent/deep/hitl';
import { ProviderConfigError } from '@/lib/agent/provider-errors';
import { POST } from './route';

function makeGraph(overrides: Record<string, unknown> = {}) {
    return {
        getState: vi.fn().mockResolvedValue({ values: { messages: [] }, next: [] }),
        updateState: vi.fn().mockResolvedValue(undefined),
        streamEvents: vi.fn().mockReturnValue((async function* () { })()),
        invoke: vi.fn().mockResolvedValue({ messages: [{ content: 'Hi there', _getType: () => 'ai' }] }),
        ...overrides,
    };
}

function makeRequest(body: unknown) {
    return {
        json: vi.fn().mockResolvedValue(body),
        signal: new AbortController().signal,
    } as unknown as Request;
}

const BASE_BODY = { messages: [{ role: 'user', content: 'Hello' }] };

describe('POST /api/chat', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionUserId).mockResolvedValue('user-1');
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(acquireThreadLock).mockResolvedValue('lock-token');
        vi.mocked(resolveDefaultModelConfig).mockResolvedValue({ provider: 'bedrock', model: 'claude' } as any);
        vi.mocked(triageChatMessage).mockResolvedValue({ route: 'task', skillId: null } as any);
        vi.mocked(createReflectionGraph).mockResolvedValue(makeGraph() as any);
        vi.mocked(createFastGraph).mockResolvedValue(makeGraph() as any);
        vi.mocked(createDeepGraph).mockResolvedValue(makeGraph() as any);
        vi.mocked(pendingToolCallsOf).mockReturnValue([]);
        vi.mocked(buildDecisionToolMessages).mockReset();
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await POST(makeRequest(BASE_BODY));
        expect(res).toBe(authError);
    });

    it('returns 401 when the session cannot be resolved', async () => {
        vi.mocked(getSessionTenantId).mockRejectedValue(new Error('Unauthenticated'));
        const res = await POST(makeRequest(BASE_BODY));
        expect(res.status).toBe(401);
    });

    it('returns 403 when a namespaced threadId belongs to another tenant', async () => {
        const res = await POST(makeRequest({ ...BASE_BODY, threadId: 'other-tenant:user-1:123' }));
        const body = await res.json();
        expect(res.status).toBe(403);
        expect(body.error).toContain('another tenant');
    });

    it('returns 409 when the thread is already locked', async () => {
        vi.mocked(acquireThreadLock).mockResolvedValue(null);
        const res = await POST(makeRequest(BASE_BODY));
        expect(res.status).toBe(409);
    });

    it('returns 400 and releases the lock when model resolution fails with a provider config error', async () => {
        vi.mocked(resolveDefaultModelConfig).mockRejectedValue(new ProviderConfigError('No provider configured'));
        const res = await POST(makeRequest(BASE_BODY));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toBe('No provider configured');
        expect(releaseThreadLock).toHaveBeenCalledWith(expect.any(String), 'lock-token');
    });

    it('propagates a non-provider error from model resolution', async () => {
        vi.mocked(resolveDefaultModelConfig).mockRejectedValue(new Error('boom'));
        const res = await POST(makeRequest(BASE_BODY));
        expect(res.status).toBe(500);
    });

    it('routes to respondDirect when triage classifies the message as direct', async () => {
        vi.mocked(triageChatMessage).mockResolvedValue({ route: 'direct', skillId: null } as any);
        const directResponse = new Response('direct reply');
        vi.mocked(respondDirect).mockResolvedValue(directResponse);

        const res = await POST(makeRequest(BASE_BODY));
        expect(res).toBe(directResponse);
        expect(createReflectionGraph).not.toHaveBeenCalled();
    });

    it('returns 400 when an attachment is not an inline data URL', async () => {
        const res = await POST(makeRequest({
            messages: [{
                role: 'user', content: 'hi',
                experimental_attachments: [{ url: 'https://example.com/x.png', contentType: 'image/png' }],
            }],
        }));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toContain('inline data');
    });

    it('streams a plan-mode run and emits a placeholder + finish when the graph yields no events', async () => {
        const res = await POST(makeRequest(BASE_BODY));
        const text = await res.text();

        expect(res.headers.get('content-type')).toContain('text/event-stream');
        expect(text).toContain('"type":"start"');
        expect(text).toContain('"type":"finish"');
        expect(releaseThreadLock).toHaveBeenCalledWith(expect.any(String), 'lock-token');
    });

    it('streams text deltas and a tool call from the underlying LangGraph event stream', async () => {
        async function* events() {
            yield { event: 'on_chat_model_start', run_id: 'r1', metadata: { langgraph_node: 'agent' } };
            yield { event: 'on_chat_model_stream', run_id: 'r1', data: { chunk: { content: 'Hello world' } } };
            yield {
                event: 'on_chat_model_end', run_id: 'r1',
                data: { output: { tool_calls: [], usage_metadata: { input_tokens: 10, output_tokens: 5 } } },
            };
        }
        vi.mocked(createReflectionGraph).mockResolvedValue(makeGraph({
            streamEvents: vi.fn().mockReturnValue(events()),
        }) as any);

        const res = await POST(makeRequest(BASE_BODY));
        const text = await res.text();
        expect(text).toContain('Hello world');
    });

    it('uses fast mode graph when mode is "fast"', async () => {
        await POST(makeRequest({ ...BASE_BODY, mode: 'fast', stream: false }));
        expect(createFastGraph).toHaveBeenCalled();
        expect(createReflectionGraph).not.toHaveBeenCalled();
    });

    it('returns the assistant reply directly when stream is false', async () => {
        const res = await POST(makeRequest({ ...BASE_BODY, stream: false }));
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body).toEqual({ role: 'assistant', content: 'Hi there' });
        expect(releaseThreadLock).toHaveBeenCalled();
    });

    describe('resuming from per-tool decisions', () => {
        const RESUME_BODY = { ...BASE_BODY, decisions: [{ toolCallId: 'tc1', approved: true }] };

        it('returns 409 when no approval is pending on the thread', async () => {
            vi.mocked(createReflectionGraph).mockResolvedValue(makeGraph({
                getState: vi.fn().mockResolvedValue({ values: { messages: [] }, next: [] }),
            }) as any);

            const res = await POST(makeRequest(RESUME_BODY));
            expect(res.status).toBe(409);
        });

        it('returns 400 when the decisions do not map onto the pending tool calls', async () => {
            vi.mocked(createReflectionGraph).mockResolvedValue(makeGraph({
                getState: vi.fn().mockResolvedValue({ values: { messages: [] }, next: ['approval_gate'] }),
            }) as any);
            vi.mocked(pendingToolCallsOf).mockReturnValue([{ id: 'tc1', name: 'stop_ec2', args: {} }] as any);
            vi.mocked(buildDecisionToolMessages).mockReturnValue({ ok: false, error: 'Unknown toolCallId' } as any);

            const res = await POST(makeRequest(RESUME_BODY));
            const body = await res.json();
            expect(res.status).toBe(400);
            expect(body.error).toBe('Unknown toolCallId');
        });

        it('applies approved decisions and resumes the stream', async () => {
            const graph = makeGraph({
                getState: vi.fn().mockResolvedValue({ values: { messages: [], guardVerdicts: {} }, next: ['approval_gate'] }),
            });
            vi.mocked(createReflectionGraph).mockResolvedValue(graph as any);
            vi.mocked(pendingToolCallsOf).mockReturnValue([{ id: 'tc1', name: 'stop_ec2', args: {} }] as any);
            vi.mocked(buildDecisionToolMessages).mockReturnValue({
                ok: true, approvedIds: ['tc1'], toolMessages: [{ tool_call_id: 'tc1', content: 'ok' }],
            } as any);

            const res = await POST(makeRequest(RESUME_BODY));
            await res.text();
            expect(graph.updateState).toHaveBeenCalledWith(
                expect.anything(), { messages: [{ tool_call_id: 'tc1', content: 'ok' }] },
            );
        });
    });

    describe('resuming from a legacy tool-result message', () => {
        const TOOL_BODY = { messages: [...BASE_BODY.messages, { role: 'tool', toolCallId: 'tc1', content: 'Approved' }] };

        it('does not write a rejection ToolMessage when the user approved execution', async () => {
            const graph = makeGraph();
            vi.mocked(createReflectionGraph).mockResolvedValue(graph as any);

            const res = await POST(makeRequest(TOOL_BODY));
            await res.text();
            expect(graph.updateState).not.toHaveBeenCalled();
        });

        it('writes a rejection ToolMessage for any other content', async () => {
            const graph = makeGraph();
            vi.mocked(createReflectionGraph).mockResolvedValue(graph as any);

            const res = await POST(makeRequest({
                messages: [...BASE_BODY.messages, { role: 'tool', toolCallId: 'tc1', content: 'Cancelled by user' }],
            }));
            await res.text();
            expect(graph.updateState).toHaveBeenCalledWith(
                expect.anything(), { messages: [expect.objectContaining({ tool_call_id: 'tc1' })] },
            );
        });
    });

    it('dispatches deep mode through processDeepStream', async () => {
        const fakeDeepStream = new ReadableStream({ start(c) { c.close(); } });
        vi.mocked(processDeepStream).mockReturnValue(fakeDeepStream as any);

        const res = await POST(makeRequest({ ...BASE_BODY, mode: 'deep' }));
        await res.text();

        expect(createDeepGraph).toHaveBeenCalled();
        expect(processDeepStream).toHaveBeenCalledWith(expect.objectContaining({ threadId: expect.any(String) }));
    });

    it('skips the guard node model run but still counts a concurrent sub-agent run\'s usage', async () => {
        async function* events() {
            yield { event: 'on_chat_model_start', run_id: 'g1', metadata: { langgraph_node: 'guard' } };
            yield { event: 'on_chat_model_stream', run_id: 'g1', data: { chunk: { content: 'raw risk json' } } };
            yield { event: 'on_chat_model_end', run_id: 'g1', metadata: { langgraph_node: 'guard' }, data: { output: {} } };
            yield {
                // 'nucleus-subagent' is SUBAGENT_MODEL_TAG (lib/agent/subagent.ts) — the tag
                // isSubagentModelEvent actually matches. An earlier version of this fixture used
                // an unrelated string here, so it never exercised the sub-agent usage branch this
                // test is named for even though the (unrelated) guard assertion still passed.
                event: 'on_chat_model_end', run_id: 's1', tags: ['nucleus-subagent'],
                data: { output: { usage_metadata: { input_tokens: 3, output_tokens: 2 } } },
            };
        }
        vi.mocked(createReflectionGraph).mockResolvedValue(makeGraph({
            streamEvents: vi.fn().mockReturnValue(events()),
        }) as any);

        const res = await POST(makeRequest(BASE_BODY));
        const text = await res.text();
        expect(text).not.toContain('raw risk json');
        expect(text).toContain('"type":"data-usage"');
        expect(text).toContain('"input":3');
        expect(text).toContain('"output":2');
    });

    it('emits a data-memory part for a memory_recall run instead of a reasoning block', async () => {
        async function* events() {
            yield { event: 'on_chat_model_start', run_id: 'm1', metadata: { langgraph_node: 'memory_recall' } };
            yield { event: 'on_chat_model_stream', run_id: 'm1', data: { chunk: { content: 'Recalled a prior preference' } } };
            yield { event: 'on_chat_model_end', run_id: 'm1', data: { output: {} } };
        }
        vi.mocked(createReflectionGraph).mockResolvedValue(makeGraph({
            streamEvents: vi.fn().mockReturnValue(events()),
        }) as any);

        const res = await POST(makeRequest(BASE_BODY));
        const text = await res.text();
        expect(text).toContain('data-memory');
        expect(text).toContain('Recalled a prior preference');
    });

    it('buffers a reflection run and humanizes it into one reasoning block at run end', async () => {
        async function* events() {
            yield { event: 'on_chat_model_start', run_id: 'r1', metadata: { langgraph_node: 'reflect' } };
            yield { event: 'on_chat_model_stream', run_id: 'r1', data: { chunk: { content: '{"issues": []}' } } };
            yield { event: 'on_chat_model_end', run_id: 'r1', data: { output: {} } };
        }
        vi.mocked(createReflectionGraph).mockResolvedValue(makeGraph({
            streamEvents: vi.fn().mockReturnValue(events()),
        }) as any);

        const res = await POST(makeRequest(BASE_BODY));
        const text = await res.text();
        expect(text).toContain('reasoning-start');
        expect(text).not.toContain('{"issues"');
    });

    it('streams a tool-free execution run live as prose text', async () => {
        async function* events() {
            yield { event: 'on_chat_model_start', run_id: 'e1', metadata: { langgraph_node: 'generate' } };
            yield { event: 'on_chat_model_stream', run_id: 'e1', data: { chunk: { content: 'The answer is 42.' } } };
            yield { event: 'on_chat_model_end', run_id: 'e1', data: { output: {} } };
        }
        vi.mocked(createReflectionGraph).mockResolvedValue(makeGraph({
            streamEvents: vi.fn().mockReturnValue(events()),
        }) as any);

        const res = await POST(makeRequest(BASE_BODY));
        const text = await res.text();
        expect(text).toContain('The answer is 42.');
    });

    it('with autoApprove disabled, emits tool-input at model end and pairs the output by tool name at on_tool_end', async () => {
        async function* events() {
            yield { event: 'on_chat_model_start', run_id: 'a1', metadata: { langgraph_node: 'generate' } };
            yield {
                event: 'on_chat_model_end', run_id: 'a1',
                data: { output: { tool_calls: [{ id: 'tc1', name: 'stop_ec2', args: { id: 'i-1' } }] } },
            };
            yield { event: 'on_tool_end', run_id: 'run-xyz', name: 'stop_ec2', data: { output: { content: 'stopped' } } };
        }
        vi.mocked(createReflectionGraph).mockResolvedValue(makeGraph({
            streamEvents: vi.fn().mockReturnValue(events()),
        }) as any);

        const res = await POST(makeRequest({ ...BASE_BODY, autoApprove: false }));
        const text = await res.text();
        expect(text).toContain('"toolCallId":"tc1"');
        expect(text).toContain('"output":"stopped"');
    });

    it('re-emits an initial resume banner and pairs tool output by the original toolCallId when resuming from HITL approval', async () => {
        async function* events() {
            yield { event: 'on_tool_start', run_id: 'run-1', name: 'stop_ec2', data: { input: { id: 'i-1' } } };
            yield { event: 'on_tool_end', run_id: 'run-1', name: 'stop_ec2', data: { output: { content: 'stopped', tool_call_id: 'tc-original' } } };
        }
        const graph = makeGraph({ streamEvents: vi.fn().mockReturnValue(events()) });
        vi.mocked(createReflectionGraph).mockResolvedValue(graph as any);
        vi.mocked(pendingToolCallsOf).mockReturnValue([{ id: 'tc-original', name: 'stop_ec2', args: { id: 'i-1' } }] as any);

        const res = await POST(makeRequest({
            messages: [{ role: 'user', content: 'Hello' }, { role: 'tool', toolCallId: 'tc-original', content: 'Approved' }],
            autoApprove: false,
        }));
        const text = await res.text();
        expect(text).toContain('Executing approved tool(s)');
        expect(text).toContain('"toolCallId":"tc-original"');
        expect(text).toContain('"output":"stopped"');
    });

    it('emits a plan part on a whitelisted node\'s on_chain_end when the output carries a plan', async () => {
        async function* events() {
            yield {
                event: 'on_chain_end', metadata: { langgraph_node: 'planner' },
                data: { output: { plan: [{ step: 1, description: 'Do the thing' }] } },
            };
        }
        vi.mocked(createReflectionGraph).mockResolvedValue(makeGraph({
            streamEvents: vi.fn().mockReturnValue(events()),
        }) as any);

        const res = await POST(makeRequest(BASE_BODY));
        const text = await res.text();
        expect(text).toContain('data-plan');
    });

    it('closes cleanly with no error part when the stream aborts', async () => {
        async function* events(): AsyncGenerator<any> {
            const err = new Error('Aborted');
            err.name = 'AbortError';
            throw err;
        }
        vi.mocked(createReflectionGraph).mockResolvedValue(makeGraph({
            streamEvents: vi.fn().mockReturnValue(events()),
        }) as any);

        const res = await POST(makeRequest(BASE_BODY));
        const text = await res.text();
        expect(text).not.toContain('"type":"error"');
    });

    it('emits an error part when the stream throws a non-abort error', async () => {
        async function* events(): AsyncGenerator<any> {
            throw new Error('LLM provider unavailable');
        }
        vi.mocked(createReflectionGraph).mockResolvedValue(makeGraph({
            streamEvents: vi.fn().mockReturnValue(events()),
        }) as any);

        const res = await POST(makeRequest(BASE_BODY));
        const text = await res.text();
        expect(text).toContain('"type":"error"');
    });

    it('emits interrupt parts when the run parks at the approval_gate', async () => {
        const graph = makeGraph({
            streamEvents: vi.fn().mockReturnValue((async function* () { })()),
            getState: vi.fn().mockResolvedValue({
                next: ['approval_gate'],
                values: { messages: [], pendingToolCalls: [{ id: 'tc1', name: 'stop_ec2', args: {} }] },
            }),
        });
        vi.mocked(createReflectionGraph).mockResolvedValue(graph as any);

        const res = await POST(makeRequest(BASE_BODY));
        const text = await res.text();
        expect(text.length).toBeGreaterThan(0);
    });

    it('returns 500 for an unexpected error', async () => {
        vi.mocked(createReflectionGraph).mockRejectedValue(new Error('graph explosion'));
        const res = await POST(makeRequest(BASE_BODY));
        const body = await res.json();
        expect(res.status).toBe(500);
        expect(body.error).toBe('graph explosion');
        expect(releaseThreadLock).toHaveBeenCalled();
    });

    it('returns 400 when a message has too many attachments', async () => {
        const atts = Array.from({ length: 6 }, () => ({ url: 'data:image/png;base64,AAA', contentType: 'image/png' }));
        const res = await POST(makeRequest({ messages: [{ role: 'user', content: 'hi', experimental_attachments: atts }] }));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toContain('Too many attachments');
    });

    it('returns 400 when an attachment is not an image', async () => {
        const res = await POST(makeRequest({
            messages: [{ role: 'user', content: 'hi', experimental_attachments: [{ url: 'data:application/pdf;base64,AAA' }] }],
        }));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toContain('Only image attachments');
    });

    it('returns 400 when an attachment exceeds the 5MB limit', async () => {
        const hugeBase64 = 'A'.repeat(8_000_000); // ~6MB decoded
        const res = await POST(makeRequest({
            messages: [{ role: 'user', content: 'hi', experimental_attachments: [{ url: `data:image/png;base64,${hugeBase64}` }] }],
        }));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toContain('5MB limit');
    });

    it('logs the selected accounts and adopts the skill triage auto-selected', async () => {
        vi.mocked(triageChatMessage).mockResolvedValue({ route: 'task', skillId: 'auto-skill' } as any);
        const res = await POST(makeRequest({
            ...BASE_BODY,
            accounts: [{ accountId: 'acc-1', accountName: 'Prod' }],
        }));
        const text = await res.text();
        expect(text).toContain('data-skill');
        expect(text).toContain('auto-skill');
    });

    it('renders every phase marker node getPhaseFromNode maps, including the deep-memory-middleware and default cases', async () => {
        async function* events() {
            const nodes = [
                'DeepMemoryMiddleware.beforeAgent', 'DeepMemoryMiddleware.afterAgent',
                'planner', 'revise', 'final', 'finalize', 'call_model', 'tools', 'approval_gate',
                'memory_save', 'some-unrecognized-node',
            ];
            for (const [i, node] of nodes.entries()) {
                yield { event: 'on_chat_model_start', run_id: `r${i}`, metadata: { langgraph_node: node } };
                yield { event: 'on_chat_model_end', run_id: `r${i}`, data: { output: {} } };
            }
        }
        vi.mocked(createReflectionGraph).mockResolvedValue(makeGraph({
            streamEvents: vi.fn().mockReturnValue(events()),
        }) as any);

        const res = await POST(makeRequest(BASE_BODY));
        const text = await res.text();
        expect(text).toContain('data-phase');
        expect(text).toContain('"phase":"memory_recall"');
        expect(text).toContain('"phase":"memory_save"');
        expect(text).toContain('"phase":"planning"');
        expect(text).toContain('"phase":"final"');
        expect(text).toContain('"phase":"text"');
        expect(text).toContain('"phase":"execution"');
    });

    it('emits a subagent progress part and persists its run once it reaches a terminal state', async () => {
        const res = await POST(makeRequest(BASE_BODY));
        const graphConfig = vi.mocked(createReflectionGraph).mock.calls[0][0] as any;

        graphConfig.onMemoryEvent('recall', 'Recalled a preference');
        graphConfig.onSubagentEvent({
            id: 'sa-1', role: 'EC2 auditor', task: 'audit account', status: 'done',
            toolCount: 2, tokensIn: 10, tokensOut: 5, summary: 'found things',
        });

        const text = await res.text();
        expect(text).toContain('data-subagent');
        expect(text).toContain('data-memory');
        expect(text).toContain('Recalled a preference');
    });

    it('persists a chat-history final state that tags a reflection AI message and includes buffered memory text', async () => {
        const finalMessages = [
            { _getType: () => 'human', content: 'Do the thing' },
            { _getType: () => 'ai', content: 'raw reflector output', tool_calls: [], response_metadata: { agentPhase: 'reflection' } },
        ];
        const graph = makeGraph({
            streamEvents: vi.fn().mockReturnValue((async function* () {
                yield { event: 'on_chat_model_start', run_id: 'm1', metadata: { langgraph_node: 'memory_recall' } };
                yield { event: 'on_chat_model_stream', run_id: 'm1', data: { chunk: { content: 'Recalled X' } } };
                yield { event: 'on_chat_model_end', run_id: 'm1', data: { output: {} } };
                yield { event: 'on_chat_model_start', run_id: 'r1', metadata: { langgraph_node: 'reflect' } };
                yield { event: 'on_chat_model_stream', run_id: 'r1', data: { chunk: { content: '{"issues":[]}' } } };
                yield { event: 'on_chat_model_end', run_id: 'r1', data: { output: { usage_metadata: { input_tokens: 7, output_tokens: 3 } } } };
            })()),
            getState: vi.fn()
                .mockResolvedValueOnce({ values: { messages: [] }, next: [] }) // pre-run count
                .mockResolvedValue({ values: { messages: finalMessages }, next: [] }), // post-run state(s)
        });
        vi.mocked(createReflectionGraph).mockResolvedValue(graph as any);

        const { getChatHistory } = await import('@/lib/agent/persistence');
        const chatHistory = await getChatHistory();

        const res = await POST(makeRequest(BASE_BODY));
        await res.text();

        expect(chatHistory.addMessages).toHaveBeenCalledWith(
            'tenant-1', 'user-1', expect.any(String),
            expect.arrayContaining([
                expect.objectContaining({ role: 'ai', content: expect.stringContaining('REFLECTION_PHASE_START') }),
                expect.objectContaining({ role: 'ai', content: expect.stringContaining('MEMORY_RECALL_PHASE_START') }),
            ]),
            expect.any(String),
        );
    });

    describe('resuming a deep-mode run from decisions', () => {
        const DEEP_RESUME_BODY = { ...BASE_BODY, mode: 'deep', decisions: [{ toolCallId: 'tc1', approved: true }] };

        it('returns 409 when there is no pending deep interrupt', async () => {
            vi.mocked(hasPendingInterrupt).mockReturnValue(false);
            const res = await POST(makeRequest(DEEP_RESUME_BODY));
            expect(res.status).toBe(409);
        });

        it('returns 400 when the deep decisions do not map onto the pending actions', async () => {
            vi.mocked(hasPendingInterrupt).mockReturnValue(true);
            vi.mocked(pendingActions).mockReturnValue([{ toolCallId: 'tc1', toolName: 'stop_ec2', args: {} } as any]);
            vi.mocked(toResumeMap).mockReturnValue({ ok: false, error: 'Unknown interrupt' } as any);

            const res = await POST(makeRequest(DEEP_RESUME_BODY));
            const body = await res.json();
            expect(res.status).toBe(400);
            expect(body.error).toBe('Unknown interrupt');
        });

        it('resumes with a Command carrying the mapped decisions', async () => {
            vi.mocked(hasPendingInterrupt).mockReturnValue(true);
            vi.mocked(pendingActions).mockReturnValue([{ toolCallId: 'tc1', toolName: 'stop_ec2', args: {} } as any]);
            vi.mocked(toResumeMap).mockReturnValue({ ok: true, resume: { 'int-1': { decisions: [] } } } as any);
            vi.mocked(syntheticOutput).mockReturnValue('approved');
            const fakeDeepStream = new ReadableStream({ start(c) { c.close(); } });
            vi.mocked(processDeepStream).mockReturnValue(fakeDeepStream as any);

            const res = await POST(makeRequest(DEEP_RESUME_BODY));
            await res.text();

            expect(processDeepStream).toHaveBeenCalled();
        });
    });

    describe('persistDeepHistory (invoked via deep-mode onFinish)', () => {
        async function runDeepAndCapture(getState: ReturnType<typeof vi.fn>) {
            vi.mocked(createDeepGraph).mockResolvedValue(makeGraph({ getState }) as any);
            const fakeDeepStream = new ReadableStream({ start(c) { c.close(); } });
            vi.mocked(processDeepStream).mockReturnValue(fakeDeepStream as any);

            const res = await POST(makeRequest({ ...BASE_BODY, mode: 'deep' }));
            await res.text();

            return vi.mocked(processDeepStream).mock.calls[0][0] as {
                onFinish: () => Promise<void>;
                onUsage: (input: number, output: number) => void;
                onMemoryText: (op: 'recall' | 'save', text: string) => void;
            };
        }

        it('persists new messages, tagging tool_calls/tool_call_id metadata and usage on the last AI message', async () => {
            const finalMessages = [
                { _getType: () => 'human', content: 'Start the ec2 instance' },
                { _getType: () => 'ai', content: 'calling stop_ec2', tool_calls: [{ id: 'tc1', name: 'stop_ec2', args: {} }] },
                { _getType: () => 'tool', content: 'stopped', tool_call_id: 'tc1' },
                { _getType: () => 'ai', content: 'Done — instance stopped.' },
            ];
            const getState = vi.fn()
                .mockResolvedValueOnce({ values: { messages: [] }, next: [] }) // pre-run count
                .mockResolvedValue({ values: { messages: finalMessages }, next: [] });
            const { onFinish, onUsage } = await runDeepAndCapture(getState);

            const { getChatHistory } = await import('@/lib/agent/persistence');
            const chatHistory = await getChatHistory();
            vi.mocked(chatHistory.addMessages).mockClear();

            onUsage(10, 5);
            await onFinish();

            expect(chatHistory.addMessages).toHaveBeenCalledWith(
                'tenant-1', 'user-1', expect.any(String),
                [
                    { role: 'human', content: 'Start the ec2 instance', metadata: undefined },
                    { role: 'ai', content: 'calling stop_ec2', metadata: { tool_calls: [{ id: 'tc1', name: 'stop_ec2', args: {} }] } },
                    { role: 'tool', content: 'stopped', metadata: { tool_call_id: 'tc1' } },
                    { role: 'ai', content: 'Done — instance stopped.', metadata: { usage_metadata: { input_tokens: 10, output_tokens: 5 } } },
                ],
                'Start the ec2 instance',
            );
        });

        it('does nothing when the run added no new messages and no memory narration was buffered', async () => {
            const getState = vi.fn().mockResolvedValue({ values: { messages: [] }, next: [] });
            const { onFinish } = await runDeepAndCapture(getState);

            const { getChatHistory } = await import('@/lib/agent/persistence');
            const chatHistory = await getChatHistory();
            vi.mocked(chatHistory.addMessages).mockClear();

            await onFinish();
            expect(chatHistory.addMessages).not.toHaveBeenCalled();
        });

        it('persists marker-prefixed memory rows (recall first, save last) even with no new graph messages, titling "New Chat"', async () => {
            const getState = vi.fn().mockResolvedValue({ values: { messages: [] }, next: [] });
            const { onFinish, onMemoryText } = await runDeepAndCapture(getState);

            const { getChatHistory } = await import('@/lib/agent/persistence');
            const chatHistory = await getChatHistory();
            vi.mocked(chatHistory.addMessages).mockClear();

            onMemoryText('recall', 'Recalled a preference');
            onMemoryText('save', 'Saved a new fact');
            await onFinish();

            expect(chatHistory.addMessages).toHaveBeenCalledWith(
                'tenant-1', 'user-1', expect.any(String),
                [
                    expect.objectContaining({ role: 'ai', content: expect.stringContaining('Recalled a preference') }),
                    expect.objectContaining({ role: 'ai', content: expect.stringContaining('Saved a new fact') }),
                ],
                'New Chat',
            );
        });

        it('logs and swallows a persistence failure instead of throwing', async () => {
            const errSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
            const finalMessages = [{ _getType: () => 'human', content: 'hi' }];
            const getState = vi.fn()
                .mockResolvedValueOnce({ values: { messages: [] }, next: [] })
                .mockResolvedValue({ values: { messages: finalMessages }, next: [] });
            const { onFinish } = await runDeepAndCapture(getState);

            const { getChatHistory } = await import('@/lib/agent/persistence');
            const chatHistory = await getChatHistory();
            vi.mocked(chatHistory.addMessages).mockRejectedValueOnce(new Error('db down'));

            await expect(onFinish()).resolves.toBeUndefined();
            expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('failed to persist history:'), expect.any(Error));
        });
    });

    describe('v2 stream defense-in-depth catches and finally-block persistence', () => {
        it('logs and continues past an individual stream-event processing error', async () => {
            const errSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
            async function* events() {
                const poison = { event: 'on_chat_model_start', run_id: 'p1' };
                Object.defineProperty(poison, 'metadata', { get() { throw new Error('boom'); } });
                yield poison;
                yield { event: 'on_chat_model_start', run_id: 'r2', metadata: { langgraph_node: 'agent' } };
                yield { event: 'on_chat_model_stream', run_id: 'r2', data: { chunk: { content: 'still works' } } };
                yield { event: 'on_chat_model_end', run_id: 'r2', data: { output: {} } };
            }
            vi.mocked(createReflectionGraph).mockResolvedValue(makeGraph({
                streamEvents: vi.fn().mockReturnValue(events()),
            }) as any);

            const res = await POST(makeRequest(BASE_BODY));
            const text = await res.text();
            expect(text).toContain('still works');
            expect(errSpy).toHaveBeenCalledWith('Stream event processing error:', expect.any(Error));
        });

        it('warns and continues when checking for a parked approval_gate interrupt fails', async () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
            const getState = vi.fn()
                .mockResolvedValueOnce({ values: { messages: [] }, next: [] })   // pre-run count
                .mockRejectedValueOnce(new Error('state unavailable'))           // approval_gate parked-check
                .mockResolvedValue({ values: { messages: [] }, next: [] });      // finally-block persistence
            vi.mocked(createReflectionGraph).mockResolvedValue(makeGraph({ getState }) as any);

            const res = await POST(makeRequest(BASE_BODY));
            const text = await res.text();
            expect(text).toContain('"type":"finish"');
            expect(warnSpy).toHaveBeenCalledWith('[Chat API] interrupt part emission failed (non-fatal):', expect.any(Error));
        });

        it('tags tool messages with tool_call_id and appends a memory_save marker in the v2 persistence path', async () => {
            const finalMessages = [
                { _getType: () => 'human', content: 'do it' },
                // Tagged 'text' so the positional phaseList fallback (which would otherwise map
                // this message onto the single streamed memory_save run below) is short-circuited —
                // isolates the tool_calls/tool_call_id tagging from the separate memorySaveText marker.
                { _getType: () => 'ai', content: 'calling tool', tool_calls: [{ id: 'tc9', name: 'x', args: {} }], response_metadata: { agentPhase: 'text' } },
                { _getType: () => 'tool', content: 'tool result', tool_call_id: 'tc9' },
            ];
            async function* events() {
                yield { event: 'on_chat_model_start', run_id: 'm1', metadata: { langgraph_node: 'memory_save' } };
                yield { event: 'on_chat_model_stream', run_id: 'm1', data: { chunk: { content: 'Saved a fact' } } };
                yield { event: 'on_chat_model_end', run_id: 'm1', data: { output: {} } };
            }
            const getState = vi.fn()
                .mockResolvedValueOnce({ values: { messages: [] }, next: [] })
                .mockResolvedValue({ values: { messages: finalMessages }, next: [] });
            vi.mocked(createReflectionGraph).mockResolvedValue(makeGraph({
                streamEvents: vi.fn().mockReturnValue(events()), getState,
            }) as any);

            const { getChatHistory } = await import('@/lib/agent/persistence');
            const chatHistory = await getChatHistory();
            vi.mocked(chatHistory.addMessages).mockClear();

            const res = await POST(makeRequest(BASE_BODY));
            await res.text();

            expect(chatHistory.addMessages).toHaveBeenCalledWith(
                'tenant-1', 'user-1', expect.any(String),
                expect.arrayContaining([
                    expect.objectContaining({ role: 'ai', content: 'calling tool', metadata: { tool_calls: [{ id: 'tc9', name: 'x', args: {} }] } }),
                    expect.objectContaining({ role: 'tool', content: 'tool result', metadata: { tool_call_id: 'tc9' } }),
                    expect.objectContaining({ role: 'ai', content: expect.stringContaining('MEMORY_SAVE_PHASE_START') }),
                ]),
                'do it',
            );
        });

        it('logs and swallows a v2 persistence failure instead of throwing', async () => {
            const errSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
            const finalMessages = [
                { _getType: () => 'human', content: 'hi' },
                { _getType: () => 'ai', content: 'hey' },
            ];
            const getState = vi.fn()
                .mockResolvedValueOnce({ values: { messages: [] }, next: [] })
                .mockResolvedValue({ values: { messages: finalMessages }, next: [] });
            vi.mocked(createReflectionGraph).mockResolvedValue(makeGraph({ getState }) as any);

            const { getChatHistory } = await import('@/lib/agent/persistence');
            const chatHistory = await getChatHistory();
            vi.mocked(chatHistory.addMessages).mockRejectedValueOnce(new Error('db down'));

            const res = await POST(makeRequest(BASE_BODY));
            await expect(res.text()).resolves.toEqual(expect.any(String));
            expect(errSpy).toHaveBeenCalledWith('[Chat API] Failed to persist message history:', expect.any(Error));
        });

        it('prepends the positional phase marker (planning/execution/revision/final) to untagged AI messages', async () => {
            const nodes = ['planner', 'generate', 'revise', 'final'];
            async function* events() {
                for (const node of nodes) {
                    yield { event: 'on_chat_model_start', run_id: node, metadata: { langgraph_node: node } };
                    yield { event: 'on_chat_model_stream', run_id: node, data: { chunk: { content: `${node} text` } } };
                    yield { event: 'on_chat_model_end', run_id: node, data: { output: {} } };
                }
            }
            const finalMessages = nodes.map((n, i) => ({ _getType: () => 'ai', content: `${n} text ${i}` }));
            const getState = vi.fn()
                .mockResolvedValueOnce({ values: { messages: [] }, next: [] })
                .mockResolvedValue({ values: { messages: finalMessages }, next: [] });
            vi.mocked(createReflectionGraph).mockResolvedValue(makeGraph({
                streamEvents: vi.fn().mockReturnValue(events()), getState,
            }) as any);

            const { getChatHistory } = await import('@/lib/agent/persistence');
            const chatHistory = await getChatHistory();
            vi.mocked(chatHistory.addMessages).mockClear();

            const res = await POST(makeRequest(BASE_BODY));
            await res.text();

            const mapped = vi.mocked(chatHistory.addMessages).mock.calls[0][3] as Array<{ content: string }>;
            expect(mapped.map(m => m.content)).toEqual([
                'PLANNING_PHASE_START\nplanner text 0',
                'EXECUTION_PHASE_START\ngenerate text 1',
                'REVISION_PHASE_START\nrevise text 2',
                'FINAL_PHASE_START\nfinal text 3',
            ]);
        });

        it('returns 500 (with the still-default no-op releaseLock) when the request body cannot be parsed', async () => {
            const req = { json: vi.fn().mockRejectedValue(new Error('bad json')), signal: new AbortController().signal } as unknown as Request;
            const res = await POST(req);
            expect(res.status).toBe(500);
            // acquireThreadLock never ran, so releaseLock is still the no-op declared at the top —
            // reaching here without throwing is the assertion that it's safely callable.
            expect(releaseThreadLock).not.toHaveBeenCalled();
        });

        it('joins array-shaped chunk content (multi-part deltas) into one text delta', async () => {
            async function* events() {
                yield { event: 'on_chat_model_start', run_id: 'r1', metadata: { langgraph_node: 'agent' } };
                yield {
                    event: 'on_chat_model_stream', run_id: 'r1',
                    data: { chunk: { content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }, { type: 'other', text: 'ignored' }] } },
                };
                yield { event: 'on_chat_model_end', run_id: 'r1', data: { output: {} } };
            }
            vi.mocked(createReflectionGraph).mockResolvedValue(makeGraph({
                streamEvents: vi.fn().mockReturnValue(events()),
            }) as any);

            const res = await POST(makeRequest(BASE_BODY));
            const text = await res.text();
            expect(text).toContain('Hello world');
            expect(text).not.toContain('ignored');
        });

        it('reconstructs attachments-with-parts, assistant tool_calls, and a tool result, falling back to HumanMessage for an unrecognized role when the last message is not user', async () => {
            const priorState = { values: { messages: [{ _getType: () => 'human', content: 'earlier turn' }] }, next: [] };
            const streamEvents = vi.fn().mockReturnValue((async function* () { })());
            vi.mocked(createReflectionGraph).mockResolvedValue(makeGraph({
                getState: vi.fn().mockResolvedValue(priorState), streamEvents,
            }) as any);
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });

            const messages = [
                { role: 'user', parts: [{ type: 'text', text: 'look at this' }], experimental_attachments: [{ url: 'data:image/png;base64,abcd', contentType: 'image/png' }] },
                { role: 'assistant', content: 'calling a tool', toolInvocations: [{ toolName: 'stop_ec2', args: { instanceId: 'i-1' }, toolCallId: 'tc1' }] },
                { role: 'tool', content: 'result text', toolCallId: 'tc1' },
                { role: 'system', content: 'some system note' },
            ];

            const res = await POST(makeRequest({ messages }));
            await res.text();

            expect(warnSpy).toHaveBeenCalledWith('[API] Unexpected: Last message is not user on a running thread.');

            const input = streamEvents.mock.calls[0][0] as { messages: any[] };
            expect(input.messages).toHaveLength(4);
            expect(input.messages[0].content).toEqual([
                { type: 'text', text: 'look at this' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,abcd' } },
            ]);
            expect(input.messages[1].tool_calls).toEqual([{ name: 'stop_ec2', args: { instanceId: 'i-1' }, id: 'tc1', type: 'tool_call' }]);
            expect(input.messages[2].tool_call_id).toBe('tc1');
            expect(input.messages[2].content).toBe('result text');
            expect(input.messages[3]._getType()).toBe('human');
            expect(input.messages[3].content).toBe('some system note');
        });

        it('aborts the graph run when the client disconnects', async () => {
            const streamEvents = vi.fn().mockReturnValue((async function* () { })());
            vi.mocked(createReflectionGraph).mockResolvedValue(makeGraph({ streamEvents }) as any);
            const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
            const controller = new AbortController();

            const req = { json: vi.fn().mockResolvedValue(BASE_BODY), signal: controller.signal } as unknown as Request;
            const res = await POST(req);
            await res.text();

            controller.abort();

            expect(logSpy).toHaveBeenCalledWith('[API] Client disconnected — aborting LangGraph execution');
            const opts = streamEvents.mock.calls[0][1] as { signal: AbortSignal };
            expect(opts.signal.aborted).toBe(true);
        });

        it('logs and swallows a failure to persist a v2-mode subagent run', async () => {
            const errSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
            const { getSubagentRunRepository } = await import('@/lib/db/repository-factory');
            vi.mocked(getSubagentRunRepository).mockReturnValue({ save: vi.fn().mockRejectedValue(new Error('db down')) } as any);

            const res = await POST(makeRequest(BASE_BODY));
            const graphConfig = vi.mocked(createReflectionGraph).mock.calls[0][0] as any;
            graphConfig.onSubagentEvent({ id: 'sa-3', role: 'x', status: 'failed', task: '', toolCount: 0, tokensIn: 0, tokensOut: 0 });

            await res.text();
            await Promise.resolve();
            expect(errSpy).toHaveBeenCalledWith('[Chat] Failed to persist sub-agent run:', expect.any(Error));
        });

        it('persists a deep-mode subagent run only once it reaches a terminal state', async () => {
            const fakeDeepStream = new ReadableStream({ start(c) { c.close(); } });
            vi.mocked(processDeepStream).mockReturnValue(fakeDeepStream as any);
            const saveMock = vi.fn().mockResolvedValue(undefined);
            const { getSubagentRunRepository } = await import('@/lib/db/repository-factory');
            vi.mocked(getSubagentRunRepository).mockReturnValue({ save: saveMock } as any);

            const res = await POST(makeRequest({ ...BASE_BODY, mode: 'deep' }));
            await res.text();
            const { onSubagentEvent } = vi.mocked(processDeepStream).mock.calls[0][0] as any;

            onSubagentEvent({ id: 'sa-1', role: 'auditor', status: 'running', task: '', toolCount: 0, tokensIn: 0, tokensOut: 0 });
            expect(saveMock).not.toHaveBeenCalled();

            onSubagentEvent({ id: 'sa-1', role: 'auditor', status: 'done', task: 'audit', toolCount: 3, tokensIn: 10, tokensOut: 5, summary: 'ok' });
            expect(saveMock).toHaveBeenCalledWith(expect.objectContaining({ subagentId: 'sa-1', status: 'done', summary: 'ok' }));
        });

        it('logs and swallows a failure to persist a deep-mode subagent run', async () => {
            const errSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
            const fakeDeepStream = new ReadableStream({ start(c) { c.close(); } });
            vi.mocked(processDeepStream).mockReturnValue(fakeDeepStream as any);
            const { getSubagentRunRepository } = await import('@/lib/db/repository-factory');
            vi.mocked(getSubagentRunRepository).mockReturnValue({ save: vi.fn().mockRejectedValue(new Error('db down')) } as any);

            const res = await POST(makeRequest({ ...BASE_BODY, mode: 'deep' }));
            await res.text();
            const { onSubagentEvent } = vi.mocked(processDeepStream).mock.calls[0][0] as any;

            onSubagentEvent({ id: 'sa-2', role: 'x', status: 'failed', task: '', toolCount: 0, tokensIn: 0, tokensOut: 0 });
            await Promise.resolve();
            expect(errSpy).toHaveBeenCalledWith('[DeepStream] failed to persist sub-agent run:', expect.any(Error));
        });

        it('populates synthetic decision results for a rejected deep-mode resume decision', async () => {
            vi.mocked(hasPendingInterrupt).mockReturnValue(true);
            vi.mocked(pendingActions).mockReturnValue([{ toolCallId: 'tc1', toolName: 'stop_ec2', args: {} } as any]);
            vi.mocked(toResumeMap).mockReturnValue({ ok: true, resume: { 'int-1': { decisions: [] } } } as any);
            vi.mocked(syntheticOutput).mockReturnValue('Rejected by user');
            const fakeDeepStream = new ReadableStream({ start(c) { c.close(); } });
            vi.mocked(processDeepStream).mockReturnValue(fakeDeepStream as any);

            const res = await POST(makeRequest({ ...BASE_BODY, mode: 'deep', decisions: [{ toolCallId: 'tc1', approved: false }] }));
            await res.text();

            const args = vi.mocked(processDeepStream).mock.calls[0][0] as any;
            expect(args.syntheticDecisionResults).toEqual([
                { toolCallId: 'tc1', toolName: 'stop_ec2', args: {}, output: 'Rejected by user' },
            ]);
        });
    });
});
