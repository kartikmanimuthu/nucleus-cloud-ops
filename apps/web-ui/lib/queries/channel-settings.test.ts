// @vitest-environment jsdom
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

import {
    useChannelSettings,
    revealChannelSecrets,
    useSaveChannelSettings,
    useResetChannelSettings,
    useToggleChannelEnabled,
} from './channel-settings';

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children);
    return { queryClient, wrapper };
}

const jsonRes = (body: unknown, opts: { ok?: boolean; status?: number } = {}) => ({
    ok: opts.ok ?? true,
    status: opts.status ?? (opts.ok === false ? 400 : 200),
    json: () => Promise.resolve(body),
});

describe('channel-settings queries', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => vi.unstubAllGlobals());

    describe('useChannelSettings', () => {
        it('defaults configured=false and enabled=true when absent from the body', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({}));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useChannelSettings('slack'), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/agent-ops/settings/slack');
            expect(result.current.data).toEqual({ configured: false, enabled: true });
        });

        it('preserves extra channel-specific fields and explicit configured/enabled', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ configured: true, enabled: false, baseUrl: 'https://x' }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useChannelSettings('jira'), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(result.current.data).toEqual({ configured: true, enabled: false, baseUrl: 'https://x' });
        });

        it('degrades an unparsable body to the same defaults instead of rejecting', async () => {
            (fetch as Mock).mockResolvedValue({ json: () => Promise.reject(new Error('bad json')) });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useChannelSettings('slack'), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(result.current.data).toEqual({ configured: false, enabled: true });
        });
    });

    describe('revealChannelSecrets', () => {
        it('fetches the reveal endpoint for the channel', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ botToken: 'secret' }));
            const result = await revealChannelSecrets('slack');
            expect(fetch).toHaveBeenCalledWith('/api/agent-ops/settings/slack/reveal');
            expect(result).toEqual({ botToken: 'secret' });
        });

        it('degrades an unparsable body to an empty object', async () => {
            (fetch as Mock).mockResolvedValue({ json: () => Promise.reject(new Error('bad json')) });
            const result = await revealChannelSecrets('slack');
            expect(result).toEqual({});
        });
    });

    describe('useSaveChannelSettings', () => {
        it('POSTs first when the cache has no entry, and invalidates both keys on success', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useSaveChannelSettings('slack'), { wrapper });
            result.current.mutate({ botToken: 't' });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));

            expect(fetch).toHaveBeenCalledTimes(1);
            expect(fetch).toHaveBeenCalledWith(
                '/api/agent-ops/settings/slack',
                expect.objectContaining({ method: 'POST' }),
            );
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['channel-settings', 'slack'] });
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['channels', 'status'] });
        });

        it('PUTs first when the cache reports the channel as already configured', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true }));
            const { wrapper, queryClient } = createWrapper();
            queryClient.setQueryData(['channel-settings', 'slack'], { configured: true, enabled: true });
            const { result } = renderHook(() => useSaveChannelSettings('slack'), { wrapper });
            result.current.mutate({ botToken: 't' });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/agent-ops/settings/slack', expect.objectContaining({ method: 'PUT' }));
        });

        it('retries as PUT when a stale POST gets a 409 (already configured)', async () => {
            (fetch as Mock)
                .mockResolvedValueOnce(jsonRes({ error: 'already configured' }, { ok: false, status: 409 }))
                .mockResolvedValueOnce(jsonRes({ success: true }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSaveChannelSettings('slack'), { wrapper });
            result.current.mutate({ botToken: 't' });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));

            expect(fetch).toHaveBeenCalledTimes(2);
            expect((fetch as Mock).mock.calls[0][1]).toMatchObject({ method: 'POST' });
            expect((fetch as Mock).mock.calls[1][1]).toMatchObject({ method: 'PUT' });
        });

        it('retries as POST when a stale PUT gets a 404 (not configured)', async () => {
            (fetch as Mock)
                .mockResolvedValueOnce(jsonRes({ error: 'not configured' }, { ok: false, status: 404 }))
                .mockResolvedValueOnce(jsonRes({ success: true }));
            const { wrapper, queryClient } = createWrapper();
            queryClient.setQueryData(['channel-settings', 'slack'], { configured: true, enabled: true });
            const { result } = renderHook(() => useSaveChannelSettings('slack'), { wrapper });
            result.current.mutate({ botToken: 't' });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));

            expect(fetch).toHaveBeenCalledTimes(2);
            expect((fetch as Mock).mock.calls[0][1]).toMatchObject({ method: 'PUT' });
            expect((fetch as Mock).mock.calls[1][1]).toMatchObject({ method: 'POST' });
        });

        it('does not retry a 403 — a genuine permission denial surfaces immediately', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ error: 'Forbidden' }, { ok: false, status: 403 }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSaveChannelSettings('slack'), { wrapper });
            result.current.mutate({ botToken: 't' });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect(fetch).toHaveBeenCalledTimes(1);
            expect((result.current.error as Error).message).toBe('Forbidden');
        });

        it('falls back to a generic error when the failure body has none', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({}, { ok: false, status: 500 }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSaveChannelSettings('slack'), { wrapper });
            result.current.mutate({ botToken: 't' });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to save');
        });
    });

    describe('useResetChannelSettings', () => {
        it('DELETEs and invalidates both keys on success', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useResetChannelSettings('slack'), { wrapper });
            result.current.mutate();
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/agent-ops/settings/slack', { method: 'DELETE' });
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['channel-settings', 'slack'] });
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['channels', 'status'] });
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({}, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useResetChannelSettings('slack'), { wrapper });
            result.current.mutate();
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to reset channel');
        });
    });

    describe('useToggleChannelEnabled', () => {
        it('PUTs { enabled } and invalidates both keys for that channel on success', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useToggleChannelEnabled(), { wrapper });
            result.current.mutate({ channel: 'slack', enabled: false });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/agent-ops/settings/slack', expect.objectContaining({
                method: 'PUT', body: JSON.stringify({ enabled: false }),
            }));
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['channel-settings', 'slack'] });
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['channels', 'status'] });
        });

        it('uses an "activate" failure message when enabling', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({}, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useToggleChannelEnabled(), { wrapper });
            result.current.mutate({ channel: 'slack', enabled: true });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to activate channel');
        });

        it('uses a "deactivate" failure message when disabling', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({}, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useToggleChannelEnabled(), { wrapper });
            result.current.mutate({ channel: 'slack', enabled: false });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to deactivate channel');
        });
    });
});
