// @vitest-environment jsdom
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

import { useSubagentRuns } from './subagents';

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children);
    return { queryClient, wrapper };
}

const jsonRes = (body: unknown, opts: { ok?: boolean } = {}) => ({
    ok: opts.ok ?? true,
    json: () => Promise.resolve(body),
});

describe('useSubagentRuns', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => vi.unstubAllGlobals());

    it('is disabled when threadId is undefined even if enabled is true', () => {
        const { wrapper } = createWrapper();
        renderHook(() => useSubagentRuns(undefined, true), { wrapper });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('is disabled while enabled is false, e.g. a collapsed card', () => {
        const { wrapper } = createWrapper();
        renderHook(() => useSubagentRuns('t1', false), { wrapper });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('encodes the threadId and fetches the transcript once expanded', async () => {
        (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: [{ subagentId: 's1' }] }));
        const { wrapper } = createWrapper();
        const { result } = renderHook(() => useSubagentRuns('t 1', true), { wrapper });
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(fetch).toHaveBeenCalledWith('/api/chat/subagents/t%201');
        expect(result.current.data).toEqual([{ subagentId: 's1' }]);
    });

    it('throws with a fallback message on failure', async () => {
        (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
        const { wrapper } = createWrapper();
        const { result } = renderHook(() => useSubagentRuns('t1', true), { wrapper });
        await waitFor(() => expect(result.current.isError).toBe(true));
        expect((result.current.error as Error).message).toBe('Failed to load sub-agent transcript');
    });

    it('treats an unparsable body as a failure', async () => {
        (fetch as Mock).mockResolvedValue({ ok: false, json: () => Promise.reject(new Error('bad json')) });
        const { wrapper } = createWrapper();
        const { result } = renderHook(() => useSubagentRuns('t1', true), { wrapper });
        await waitFor(() => expect(result.current.isError).toBe(true));
        expect((result.current.error as Error).message).toBe('Failed to load sub-agent transcript');
    });
});
