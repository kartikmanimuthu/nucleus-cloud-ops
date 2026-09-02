import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getSessionUserId: vi.fn() }));
vi.mock('@/lib/agent/agent-shared', () => ({ getCheckpointer: vi.fn() }));
vi.mock('@/lib/agent/persistence', () => ({ getChatHistory: vi.fn() }));

const mockGetThread = vi.fn();
vi.mock('@/lib/store/thread-store', () => ({ threadStore: { getThread: mockGetThread } }));

import { getSessionTenantId, getSessionUserId } from '@/lib/auth-session';
import { getCheckpointer } from '@/lib/agent/agent-shared';
import { getChatHistory } from '@/lib/agent/persistence';
import { GET } from './route';

const makeParams = (threadId: string) => ({ params: Promise.resolve({ threadId }) });

describe('GET /api/threads/[threadId]/history', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getSessionUserId).mockResolvedValue('u1');
        vi.mocked(getCheckpointer).mockResolvedValue({ getTuple: vi.fn().mockResolvedValue(null) } as any);
        vi.mocked(getChatHistory).mockResolvedValue({ getMessages: vi.fn().mockResolvedValue([]) } as any);
        mockGetThread.mockResolvedValue({ id: 'thread-1' });
    });

    it('returns 400 when threadId is empty', async () => {
        const res = await GET({} as any, makeParams(''));
        expect(res.status).toBe(400);
    });

    it('returns 401 when unauthenticated', async () => {
        vi.mocked(getSessionUserId).mockRejectedValue(new Error('Unauthenticated'));
        const res = await GET({} as any, makeParams('thread-1'));
        expect(res.status).toBe(401);
    });

    it('returns 403 for a namespaced thread belonging to another tenant', async () => {
        const res = await GET({} as any, makeParams('tenant-other:u1:1'));
        expect(res.status).toBe(403);
    });

    it('returns empty messages when the thread is not owned by the caller tenant', async () => {
        mockGetThread.mockResolvedValue(null);

        const res = await GET({} as any, makeParams('thread-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual({ messages: [] });
    });

    it('returns converted chat-history messages when present', async () => {
        vi.mocked(getChatHistory).mockResolvedValue({
            getMessages: vi.fn().mockResolvedValue([
                { role: 'human', content: 'Hello' },
                { role: 'ai', content: 'Hi there' },
            ]),
        } as any);

        const res = await GET({} as any, makeParams('thread-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.messages).toHaveLength(2);
        expect(body.messages[0]).toMatchObject({ role: 'user', content: 'Hello' });
        expect(body.messages[1]).toMatchObject({ role: 'assistant' });
    });

    it('falls back to an empty history when there is no checkpoint and no chat history', async () => {
        const res = await GET({} as any, makeParams('thread-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.messages).toEqual([]);
        expect(body.plan).toBeNull();
        expect(body.pendingInterrupt).toBeNull();
    });

    it('returns 500 when threadStore.getThread throws', async () => {
        mockGetThread.mockRejectedValue(new Error('DB down'));
        const res = await GET({} as any, makeParams('thread-1'));
        expect(res.status).toBe(500);
    });

    it('accepts a namespaced thread id whose tenant segment matches the caller', async () => {
        vi.mocked(getChatHistory).mockResolvedValue({
            getMessages: vi.fn().mockResolvedValue([{ role: 'human', content: 'Hi' }]),
        } as any);
        const res = await GET({} as any, makeParams('tenant-1:u1:123'));
        expect(res.status).toBe(200);
    });

    it('falls back to the checkpoint messages when chat history is empty', async () => {
        vi.mocked(getCheckpointer).mockResolvedValue({
            getTuple: vi.fn().mockResolvedValue({
                checkpoint: {
                    channel_values: {
                        messages: [
                            { _getType: () => 'human', content: 'From checkpoint' },
                            { _getType: () => 'ai', content: 'Reply', tool_calls: [] },
                        ],
                    },
                },
            }),
        } as any);

        const res = await GET({} as any, makeParams('thread-1'));
        const body = await res.json();
        expect(body.messages).toHaveLength(2);
        expect(body.messages[0]).toMatchObject({ role: 'user', content: 'From checkpoint' });
    });

    it('propagates plan and pendingInterrupt extracted from the checkpoint state', async () => {
        vi.doMock('../run-state', () => ({
            extractThreadRunState: vi.fn().mockReturnValue({ plan: { steps: ['a'] }, pendingInterrupt: { id: 'i1' } }),
        }));
        vi.resetModules();
        const { GET: FreshGET } = await import('./route');

        vi.mocked(getCheckpointer).mockResolvedValue({
            getTuple: vi.fn().mockResolvedValue({ checkpoint: { channel_values: {} } }),
        } as any);
        vi.mocked(getChatHistory).mockResolvedValue({ getMessages: vi.fn().mockResolvedValue([]) } as any);

        const res = await FreshGET({} as any, makeParams('thread-1'));
        const body = await res.json();
        expect(body.plan).toEqual({ steps: ['a'] });
        expect(body.pendingInterrupt).toEqual({ id: 'i1' });
        vi.doUnmock('../run-state');
    });

    it('is non-fatal when checkpoint extraction throws — chat history still answers', async () => {
        vi.mocked(getCheckpointer).mockRejectedValue(new Error('checkpointer down'));
        vi.mocked(getChatHistory).mockResolvedValue({
            getMessages: vi.fn().mockResolvedValue([{ role: 'human', content: 'Hi' }]),
        } as any);

        const res = await GET({} as any, makeParams('thread-1'));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.messages).toHaveLength(1);
    });

    it('falls back to the checkpoint when the chat-history lookup itself throws', async () => {
        vi.mocked(getChatHistory).mockResolvedValue({ getMessages: vi.fn().mockRejectedValue(new Error('DB down')) } as any);
        vi.mocked(getCheckpointer).mockResolvedValue({
            getTuple: vi.fn().mockResolvedValue({
                checkpoint: { channel_values: { messages: [{ _getType: () => 'human', content: 'From checkpoint' }] } },
            }),
        } as any);

        const res = await GET({} as any, makeParams('thread-1'));
        const body = await res.json();
        expect(body.messages).toHaveLength(1);
        expect(body.messages[0].content).toBe('From checkpoint');
    });

    it('builds tool-invocation parts from an assistant message with tool_calls, then merges the tool result', async () => {
        vi.mocked(getChatHistory).mockResolvedValue({
            getMessages: vi.fn().mockResolvedValue([
                { role: 'human', content: 'Stop it' },
                { role: 'ai', content: 'Working on it', metadata: { tool_calls: [{ id: 'tc1', name: 'stop_ec2', args: { id: 'i-1' } }] } },
                { role: 'tool', content: 'stopped', metadata: { tool_call_id: 'tc1' } },
            ]),
        } as any);

        const res = await GET({} as any, makeParams('thread-1'));
        const body = await res.json();
        const assistantMsg = body.messages.find((m: any) => m.role === 'assistant');
        const toolPart = assistantMsg.parts.find((p: any) => p.type === 'tool-invocation');
        expect(toolPart).toMatchObject({ toolCallId: 'tc1', toolName: 'stop_ec2', state: 'result', result: 'stopped' });
    });

    it('extracts human-readable text from a multimodal (JSON array) human message', async () => {
        const multimodal = JSON.stringify([{ type: 'text', text: 'Look at this' }, { type: 'image_url', image_url: { url: 'data:x' } }]);
        vi.mocked(getChatHistory).mockResolvedValue({
            getMessages: vi.fn().mockResolvedValue([{ role: 'human', content: multimodal }]),
        } as any);

        const res = await GET({} as any, makeParams('thread-1'));
        const body = await res.json();
        expect(body.messages[0].content).toContain('Look at this');
        expect(body.messages[0].content).toContain('image attachment');
    });

    it('coalesces consecutive assistant turns into one message', async () => {
        vi.mocked(getChatHistory).mockResolvedValue({
            getMessages: vi.fn().mockResolvedValue([
                { role: 'human', content: 'Go' },
                { role: 'ai', content: 'PLANNING_PHASE_START\nStep 1' },
                { role: 'ai', content: 'Final answer' },
            ]),
        } as any);

        const res = await GET({} as any, makeParams('thread-1'));
        const body = await res.json();
        const assistantMsgs = body.messages.filter((m: any) => m.role === 'assistant');
        expect(assistantMsgs).toHaveLength(1);
        expect(assistantMsgs[0].parts.length).toBeGreaterThan(1);
    });

    it('returns an empty list from the checkpoint fallback when it has no messages', async () => {
        vi.mocked(getCheckpointer).mockResolvedValue({
            getTuple: vi.fn().mockResolvedValue({ checkpoint: { channel_values: {} } }),
        } as any);
        const res = await GET({} as any, makeParams('thread-1'));
        const body = await res.json();
        expect(body.messages).toEqual([]);
    });

    it('renders a memory_recall/memory_save phase as a data-phase + data-memory part', async () => {
        vi.mocked(getChatHistory).mockResolvedValue({
            getMessages: vi.fn().mockResolvedValue([
                { role: 'ai', content: 'MEMORY_RECALL_PHASE_START\nRecalled a preference' },
            ]),
        } as any);
        const res = await GET({} as any, makeParams('thread-1'));
        const body = await res.json();
        const assistantMsg = body.messages.find((m: any) => m.role === 'assistant');
        expect(assistantMsg.parts).toEqual([
            { type: 'data-phase', data: { phase: 'memory_recall', node: 'history', ts: 0 } },
            { type: 'data-memory', data: { op: 'recall', summary: 'Recalled a preference', count: null } },
        ]);
    });

    it('leaves non-array JSON human content unchanged (extractDisplayText object fallback)', async () => {
        const objectContent = '{"type":"text","text":"hi"}';
        vi.mocked(getChatHistory).mockResolvedValue({
            getMessages: vi.fn().mockResolvedValue([{ role: 'human', content: objectContent }]),
        } as any);
        const res = await GET({} as any, makeParams('thread-1'));
        const body = await res.json();
        expect(body.messages[0].content).toBe(objectContent);
    });

    it('drops a human message whose content is empty', async () => {
        vi.mocked(getChatHistory).mockResolvedValue({
            getMessages: vi.fn().mockResolvedValue([{ role: 'human', content: '' }]),
        } as any);
        const res = await GET({} as any, makeParams('thread-1'));
        const body = await res.json();
        expect(body.messages).toEqual([]);
    });

    it('drops an unrecognized plain-message role', async () => {
        vi.mocked(getChatHistory).mockResolvedValue({
            getMessages: vi.fn().mockResolvedValue([{ role: 'system', content: 'some system note' }]),
        } as any);
        const res = await GET({} as any, makeParams('thread-1'));
        const body = await res.json();
        expect(body.messages).toEqual([]);
    });

    it('reconstructs typed parts from a content-block-array assistant message and derives display text from them', async () => {
        const arrayContent = JSON.stringify([{ type: 'text', text: 'Reconstructed answer' }]);
        vi.mocked(getChatHistory).mockResolvedValue({
            getMessages: vi.fn().mockResolvedValue([{ role: 'ai', content: arrayContent }]),
        } as any);
        const res = await GET({} as any, makeParams('thread-1'));
        const body = await res.json();
        const assistantMsg = body.messages.find((m: any) => m.role === 'assistant');
        expect(assistantMsg.content).toBe('Reconstructed answer');
        expect(assistantMsg.parts).toEqual([{ type: 'text', text: 'Reconstructed answer' }]);
    });

    it('appends a data-usage part when usage metadata is present alongside content', async () => {
        vi.mocked(getChatHistory).mockResolvedValue({
            getMessages: vi.fn().mockResolvedValue([
                { role: 'ai', content: 'Answer with usage', metadata: { usage_metadata: { input_tokens: 10, output_tokens: 5 } } },
            ]),
        } as any);
        const res = await GET({} as any, makeParams('thread-1'));
        const body = await res.json();
        const assistantMsg = body.messages.find((m: any) => m.role === 'assistant');
        expect(assistantMsg.parts).toContainEqual({ type: 'data-usage', data: { input: 10, output: 5 } });
    });

    it('drops an assistant message with no content, no tool calls, and no usage', async () => {
        vi.mocked(getChatHistory).mockResolvedValue({
            getMessages: vi.fn().mockResolvedValue([{ role: 'ai', content: '' }]),
        } as any);
        const res = await GET({} as any, makeParams('thread-1'));
        const body = await res.json();
        expect(body.messages).toEqual([]);
    });

    it('drops a lone tool message that has no preceding assistant message to merge into', async () => {
        vi.mocked(getChatHistory).mockResolvedValue({
            getMessages: vi.fn().mockResolvedValue([
                { role: 'tool', content: 'orphan result', metadata: { tool_call_id: 'tc-orphan' } },
            ]),
        } as any);
        const res = await GET({} as any, makeParams('thread-1'));
        const body = await res.json();
        expect(body.messages).toEqual([]);
    });

    it('checkpoint path: drops a human message with empty content', async () => {
        vi.mocked(getCheckpointer).mockResolvedValue({
            getTuple: vi.fn().mockResolvedValue({
                checkpoint: { channel_values: { messages: [{ _getType: () => 'human', content: '' }] } },
            }),
        } as any);
        const res = await GET({} as any, makeParams('thread-1'));
        const body = await res.json();
        expect(body.messages).toEqual([]);
    });

    it('checkpoint path: reconstructs typed parts from a content-block-array AI message', async () => {
        vi.mocked(getCheckpointer).mockResolvedValue({
            getTuple: vi.fn().mockResolvedValue({
                checkpoint: {
                    channel_values: {
                        messages: [
                            { _getType: () => 'ai', content: [{ type: 'text', text: 'Hi' }], tool_calls: [] },
                        ],
                    },
                },
            }),
        } as any);
        const res = await GET({} as any, makeParams('thread-1'));
        const body = await res.json();
        const assistantMsg = body.messages.find((m: any) => m.role === 'assistant');
        expect(assistantMsg.content).toBe('Hi');
    });

    it('checkpoint path: builds a tool-invocation part from an AI message with tool_calls', async () => {
        vi.mocked(getCheckpointer).mockResolvedValue({
            getTuple: vi.fn().mockResolvedValue({
                checkpoint: {
                    channel_values: {
                        messages: [
                            {
                                _getType: () => 'ai',
                                content: 'Working',
                                tool_calls: [{ id: 'tc-cp1', name: 'stop_ec2', args: { id: 'i-1' } }],
                            },
                        ],
                    },
                },
            }),
        } as any);
        const res = await GET({} as any, makeParams('thread-1'));
        const body = await res.json();
        const assistantMsg = body.messages.find((m: any) => m.role === 'assistant');
        expect(assistantMsg.parts).toContainEqual(
            expect.objectContaining({ type: 'tool-invocation', toolCallId: 'tc-cp1', toolName: 'stop_ec2' })
        );
    });

    it('checkpoint path: drops an AI message with no content, no tool calls', async () => {
        vi.mocked(getCheckpointer).mockResolvedValue({
            getTuple: vi.fn().mockResolvedValue({
                checkpoint: {
                    channel_values: { messages: [{ _getType: () => 'ai', content: '', tool_calls: [] }] },
                },
            }),
        } as any);
        const res = await GET({} as any, makeParams('thread-1'));
        const body = await res.json();
        expect(body.messages).toEqual([]);
    });

    it('checkpoint path: builds a tool-invocation result part from a tool message', async () => {
        vi.mocked(getCheckpointer).mockResolvedValue({
            getTuple: vi.fn().mockResolvedValue({
                checkpoint: {
                    channel_values: {
                        messages: [
                            {
                                _getType: () => 'ai',
                                content: 'Working',
                                tool_calls: [{ id: 'tc-cp2', name: 'stop_ec2', args: {} }],
                            },
                            { _getType: () => 'tool', content: 'stopped', tool_call_id: 'tc-cp2' },
                        ],
                    },
                },
            }),
        } as any);
        const res = await GET({} as any, makeParams('thread-1'));
        const body = await res.json();
        const assistantMsg = body.messages.find((m: any) => m.role === 'assistant');
        const toolPart = assistantMsg.parts.find((p: any) => p.type === 'tool-invocation');
        expect(toolPart).toMatchObject({ toolCallId: 'tc-cp2', state: 'result', result: 'stopped' });
    });

    it('checkpoint path: drops an unrecognized message type', async () => {
        vi.mocked(getCheckpointer).mockResolvedValue({
            getTuple: vi.fn().mockResolvedValue({
                checkpoint: {
                    channel_values: { messages: [{ _getType: () => 'system', content: 'sys note' }] },
                },
            }),
        } as any);
        const res = await GET({} as any, makeParams('thread-1'));
        const body = await res.json();
        expect(body.messages).toEqual([]);
    });

    it('renders an execution/final phase marker as a plain text part (the "isAnswer" branch)', async () => {
        vi.mocked(getChatHistory).mockResolvedValue({
            getMessages: vi.fn().mockResolvedValue([
                { role: 'ai', content: 'EXECUTION_PHASE_START\nHere is the answer' },
            ]),
        } as any);
        const res = await GET({} as any, makeParams('thread-1'));
        const body = await res.json();
        const assistantMsg = body.messages.find((m: any) => m.role === 'assistant');
        expect(assistantMsg.parts).toContainEqual({ type: 'text', text: 'Here is the answer' });
    });

    it('renders a planning phase marker as a reasoning part run through humanizePlanning', async () => {
        vi.mocked(getChatHistory).mockResolvedValue({
            getMessages: vi.fn().mockResolvedValue([
                { role: 'ai', content: 'PLANNING_PHASE_START\n["Step one", "Step two"]' },
            ]),
        } as any);
        const res = await GET({} as any, makeParams('thread-1'));
        const body = await res.json();
        const assistantMsg = body.messages.find((m: any) => m.role === 'assistant');
        const reasoning = assistantMsg.parts.find((p: any) => p.type === 'reasoning');
        expect(reasoning).toBeDefined();
        expect(reasoning.text).toContain('Step one'); // humanizePlanning renders the parsed step list as prose
        expect(reasoning.text).not.toBe('["Step one", "Step two"]'); // not the raw JSON
    });

    it('renders a reflection phase marker as a plain (non-humanized) reasoning part', async () => {
        vi.mocked(getChatHistory).mockResolvedValue({
            getMessages: vi.fn().mockResolvedValue([
                { role: 'ai', content: 'REFLECTION_PHASE_START\nLooks good' },
            ]),
        } as any);
        const res = await GET({} as any, makeParams('thread-1'));
        const body = await res.json();
        const assistantMsg = body.messages.find((m: any) => m.role === 'assistant');
        expect(assistantMsg.parts).toContainEqual({ type: 'reasoning', text: 'Looks good' });
    });

    it('extractDisplayText: an image-only attachment array with no text parts renders just the image marker', async () => {
        const imageOnly = JSON.stringify([{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }]);
        vi.mocked(getChatHistory).mockResolvedValue({
            getMessages: vi.fn().mockResolvedValue([{ role: 'human', content: imageOnly }]),
        } as any);
        const res = await GET({} as any, makeParams('thread-1'));
        const body = await res.json();
        expect(body.messages[0].content).toBe('🖼️ [image attachment]');
    });

    it('falls back to a generated tool-call id when the persisted tool_calls metadata omits one', async () => {
        vi.mocked(getChatHistory).mockResolvedValue({
            getMessages: vi.fn().mockResolvedValue([
                { role: 'ai', content: '', metadata: { tool_calls: [{ name: 'stop_ec2', args: {} }] } },
            ]),
        } as any);
        const res = await GET({} as any, makeParams('thread-1'));
        const body = await res.json();
        const assistantMsg = body.messages.find((m: any) => m.role === 'assistant');
        const toolPart = assistantMsg.parts.find((p: any) => p.type === 'tool-invocation');
        expect(toolPart.toolCallId).toMatch(/^tool-0-stop_ec2$/);
    });

    it('checkpoint path: falls back to a generated tool-call id when the AI message tool_calls omit one', async () => {
        vi.mocked(getCheckpointer).mockResolvedValue({
            getTuple: vi.fn().mockResolvedValue({
                checkpoint: {
                    channel_values: {
                        messages: [{ _getType: () => 'ai', content: '', tool_calls: [{ name: 'stop_ec2', args: {} }] }],
                    },
                },
            }),
        } as any);
        const res = await GET({} as any, makeParams('thread-1'));
        const body = await res.json();
        const assistantMsg = body.messages.find((m: any) => m.role === 'assistant');
        const toolPart = assistantMsg.parts.find((p: any) => p.type === 'tool-invocation');
        expect(toolPart.toolCallId).toMatch(/^tool-0-stop_ec2$/);
    });

    it('mergeToolResults: ignores a tool result with no toolCallId, and leaves an unmatched toolCallId\'s invocation as "call"', async () => {
        vi.mocked(getChatHistory).mockResolvedValue({
            getMessages: vi.fn().mockResolvedValue([
                { role: 'ai', content: '', metadata: { tool_calls: [{ id: 'tc1', name: 'stop_ec2', args: {} }] } },
                { role: 'tool', content: 'orphan result A', metadata: {} }, // no tool_call_id -> toolResult.toolCallId is falsy
                { role: 'tool', content: 'orphan result B', metadata: { tool_call_id: 'tc-does-not-match' } },
            ]),
        } as any);
        const res = await GET({} as any, makeParams('thread-1'));
        const body = await res.json();
        const assistantMsg = body.messages.find((m: any) => m.role === 'assistant');
        const toolPart = assistantMsg.parts.find((p: any) => p.type === 'tool-invocation');
        expect(toolPart.state).toBe('call');
        expect(toolPart.result).toBeUndefined();
    });
});
