// @vitest-environment jsdom
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

import {
    useMembers,
    useInvitations,
    useInviteMember,
    useResendInvitation,
    useChangeMemberRole,
    useRevokeInvitation,
    type Invitation,
} from './members';

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

const invitationsKey = ['invitations'] as const;
const membersKey = ['settings', 'members'] as const;

describe('members queries', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => vi.unstubAllGlobals());

    describe('useMembers', () => {
        it('returns the member list', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: [{ id: 'm1' }] }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useMembers(), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/settings/members');
            expect(result.current.data).toEqual([{ id: 'm1' }]);
        });

        it('defaults to an empty array when data is missing', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useMembers(), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(result.current.data).toEqual([]);
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useMembers(), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to load members. Refresh the page to try again.');
        });
    });

    describe('useInvitations', () => {
        it('returns the invitation list', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: [{ id: 'i1' }] }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useInvitations(), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/invitations');
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useInvitations(), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to load invitations. Refresh the page to try again.');
        });
    });

    describe('useInviteMember', () => {
        it('POSTs email/role and invalidates members + invitations', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useInviteMember(), { wrapper });
            result.current.mutate({ email: 'a@b.co', role: 'admin' });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/invitations', expect.objectContaining({
                method: 'POST', body: JSON.stringify({ email: 'a@b.co', role: 'admin' }),
            }));
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: membersKey });
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: invitationsKey });
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useInviteMember(), { wrapper });
            result.current.mutate({ email: 'a@b.co', role: 'admin' });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Invitation failed.');
        });
    });

    describe('useResendInvitation', () => {
        it('POSTs to resend and invalidates invitations', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useResendInvitation(), { wrapper });
            result.current.mutate('i1');
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/invitations/i1/resend', { method: 'POST' });
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: invitationsKey });
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useResendInvitation(), { wrapper });
            result.current.mutate('i1');
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Resend failed.');
        });
    });

    describe('useChangeMemberRole', () => {
        it('PATCHes role and invalidates members', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useChangeMemberRole(), { wrapper });
            result.current.mutate({ memberId: 'm1', role: 'viewer' });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/settings/members/m1', expect.objectContaining({
                method: 'PATCH', body: JSON.stringify({ role: 'viewer' }),
            }));
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: membersKey });
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useChangeMemberRole(), { wrapper });
            result.current.mutate({ memberId: 'm1', role: 'viewer' });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Role update failed.');
        });
    });

    describe('useRevokeInvitation', () => {
        const invitations: Invitation[] = [
            { id: 'i1', tenantId: 't1', email: 'a@b.co', role: 'admin', invitedBy: 'u1', status: 'pending', createdAt: 'now', expiresAt: 'later' },
            { id: 'i2', tenantId: 't1', email: 'c@d.co', role: 'admin', invitedBy: 'u1', status: 'pending', createdAt: 'now', expiresAt: 'later' },
        ];

        it('optimistically removes the invitation before the response resolves', async () => {
            let resolveFetch: (v: unknown) => void = () => {};
            (fetch as Mock).mockReturnValue(new Promise((resolve) => { resolveFetch = resolve; }));
            const { wrapper, queryClient } = createWrapper();
            queryClient.setQueryData(invitationsKey, invitations);
            const { result } = renderHook(() => useRevokeInvitation(), { wrapper });

            result.current.mutate('i1');
            await waitFor(() => {
                expect(queryClient.getQueryData(invitationsKey)).toEqual([invitations[1]]);
            });

            resolveFetch(jsonRes({ success: true }));
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
        });

        it('rolls back the optimistic removal when the revoke fails', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false, error: 'already accepted' }, { ok: false }));
            const { wrapper, queryClient } = createWrapper();
            queryClient.setQueryData(invitationsKey, invitations);
            const { result } = renderHook(() => useRevokeInvitation(), { wrapper });

            result.current.mutate('i1');
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect(queryClient.getQueryData(invitationsKey)).toEqual(invitations);
        });

        it('invalidates invitations on settle regardless of outcome', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true }));
            const { wrapper, queryClient } = createWrapper();
            queryClient.setQueryData(invitationsKey, invitations);
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useRevokeInvitation(), { wrapper });
            result.current.mutate('i1');
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: invitationsKey });
        });
    });
});
