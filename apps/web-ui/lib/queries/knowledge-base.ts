'use client';

/**
 * TanStack Query hooks for knowledge bases (list + create + delete).
 * Fetches inlined; mutations invalidate the list.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { KnowledgeBase } from '@/lib/knowledge-base/types';

const knowledgeBasesKey = ['knowledge-bases'] as const;

export function useKnowledgeBases() {
    return useQuery({
        queryKey: knowledgeBasesKey,
        queryFn: async (): Promise<KnowledgeBase[]> => {
            const res = await fetch('/api/knowledge-base');
            if (!res.ok) throw new Error('Failed to fetch knowledge bases');
            const data = await res.json();
            return data.knowledgeBases ?? [];
        },
    });
}

export function useCreateKnowledgeBase() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (body: { name: string; description?: string }) => {
            const res = await fetch('/api/knowledge-base', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error ?? 'Failed to create knowledge base');
            }
            return res.json().catch(() => ({}));
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: knowledgeBasesKey }),
    });
}

export function useDeleteKnowledgeBase() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (id: string) => {
            const res = await fetch(`/api/knowledge-base/${id}`, { method: 'DELETE' });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error ?? 'Delete failed');
            }
            return res.json().catch(() => ({}));
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: knowledgeBasesKey }),
    });
}
