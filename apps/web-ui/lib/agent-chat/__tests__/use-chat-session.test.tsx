// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const { mockUseChat, mockToastError } = vi.hoisted(() => ({
    mockUseChat: vi.fn(),
    mockToastError: vi.fn(),
}));

vi.mock('@ai-sdk/react', () => ({ useChat: mockUseChat }));
vi.mock('ai', () => ({
    DefaultChatTransport: vi.fn().mockImplementation(function (this: any, opts: any) { this.opts = opts; }),
}));
vi.mock('sonner', () => ({ toast: { error: mockToastError } }));

import { useChatSession } from '../use-chat-session';

function makeChatState(overrides: Record<string, any> = {}) {
    return {
        messages: [],
        sendMessage: vi.fn().mockResolvedValue(undefined),
        status: 'ready',
        error: undefined,
        setMessages: vi.fn(),
        addToolResult: vi.fn(),
        stop: vi.fn(),
        ...overrides,
    };
}

describe('useChatSession', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockUseChat.mockReturnValue(makeChatState());
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ messages: [] }) }));
    });
    afterEach(() => vi.unstubAllGlobals());

    it('fetches thread history on mount without an ownerUserId param', async () => {
        renderHook(() => useChatSession({ threadId: 't1', body: () => ({}) }));
        await waitFor(() => expect(fetch).toHaveBeenCalled());
        expect(fetch).toHaveBeenCalledWith('/api/threads/t1/history', expect.objectContaining({ signal: expect.anything() }));
    });

    it('includes an encoded ownerUserId query param when provided', async () => {
        renderHook(() => useChatSession({ threadId: 't1', ownerUserId: 'user@a b', body: () => ({}) }));
        await waitFor(() => expect(fetch).toHaveBeenCalled());
        expect(fetch).toHaveBeenCalledWith(
            '/api/threads/t1/history?ownerUserId=user%40a%20b',
            expect.anything(),
        );
    });

    it('sets messages from a successful history response and clears isLoadingHistory', async () => {
        const chatState = makeChatState();
        mockUseChat.mockReturnValue(chatState);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true, json: async () => ({ messages: [{ id: 'm1', role: 'user', parts: [] }] }),
        }));

        const { result } = renderHook(() => useChatSession({ threadId: 't1', body: () => ({}) }));
        expect(result.current.isLoadingHistory).toBe(true);

        await waitFor(() => expect(chatState.setMessages).toHaveBeenCalledWith([{ id: 'm1', role: 'user', parts: [] }]));
        await waitFor(() => expect(result.current.isLoadingHistory).toBe(false));
    });

    it('does not call setMessages when the history response has no messages', async () => {
        const chatState = makeChatState();
        mockUseChat.mockReturnValue(chatState);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ messages: [] }) }));

        renderHook(() => useChatSession({ threadId: 't1', body: () => ({}) }));
        await waitFor(() => expect(fetch).toHaveBeenCalled());
        expect(chatState.setMessages).not.toHaveBeenCalled();
    });

    it('restores both the plan and pendingInterrupt parts when a run is parked mid-approval', async () => {
        const plan = [{ step: 'Step 1', status: 'completed' }, { step: 'Step 2', status: 'pending' }];
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                messages: [],
                plan,
                pendingInterrupt: { parts: [{ type: 'data-approval', data: { batchId: 'b1', tools: [] } }] },
            }),
        }));

        const { result } = renderHook(() => useChatSession({ threadId: 't1', body: () => ({}) }));
        await waitFor(() => expect(result.current.isLoadingHistory).toBe(false));
        // Restored parts feed into runState via the synthetic message — a plan
        // part plus a pending approval batch should surface as structured data.
        expect(result.current.runState.hasStructuredData).toBe(true);
        expect(result.current.runState.plan).toEqual(plan);
    });

    it('restores just the plan part when there is no pending interrupt', async () => {
        const plan = [{ step: 'Only step', status: 'pending' }];
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true, json: async () => ({ messages: [], plan }),
        }));

        const { result } = renderHook(() => useChatSession({ threadId: 't1', body: () => ({}) }));
        await waitFor(() => expect(result.current.isLoadingHistory).toBe(false));
        expect(result.current.runState.plan).toEqual(plan);
    });

    it('warns and does not set messages on a non-ok history response', async () => {
        const chatState = makeChatState();
        mockUseChat.mockReturnValue(chatState);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        renderHook(() => useChatSession({ threadId: 't1', body: () => ({}) }));
        await waitFor(() => expect(warnSpy).toHaveBeenCalledWith('[useChatSession] Failed to fetch history:', 500));
        expect(chatState.setMessages).not.toHaveBeenCalled();
    });

    it('silently ignores an AbortError from a superseded history fetch', async () => {
        const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const { result } = renderHook(() => useChatSession({ threadId: 't1', body: () => ({}) }));
        await waitFor(() => expect(result.current.isLoadingHistory).toBe(false));
        expect(errSpy).not.toHaveBeenCalled();
    });

    it('logs a non-abort history fetch error', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const { result } = renderHook(() => useChatSession({ threadId: 't1', body: () => ({}) }));
        await waitFor(() => expect(result.current.isLoadingHistory).toBe(false));
        expect(errSpy).toHaveBeenCalledWith('[useChatSession] Error fetching history:', expect.any(Error));
    });

    it('clear() resets messages via setMessages([])', async () => {
        const chatState = makeChatState();
        mockUseChat.mockReturnValue(chatState);
        const { result } = renderHook(() => useChatSession({ threadId: 't1', body: () => ({}) }));
        await waitFor(() => expect(result.current.isLoadingHistory).toBe(false));

        act(() => result.current.clear());
        expect(chatState.setMessages).toHaveBeenCalledWith([]);
    });

    it('sendMessage forwards the message to the underlying rawSendMessage', async () => {
        const chatState = makeChatState();
        mockUseChat.mockReturnValue(chatState);
        const { result } = renderHook(() => useChatSession({ threadId: 't1', body: () => ({}) }));
        await waitFor(() => expect(result.current.isLoadingHistory).toBe(false));

        await act(async () => {
            await result.current.sendMessage({ role: 'user', content: 'hi' });
        });
        expect(chatState.sendMessage).toHaveBeenCalledWith({ role: 'user', content: 'hi' });
    });

    it('handleToolApproval reports the legacy tool result and resumes via a role:"tool" message', async () => {
        const chatState = makeChatState();
        mockUseChat.mockReturnValue(chatState);
        const { result } = renderHook(() => useChatSession({ threadId: 't1', body: () => ({}) }));
        await waitFor(() => expect(result.current.isLoadingHistory).toBe(false));

        await act(async () => {
            await result.current.handleToolApproval('tc1', true, 'stop_instance');
        });

        expect(chatState.addToolResult).toHaveBeenCalledWith({ tool: 'stop_instance', toolCallId: 'tc1', output: 'Approved' });
        expect(chatState.sendMessage).toHaveBeenCalledWith({ role: 'tool', content: 'Approved', toolCallId: 'tc1' });
    });

    it('reports "Cancelled by user" when a tool approval is rejected', async () => {
        const chatState = makeChatState();
        mockUseChat.mockReturnValue(chatState);
        const { result } = renderHook(() => useChatSession({ threadId: 't1', body: () => ({}) }));
        await waitFor(() => expect(result.current.isLoadingHistory).toBe(false));

        await act(async () => {
            await result.current.handleToolApproval('tc1', false, 'stop_instance');
        });
        expect(chatState.addToolResult).toHaveBeenCalledWith({ tool: 'stop_instance', toolCallId: 'tc1', output: 'Cancelled by user' });
    });

    it('derives isStreaming from the underlying status', async () => {
        mockUseChat.mockReturnValue(makeChatState({ status: 'streaming' }));
        const { result: streaming } = renderHook(() => useChatSession({ threadId: 't1', body: () => ({}) }));
        await waitFor(() => expect(streaming.current.isLoadingHistory).toBe(false));
        expect(streaming.current.isStreaming).toBe(true);

        mockUseChat.mockReturnValue(makeChatState({ status: 'ready' }));
        const { result: ready } = renderHook(() => useChatSession({ threadId: 't2', body: () => ({}) }));
        await waitFor(() => expect(ready.current.isLoadingHistory).toBe(false));
        expect(ready.current.isStreaming).toBe(false);
    });

    it('computes a friendly error message from the underlying rawError', async () => {
        mockUseChat.mockReturnValue(makeChatState({ error: new Error('Request failed: {"error":"Tenant not found"}') }));
        const { result } = renderHook(() => useChatSession({ threadId: 't1', body: () => ({}) }));
        await waitFor(() => expect(result.current.isLoadingHistory).toBe(false));
        expect(result.current.error).toBe('Tenant not found');
    });

    it('submits a decision batch and clears restored parts on success', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                messages: [],
                pendingInterrupt: { parts: [{ type: 'data-clarification', data: { toolCallId: 'tc1', question: 'Which region?' } }] },
            }),
        }));
        const chatState = makeChatState();
        mockUseChat.mockReturnValue(chatState);

        const { result } = renderHook(() => useChatSession({ threadId: 't1', body: () => ({}) }));
        await waitFor(() => expect(result.current.runState.pendingClarifications).toHaveLength(1));

        await act(async () => {
            result.current.submitClarification('tc1', 'us-east-1');
        });

        await waitFor(() => expect(chatState.sendMessage).toHaveBeenCalledWith(
            { role: 'user', content: '' },
            { body: { decisions: [{ toolCallId: 'tc1', approved: true, answer: 'us-east-1' }] } },
        ));
        expect(mockToastError).not.toHaveBeenCalled();
    });

    it('shows a failure toast and rolls back the decision when the resume submission fails', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                messages: [],
                pendingInterrupt: { parts: [{ type: 'data-clarification', data: { toolCallId: 'tc1', question: 'Which region?' } }] },
            }),
        }));
        // onError (wired into useChat's options) is what real code uses to flag a
        // failed resume — simulate it by having useChat invoke onError synchronously.
        // IMPORTANT: mockUseChat must return the SAME object identity across
        // renders (like the real hook's stable callbacks) — a fresh object per
        // call would make the history-fetch effect's `[setMessages]` dependency
        // "change" every render, re-triggering it forever.
        let latestOnError: ((err: unknown) => void) | undefined;
        const chatState = makeChatState({
            sendMessage: vi.fn().mockImplementation(async () => {
                latestOnError?.(new Error('Run is busy'));
            }),
        });
        mockUseChat.mockImplementation((opts: any) => {
            latestOnError = opts.onError;
            return chatState;
        });

        const { result } = renderHook(() => useChatSession({ threadId: 't1', body: () => ({}) }));
        await waitFor(() => expect(result.current.runState.pendingClarifications).toHaveLength(1));

        await act(async () => {
            result.current.submitClarification('tc1', 'us-east-1');
        });

        await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
            "Couldn't submit your decisions",
            { description: 'Run is busy' },
        ));
        // Rolled back — the clarification is pending again, not resolved.
        expect(result.current.runState.pendingClarifications).toHaveLength(1);
    });
});
