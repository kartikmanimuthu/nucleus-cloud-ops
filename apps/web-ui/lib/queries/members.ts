'use client';

/**
 * TanStack Query hooks for tenant members + invitations (settings → members).
 * Fetches inlined; mutations invalidate the relevant caches. Revoke uses an
 * optimistic update with rollback. Roles come from the shared useRoles hook.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export interface Member {
    id: string;
    userId: string;
    email: string;
    role: string;
    assignedAt: string;
}

export interface Invitation {
    id: string;
    tenantId: string;
    email: string;
    role: string;
    invitedBy: string;
    status: 'pending' | 'accepted' | 'revoked' | 'expired';
    createdAt: string;
    expiresAt: string;
}

const membersKey = ['settings', 'members'] as const;
const invitationsKey = ['invitations'] as const;

export function useMembers() {
    return useQuery({
        queryKey: membersKey,
        queryFn: async (): Promise<Member[]> => {
            const res = await fetch('/api/settings/members');
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(
                    json.error ?? 'Failed to load members. Refresh the page to try again.',
                );
            }
            return json.data ?? [];
        },
    });
}

export function useInvitations() {
    return useQuery({
        queryKey: invitationsKey,
        queryFn: async (): Promise<Invitation[]> => {
            const res = await fetch('/api/invitations');
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(
                    json.error ?? 'Failed to load invitations. Refresh the page to try again.',
                );
            }
            return json.data ?? [];
        },
    });
}

export function useInviteMember() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async ({ email, role }: { email: string; role: string }) => {
            const res = await fetch('/api/invitations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, role }),
            });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error ?? 'Invitation failed.');
            return json;
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: membersKey });
            qc.invalidateQueries({ queryKey: invitationsKey });
        },
    });
}

export function useResendInvitation() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (id: string) => {
            const res = await fetch(`/api/invitations/${id}/resend`, { method: 'POST' });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error ?? 'Resend failed.');
            return json;
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: invitationsKey }),
    });
}

export function useChangeMemberRole() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async ({ memberId, role }: { memberId: string; role: string }) => {
            const res = await fetch(`/api/settings/members/${memberId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role }),
            });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error ?? 'Role update failed.');
            return json;
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: membersKey }),
    });
}

export function useRevokeInvitation() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (id: string) => {
            const res = await fetch(`/api/invitations/${id}/revoke`, { method: 'POST' });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error ?? 'Revoke failed.');
            return json;
        },
        // Optimistically remove the invitation; roll back on error.
        onMutate: async (id: string) => {
            await qc.cancelQueries({ queryKey: invitationsKey });
            const prev = qc.getQueryData<Invitation[]>(invitationsKey);
            qc.setQueryData<Invitation[]>(invitationsKey, (old) =>
                (old ?? []).filter((inv) => inv.id !== id),
            );
            return { prev };
        },
        onError: (_err, _id, ctx) => {
            if (ctx?.prev) qc.setQueryData(invitationsKey, ctx.prev);
        },
        onSettled: () => qc.invalidateQueries({ queryKey: invitationsKey }),
    });
}
