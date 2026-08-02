'use client';

/**
 * TanStack Query hook for persisted sub-agent runs.
 *
 * Stream data parts are not persisted — chat history is rebuilt from the LangGraph
 * checkpointer — so live expansion works from client state but a reload loses it.
 * A collapsed card fetches its transcript from `agent_subagent_runs` on demand.
 *
 * Keyed per thread, not per sub-agent: one response carries every sub-agent in the
 * thread, so expanding a second card is served from cache.
 */
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queries/query-keys';

export interface PersistedSubagentTranscriptEntry {
    kind: 'ai' | 'tool';
    name?: string;
    text: string;
}

export interface PersistedSubagentRun {
    subagentId: string;
    role: string;
    task: string;
    status: string;
    toolCount: number;
    tokensIn: number;
    tokensOut: number;
    summary?: string | null;
    transcript?: PersistedSubagentTranscriptEntry[] | null;
}

/**
 * @param threadId  thread whose sub-agent runs to load; the query stays idle without one
 * @param enabled   pass the card's expanded state — keeps the default render free of
 *                  network work
 */
export function useSubagentRuns(threadId: string | undefined, enabled: boolean) {
    return useQuery({
        queryKey: queryKeys.subagents.byThread(threadId ?? 'none'),
        enabled: enabled && !!threadId,
        queryFn: async (): Promise<PersistedSubagentRun[]> => {
            const res = await fetch(`/api/chat/subagents/${encodeURIComponent(threadId!)}`);
            const json = await res.json().catch(() => ({}));
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Failed to load sub-agent transcript');
            }
            return json.data as PersistedSubagentRun[];
        },
    });
}
