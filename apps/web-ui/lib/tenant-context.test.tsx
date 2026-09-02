// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { TenantProvider, useTenant } from './tenant-context';

const wrapper = ({ children }: { children: React.ReactNode }) => <TenantProvider>{children}</TenantProvider>;

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe('TenantProvider / useTenant', () => {
    it('starts with the default (loading) state before the fetch resolves', () => {
        vi.mocked(fetch).mockReturnValue(new Promise(() => {}));

        const { result } = renderHook(() => useTenant(), { wrapper });

        expect(result.current.isLoading).toBe(true);
        expect(result.current.timezone).toBe('UTC');
        expect(result.current.name).toBe('');
        expect(result.current.slug).toBeNull();
        expect(result.current.error).toBeNull();
    });

    it('populates state from a successful settings response', async () => {
        vi.mocked(fetch).mockResolvedValue({
            ok: true,
            json: async () => ({ success: true, data: { timezone: 'America/New_York', name: 'Acme', slug: 'acme' } }),
        } as Response);

        const { result } = renderHook(() => useTenant(), { wrapper });

        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.timezone).toBe('America/New_York');
        expect(result.current.name).toBe('Acme');
        expect(result.current.slug).toBe('acme');
        expect(result.current.error).toBeNull();
    });

    it('defaults timezone/name to fallbacks and slug to null when the response omits them', async () => {
        vi.mocked(fetch).mockResolvedValue({
            ok: true,
            json: async () => ({ success: true, data: {} }),
        } as Response);

        const { result } = renderHook(() => useTenant(), { wrapper });

        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.timezone).toBe('UTC');
        expect(result.current.name).toBe('');
        expect(result.current.slug).toBeNull();
    });

    it('sets an error and clears loading when the response is not ok', async () => {
        vi.mocked(fetch).mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as Response);

        const { result } = renderHook(() => useTenant(), { wrapper });

        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.error).toBe('Failed to fetch tenant settings: 500');
    });

    it('sets an error when the response body is missing success/data', async () => {
        vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ success: false }) } as Response);

        const { result } = renderHook(() => useTenant(), { wrapper });

        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.error).toBe('Invalid tenant settings response');
    });

    it('stringifies a non-Error fetch rejection as "Unknown error"', async () => {
        vi.mocked(fetch).mockRejectedValue('network down');

        const { result } = renderHook(() => useTenant(), { wrapper });

        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.error).toBe('Unknown error');
    });

    it('preserves the rest of state and clears loading on a thrown Error', async () => {
        vi.mocked(fetch).mockRejectedValue(new Error('boom'));

        const { result } = renderHook(() => useTenant(), { wrapper });

        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.error).toBe('boom');
        expect(result.current.timezone).toBe('UTC');
    });

    it('refetch() re-runs the fetch and updates state again', async () => {
        vi.mocked(fetch).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true, data: { timezone: 'UTC', name: 'First', slug: 'first' } }),
        } as Response);

        const { result } = renderHook(() => useTenant(), { wrapper });
        await waitFor(() => expect(result.current.name).toBe('First'));

        vi.mocked(fetch).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true, data: { timezone: 'UTC', name: 'Second', slug: 'second' } }),
        } as Response);

        await result.current.refetch();

        await waitFor(() => expect(result.current.name).toBe('Second'));
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('returns the default context (no throw) when used outside a TenantProvider, whose no-op refetch resolves', async () => {
        const { result } = renderHook(() => useTenant());

        expect(result.current.timezone).toBe('UTC');
        expect(result.current.isLoading).toBe(true);
        await expect(result.current.refetch()).resolves.toBeUndefined();
    });

    // NOTE: `useTenant`'s `if (!ctx) throw` guard is unreachable. `TenantContext` is created via
    // `createContext(<concrete default object>)`, so `useContext(TenantContext)` can only ever
    // return that object or a value from a `<TenantContext.Provider value={...}>` — never
    // null/undefined — for any real consumer. Left untested rather than gamed.
});
