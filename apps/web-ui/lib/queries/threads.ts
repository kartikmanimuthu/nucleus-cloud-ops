'use client';

/**
 * TanStack Query hooks for chat threads (list + delete + rename).
 *
 * The sidebar previously hand-rolled useState + fetch with no invalidation, so
 * it went stale after a thread was created/renamed/deleted elsewhere. Routing
 * the list through TanStack Query gives us refetch-on-focus for free and lets
 * mutations invalidate the list so every consumer refreshes together.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queries/query-keys';

export interface Thread {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    model?: string;
    ownerUserId?: string;
}

export function useThreads() {
    return useQuery({
        queryKey: queryKeys.threads.lists(),
        queryFn: async (): Promise<Thread[]> => {
            const res = await fetch('/api/threads');
            if (!res.ok) throw new Error('Failed to fetch threads');
            return res.json();
        },
    });
}

export function useDeleteThread() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (id: string) => {
            const res = await fetch(`/api/threads/${id}`, { method: 'DELETE' });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error ?? 'Failed to delete thread');
            }
            return res.json().catch(() => ({}));
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.threads.all }),
    });
}

export function useRenameThread() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async ({ id, title }: { id: string; title: string }) => {
            const res = await fetch(`/api/threads/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error ?? 'Failed to rename thread');
            }
            return res.json().catch(() => ({}));
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.threads.all }),
    });
}
