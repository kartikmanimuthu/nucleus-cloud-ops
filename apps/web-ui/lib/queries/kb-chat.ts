'use client';

/**
 * TanStack Query hooks for Knowledge Base "Ask AI" chat sessions.
 * Sessions + message history are tenant-shared and persisted server-side.
 * The streaming send itself stays a manual fetch in the component; after it
 * completes the component invalidates queryKeys.kbChat.sessions().
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queries/query-keys';
import type { KBSource } from '@/components/knowledge-base/kb-chat-sources';

export interface KbChatSession {
    id: string;
    title: string;
    knowledgeBaseId: string | null;
    createdAt: number;
    updatedAt: number;
    ownerUserId: string;
}

export interface KbChatAttachment {
    name: string;
    url: string;
}

export interface KbChatHistoryMessage {
    role: 'user' | 'assistant';
    content: string;
    sources?: KBSource[];
    attachments?: KbChatAttachment[];
    createdAt?: number;
}

export interface KbChatHistory {
    messages: KbChatHistoryMessage[];
    knowledgeBaseId: string | null;
    title: string;
}

export function useKBChatSessions() {
    return useQuery({
        queryKey: queryKeys.kbChat.sessions(),
        queryFn: async (): Promise<KbChatSession[]> => {
            const res = await fetch('/api/knowledge-base/sessions');
            if (!res.ok) throw new Error('Failed to fetch sessions');
            const data = await res.json();
            return data.data ?? [];
        },
    });
}

export function useKBChatMessages(sessionId: string | null) {
    return useQuery({
        queryKey: queryKeys.kbChat.messages(sessionId ?? 'new'),
        enabled: !!sessionId,
        queryFn: async (): Promise<KbChatHistory> => {
            const res = await fetch(
                `/api/knowledge-base/sessions/${encodeURIComponent(sessionId!)}/history`,
            );
            if (!res.ok) throw new Error('Failed to load history');
            const data = await res.json();
            return data.data as KbChatHistory;
        },
    });
}

export function useDeleteKBChatSession() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (sessionId: string) => {
            const res = await fetch(
                `/api/knowledge-base/sessions/${encodeURIComponent(sessionId)}`,
                { method: 'DELETE' },
            );
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error ?? 'Delete failed');
            }
            return res.json().catch(() => ({}));
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.kbChat.sessions() }),
    });
}
