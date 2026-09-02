// @vitest-environment jsdom
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

import {
    useMcpConfig,
    useSaveMcpConfig,
    useResetMcpConfig,
    useTestMcpServer,
} from './mcp-servers';
import { queryKeys } from './query-keys';

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children);
    return { queryClient, wrapper };
}

describe('mcp-servers queries', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => vi.unstubAllGlobals());

    describe('useMcpConfig', () => {
        it('fetches from the given apiPath', async () => {
            (fetch as Mock).mockResolvedValue({ ok: true, json: () => Promise.resolve({ servers: [], config: {}, isCustom: false }) });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useMcpConfig('/api/mcp-servers'), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/mcp-servers');
        });

        it('throws a fixed message when the response is not ok', async () => {
            (fetch as Mock).mockResolvedValue({ ok: false });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useMcpConfig('/api/mcp-servers'), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to load MCP configuration');
        });
    });

    describe('useSaveMcpConfig', () => {
        it('PUTs { config } and invalidates that apiPath key on success', async () => {
            (fetch as Mock).mockResolvedValue({ ok: true, json: () => Promise.resolve({ servers: [], config: {}, isCustom: true }) });
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useSaveMcpConfig('/api/mcp-servers'), { wrapper });
            result.current.mutate({ mcpServers: {} } as any);
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/mcp-servers', expect.objectContaining({
                method: 'PUT', body: JSON.stringify({ config: { mcpServers: {} } }),
            }));
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.mcpServers.config('/api/mcp-servers') });
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSaveMcpConfig('/api/mcp-servers'), { wrapper });
            result.current.mutate({} as any);
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to save MCP configuration');
        });
    });

    describe('useResetMcpConfig', () => {
        it('DELETEs and invalidates that apiPath key on success', async () => {
            (fetch as Mock).mockResolvedValue({ ok: true, json: () => Promise.resolve({ servers: [], config: {}, isCustom: false }) });
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useResetMcpConfig('/api/agent-ops/mcp-settings'), { wrapper });
            result.current.mutate();
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/agent-ops/mcp-settings', { method: 'DELETE' });
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.mcpServers.config('/api/agent-ops/mcp-settings') });
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useResetMcpConfig('/api/mcp-servers'), { wrapper });
            result.current.mutate();
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to reset MCP configuration');
        });
    });

    describe('useTestMcpServer', () => {
        it('POSTs to {apiPath}/test and returns the raw JSON regardless of success', async () => {
            (fetch as Mock).mockResolvedValue({ ok: false, json: () => Promise.resolve({ success: false, error: 'unreachable' }) });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useTestMcpServer('/api/mcp-servers'), { wrapper });
            result.current.mutate({ id: 'srv1', entry: {} as any });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/mcp-servers/test', expect.objectContaining({ method: 'POST' }));
            expect(result.current.data).toEqual({ success: false, error: 'unreachable' });
        });
    });
});
