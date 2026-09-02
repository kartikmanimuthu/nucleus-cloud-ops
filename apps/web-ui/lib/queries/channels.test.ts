// @vitest-environment jsdom
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

import { useChannelStatus } from './channels';

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children);
    return { queryClient, wrapper };
}

function mockFetchByUrl(map: Record<string, unknown>) {
    (fetch as Mock).mockImplementation((url: string) => {
        const body = map[url];
        if (body === 'REJECT') return Promise.reject(new Error('network error'));
        return Promise.resolve({ json: () => Promise.resolve(body) });
    });
}

describe('useChannelStatus', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => vi.unstubAllGlobals());

    it('maps every configured/enabled channel and derives mcp/providers counts', async () => {
        mockFetchByUrl({
            '/api/agent-ops/settings/slack': { configured: true, enabled: true },
            '/api/agent-ops/settings/jira': { configured: false, enabled: false },
            '/api/agent-ops/settings/discord': { configured: true, enabled: false },
            '/api/agent-ops/settings/telegram': { configured: true, enabled: true },
            '/api/agent-ops/settings/webhook': { configured: false, enabled: true },
            '/api/agent-ops/mcp-settings': { servers: { s1: {}, s2: {} } },
            '/api/settings/providers': { success: true, data: { providers: [{ id: 'p1' }, { id: 'p2' }] } },
        });
        const { wrapper } = createWrapper();
        const { result } = renderHook(() => useChannelStatus(), { wrapper });
        await waitFor(() => expect(result.current.isPlaceholderData).toBe(false));

        expect(result.current.data).toEqual({
            slack: { configured: true, enabled: true },
            jira: { configured: false, enabled: false },
            discord: { configured: true, enabled: false },
            telegram: { configured: true, enabled: true },
            webhook: { configured: false, enabled: true },
            mcp: { serverCount: 2 },
            providers: { count: 2 },
        });
    });

    it('degrades a rejected channel fetch to null instead of failing the whole query', async () => {
        mockFetchByUrl({
            '/api/agent-ops/settings/slack': 'REJECT',
            '/api/agent-ops/settings/jira': { configured: true, enabled: true },
            '/api/agent-ops/settings/discord': null,
            '/api/agent-ops/settings/telegram': null,
            '/api/agent-ops/settings/webhook': null,
            '/api/agent-ops/mcp-settings': {},
            '/api/settings/providers': { success: false },
        });
        const { wrapper } = createWrapper();
        const { result } = renderHook(() => useChannelStatus(), { wrapper });
        await waitFor(() => expect(result.current.isPlaceholderData).toBe(false));

        expect(result.current.data?.slack).toBeNull();
        expect(result.current.data?.jira).toEqual({ configured: true, enabled: true });
        expect(result.current.data?.mcp).toBeNull();
        expect(result.current.data?.providers).toBeNull();
    });

    it('defaults configured/enabled to false when a channel body omits them', async () => {
        mockFetchByUrl({
            '/api/agent-ops/settings/slack': { configured: true },
            '/api/agent-ops/settings/jira': null,
            '/api/agent-ops/settings/discord': null,
            '/api/agent-ops/settings/telegram': null,
            '/api/agent-ops/settings/webhook': null,
            '/api/agent-ops/mcp-settings': null,
            '/api/settings/providers': null,
        });
        const { wrapper } = createWrapper();
        const { result } = renderHook(() => useChannelStatus(), { wrapper });
        await waitFor(() => expect(result.current.isPlaceholderData).toBe(false));
        expect(result.current.data?.slack).toEqual({ configured: true, enabled: false });
    });

    it('defaults providers.count to 0 when success is true but data.providers is missing', async () => {
        mockFetchByUrl({
            '/api/agent-ops/settings/slack': null,
            '/api/agent-ops/settings/jira': null,
            '/api/agent-ops/settings/discord': null,
            '/api/agent-ops/settings/telegram': null,
            '/api/agent-ops/settings/webhook': null,
            '/api/agent-ops/mcp-settings': null,
            '/api/settings/providers': { success: true, data: {} },
        });
        const { wrapper } = createWrapper();
        const { result } = renderHook(() => useChannelStatus(), { wrapper });
        await waitFor(() => expect(result.current.isPlaceholderData).toBe(false));
        expect(result.current.data?.providers).toEqual({ count: 0 });
    });

    it('shows the empty-status placeholder while no cache exists yet', () => {
        (fetch as Mock).mockReturnValue(new Promise(() => {}));
        const { wrapper } = createWrapper();
        const { result } = renderHook(() => useChannelStatus(), { wrapper });
        expect(result.current.data).toEqual({
            slack: null, jira: null, discord: null, telegram: null, webhook: null, mcp: null, providers: null,
        });
    });
});
